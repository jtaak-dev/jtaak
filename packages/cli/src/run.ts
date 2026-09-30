// `jt run`: runs an export file's requests with their scripts, in order,
// reports them in the terminal (and as JUnit XML for CI), and exits non-zero
// when anything failed. The same engine calls a host application makes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
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
  type NativeExportDocument,
  type NetworkSettings,
} from '@jtaak/engine';
import { createReporter } from './report.js';

/** `run`'s help text, for the command name and the profile whose format and namespace are the defaults. */
export function runUsage(command = 'jt', profile: EngineProfile = DEFAULT_ENGINE_PROFILE): string {
  return `Usage: ${command} run <export file> [options]

Runs the file's requests with their scripts and tests, in order.

Options:
  -e, --env <name>         use one of the file's environments
      --env-file <file>    variables from a JSON file: { "name": "value" }, or an
                           exported environment (native or Postman)
      --var <name=value>   set a variable (repeatable; wins over the environment)
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
class UsageError extends Error {}

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
  /** The command name, for the help text and messages. Default `jt`. */
  command?: string;
  /** The base profile; --format and --namespace override its exportFormat and scriptNamespace. */
  profile?: EngineProfile;
}

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const command = options.command ?? 'jt';
  const baseProfile = options.profile ?? DEFAULT_ENGINE_PROFILE;
  const usage = () => runUsage(command, baseProfile);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        env: { type: 'string', short: 'e' },
        'env-file': { type: 'string' },
        var: { type: 'string', multiple: true },
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
      },
    });
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${usage()}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (positionals.length !== 1) {
    console.error(usage());
    return 2;
  }
  const [file] = positionals;

  try {
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

    const reporter = createReporter(process.stdout, command);
    reporter.start({ file, folder: values.folder, environment: environmentName, count: requests.length, skipped });
    const startedAt = new Date();
    const report = await runCollection(
      requests,
      { ...emptyScopes(), environment },
      (item) =>
        reporter.item(
          item,
          requests.find((r) => r.id === item.requestId)!,
        ),
      profile,
      { cookieJar: new CookieJar(), stopOnFailure: values.bail },
    );
    reporter.finish(report);

    if (values.junit) {
      const xml = junitReport(report, {
        name: values.folder ?? doc.collections.find((c) => c.category === 'api')?.name ?? file,
        paths: Object.fromEntries(requests.map((r) => [r.id, r.path])),
        timestamp: startedAt,
      });
      await fs.writeFile(values.junit, xml, 'utf8');
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
