// `jtaak run`: runs an export file's requests with their scripts, in order,
// reports them in the terminal (and as JUnit XML for CI), and exits non-zero
// when anything failed. The same engine calls a host application makes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import {
  CookieJar,
  DEFAULT_ENGINE_PROFILE,
  emptyScopes,
  junitReport,
  proxyFromEnvironment,
  runCollection,
  runnableRequestsFromExport,
  validateNativeExport,
  type EngineProfile,
  type ExportedRequest,
  type NativeExportDocument,
  type NetworkSettings,
} from '@jtaak/engine';
import { createReporter } from './report.js';

/** `run`'s help text, for the command name and the profile whose format and namespace are the defaults. */
export function runUsage(command = 'jtaak', profile: EngineProfile = DEFAULT_ENGINE_PROFILE): string {
  return `Usage: ${command} run <export file> [options]

Runs the file's requests with their scripts and tests, in order.

Options:
  -e, --env <name>         use one of the file's environments
      --env-file <file>    variables from a JSON file: { "name": "value" }, or an
                           exported environment (native or Postman)
      --var <name=value>   set a variable (repeatable; wins over the environment)
      --secret <name>      a variable whose value is never printed: shown as •••
                           in the output and the JUnit XML (repeatable)
      --folder <name>      only this collection or folder (a name, or "Collection/Folder")
      --junit <file>       also write the results as JUnit XML, for CI
      --bail               stop after the first request that fails
  -k, --insecure           don't check servers' TLS certificates (for testing only)
      --proxy <url>        send through this HTTP(S) proxy (default: $HTTPS_PROXY or
                           $HTTP_PROXY); user:password@ in it is the proxy's login
      --noproxy <hosts>    comma-separated hosts reached directly (default: $NO_PROXY)
      --cacert <file>      also trust this certificate authority (PEM; repeatable)
      --cert <file>        client certificate for servers that ask for one: PEM, or
                           a .pfx/.p12 file holding the key too
      --key <file>         the client certificate's PEM key
      --pass <phrase>      the key's or PFX's passphrase
      --format <id>        the file's format id, for an export from another app
                           built on jtaak (default ${profile.exportFormat})
      --namespace <name>   the scripts' namespace, for such a file (default ${profile.scriptNamespace})
  -h, --help               show this

Exit code: 0 when every request was sent and every test passed, 1 when one
wasn't, 2 when the run couldn't start (a bad option or file).`;
}

/** A problem with the command line or its files: exit code 2, before anything runs. */
/** A problem with the arguments or the files they name: said, and the command exits 2. */
export class UsageError extends Error {}

async function readJson(file: string, what: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new UsageError(`Can't read the ${what} ${file}: ${(error as NodeJS.ErrnoException).code ?? error}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(`The ${what} ${file} isn't JSON.`);
  }
}

/** Variables from an --env-file: a flat object, an exported environment, or a Postman environment. */
export function variablesFromJson(json: unknown, file: string): Record<string, string> {
  const fail = () => new UsageError(`${file} isn't a variables file: expected { "name": "value" } or an environment.`);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw fail();
  const object = json as Record<string, unknown>;
  if (Array.isArray(object.values)) {
    // Postman: { values: [{ key, value, enabled }] }
    return Object.fromEntries(
      (object.values as Array<{ key?: unknown; value?: unknown; enabled?: unknown }>)
        .filter((entry) => typeof entry.key === 'string' && entry.enabled !== false)
        .map((entry) => [entry.key as string, String(entry.value ?? '')]),
    );
  }
  const variables = typeof object.variables === 'object' && object.variables !== null ? object.variables : object;
  const entries = Object.entries(variables as Record<string, unknown>);
  if (entries.some(([, value]) => typeof value === 'object' && value !== null)) throw fail();
  return Object.fromEntries(entries.map(([key, value]) => [key, String(value ?? '')]));
}

/** The proxy (from --proxy, else the environment) and certificates for every request, if any. */
export function networkSettings(
  values: { proxy?: string; noproxy?: string; cacert?: string[]; cert?: string; key?: string; pass?: string },
  env: Record<string, string | undefined> = process.env,
): NetworkSettings | undefined {
  const fromEnv = proxyFromEnvironment(env);
  const proxy = values.proxy
    ? proxyFromEnvironment({ HTTPS_PROXY: values.proxy, NO_PROXY: values.noproxy ?? env.NO_PROXY ?? env.no_proxy })
    : fromEnv && values.noproxy !== undefined
      ? {
          ...fromEnv,
          noProxy: values.noproxy
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean),
        }
      : fromEnv;
  if (values.key && !values.cert) throw new UsageError('--key needs --cert.');
  const certificate = values.cert && {
    host: '*',
    ...(/\.(pfx|p12)$/i.test(values.cert)
      ? { pfxPath: path.resolve(values.cert) }
      : { certPath: path.resolve(values.cert), ...(values.key && { keyPath: path.resolve(values.key) }) }),
    ...(values.pass && { passphrase: values.pass }),
  };
  const network: NetworkSettings = {
    ...(proxy && { proxy }),
    ...(certificate && { clientCertificates: [certificate] }),
    ...(values.cacert?.length && { caPaths: values.cacert.map((file) => path.resolve(file)) }),
  };
  return Object.keys(network).length > 0 ? network : undefined;
}

export interface RunOptions {
  /** The command name, for the help text and messages. Default `jtaak`. */
  command?: string;
  /** The base profile; --format and --namespace override its exportFormat and scriptNamespace. */
  profile?: EngineProfile;
  /**
   * Variables whose values are never printed, besides those named with --secret: their values (of 4 or more
   * characters) are shown as ••• in the output and the JUnit XML.
   */
  secretVariables?: (name: string) => boolean;
  /** Properties the JUnit XML carries (who it's licensed to, the build), besides its own. */
  junitProperties?: Record<string, string>;
}

/** What's printed in place of a secret's value. */
export const HIDDEN = '•••';

const xmlEscaped = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
  );

/** A function that shows each secret (of 4 or more characters) as •••, as written and as XML escapes it. */
export function hider(secrets: readonly string[]): (text: string) => string {
  const values = [...new Set(secrets.filter((value) => value.length >= 4).flatMap((v) => [v, xmlEscaped(v)]))].sort(
    (a, b) => b.length - a.length,
  );
  return (text) => values.reduce((out, value) => out.split(value).join(HIDDEN), text);
}

/** The options `run` reads, for parseArgs; a host adds its own (prepareRun's `extraOptions`). */
export const RUN_OPTIONS = {
  env: { type: 'string', short: 'e' },
  'env-file': { type: 'string' },
  var: { type: 'string', multiple: true },
  secret: { type: 'string', multiple: true },
  folder: { type: 'string' },
  junit: { type: 'string' },
  bail: { type: 'boolean' },
  insecure: { type: 'boolean', short: 'k' },
  proxy: { type: 'string' },
  noproxy: { type: 'string' },
  cacert: { type: 'string', multiple: true },
  cert: { type: 'string' },
  key: { type: 'string' },
  pass: { type: 'string' },
  format: { type: 'string' },
  namespace: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

export interface PrepareRunOptions extends RunOptions {
  /** More options to read (a host's own); their values come back in `values`. */
  extraOptions?: ParseArgsConfig['options'];
}

/** A run, read from its arguments and ready to go: what `run` does before it runs, for a host's own runner. */
export interface PreparedRun {
  /** Every option's value, the host's own too. */
  values: Record<string, string | boolean | string[] | undefined>;
  file: string;
  doc: NativeExportDocument;
  profile: EngineProfile;
  /** The environment the run starts with: the chosen one, then --env-file, then --var. */
  environment: Record<string, string>;
  environmentName?: string;
  /** The requests it can send (with --insecure and the network options applied), and those it can't. */
  requests: ExportedRequest[];
  skipped: ExportedRequest[];
  network?: NetworkSettings;
  /** The run's name: the folder, else the first API collection's, else the file's. */
  name: string;
  /** Shows the secrets' values as ••• (--secret's, and the host's secretVariables). */
  hide: (text: string) => string;
}

/** Reads a run's arguments and its export file; a UsageError says what's wrong. `--help` isn't handled here. */
export async function prepareRun(argv: string[], options: PrepareRunOptions = {}): Promise<PreparedRun> {
  const command = options.command ?? 'jtaak';
  const baseProfile = options.profile ?? DEFAULT_ENGINE_PROFILE;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { ...RUN_OPTIONS, ...options.extraOptions },
    });
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\n\n${runUsage(command, baseProfile)}`);
  }
  const values = parsed.values as PreparedRun['values'] & {
    env?: string;
    'env-file'?: string;
    var?: string[];
    secret?: string[];
    folder?: string;
    insecure?: boolean;
    format?: string;
    namespace?: string;
    proxy?: string;
    noproxy?: string;
    cacert?: string[];
    cert?: string;
    key?: string;
    pass?: string;
  };
  if (parsed.positionals.length !== 1) throw new UsageError(runUsage(command, baseProfile));
  const [file] = parsed.positionals as [string];

  const profile: EngineProfile = {
    ...baseProfile,
    ...(values.format && { exportFormat: values.format }),
    ...(values.namespace && { scriptNamespace: values.namespace }),
  };
  const json = await readJson(file, 'export file');
  let doc: NativeExportDocument;
  try {
    doc = validateNativeExport(json, profile);
  } catch (error) {
    const format = (json as { format?: unknown } | null)?.format;
    const hint =
      typeof format === 'string' && format !== profile.exportFormat
        ? ` Its format is "${format}": to run it, add --format ${format} (and --namespace for its scripts).`
        : '';
    const reason = (error as Error).message.replace(/\.$/, '');
    throw new UsageError(`${file} isn't an export ${command} can run: ${reason}.${hint}`);
  }

  let environment: Record<string, string> = {};
  let environmentName: string | undefined;
  if (values.env !== undefined) {
    const found = doc.environments.find((env) => env.name === values.env);
    if (!found) {
      const names = doc.environments.map((env) => `"${env.name}"`).join(', ');
      throw new UsageError(`No environment "${values.env}" in ${file}${names ? `; it has ${names}` : ''}.`);
    }
    environment = { ...found.variables };
    environmentName = found.name;
  }
  if (values['env-file']) {
    const envFile = values['env-file'];
    environment = { ...environment, ...variablesFromJson(await readJson(envFile, 'variables file'), envFile) };
    environmentName ??= path.basename(envFile);
  }
  for (const assignment of values.var ?? []) {
    const at = assignment.indexOf('=');
    if (at <= 0) throw new UsageError(`--var needs name=value, not "${assignment}".`);
    environment[assignment.slice(0, at)] = assignment.slice(at + 1);
  }

  let selection;
  try {
    selection = runnableRequestsFromExport(doc, { folder: values.folder });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { requests, skipped } = selection;
  const network = networkSettings(values);
  for (const request of requests) {
    if (values.insecure) request.config.verifyTls = false;
    if (network) request.config.network = network;
  }

  // The secrets' values, never printed: --secret's names, and the host application's (secretVariables).
  const hide = hider(
    Object.entries(environment)
      .filter(([name]) => values.secret?.includes(name) || options.secretVariables?.(name))
      .map(([, value]) => value),
  );
  return {
    values,
    file,
    doc,
    profile,
    environment,
    ...(environmentName !== undefined && { environmentName }),
    requests,
    skipped,
    ...(network && { network }),
    name: values.folder ?? doc.collections.find((c) => c.category === 'api')?.name ?? file,
    hide,
  };
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const command = options.command ?? 'jtaak';
  const usage = () => runUsage(command, options.profile ?? DEFAULT_ENGINE_PROFILE);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  try {
    const prepared = await prepareRun(argv, options);
    const { requests, skipped, hide, values } = prepared;
    const out = { write: (text: string) => process.stdout.write(hide(text)), isTTY: process.stdout.isTTY };
    const reporter = createReporter(out, command);
    reporter.start({
      file: prepared.file,
      folder: values.folder as string | undefined,
      environment: prepared.environmentName,
      count: requests.length,
      skipped,
    });
    const startedAt = new Date();
    const report = await runCollection(
      requests,
      { ...emptyScopes(), environment: prepared.environment },
      (item) =>
        reporter.item(
          item,
          requests.find((r) => r.id === item.requestId)!,
        ),
      prepared.profile,
      { cookieJar: new CookieJar(), stopOnFailure: values.bail === true },
    );
    reporter.finish(report);

    if (typeof values.junit === 'string') {
      const xml = junitReport(report, {
        name: prepared.name,
        paths: Object.fromEntries(requests.map((r) => [r.id, r.path])),
        timestamp: startedAt,
        ...(options.junitProperties && { properties: options.junitProperties }),
      });
      await fs.writeFile(values.junit, hide(xml), 'utf8');
    }
    return report.failedAssertions > 0 || report.requestsFailedToSend > 0 ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
