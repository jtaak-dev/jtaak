// The CLI as a function: `runCli(argv)` does what the `jt` command does and
// returns its exit code. index.ts is the bin that calls it. An application
// built on the engine can ship the same CLI under its own command name and
// EngineProfile (export format, script namespace, product name) by calling
// runCli from its own bin: `import { runCli } from 'jtaak/cli'`.
// It's a thin wrapper around the same core engine any host application uses,
// so a request or a run from the terminal (or CI) does exactly what a GUI
// built on the engine does: one engine, one source of truth.
import {
  DEFAULT_ENGINE_PROFILE,
  executeRequest,
  proxyFromEnvironment,
  type EngineProfile,
  type RequestConfig,
} from '@jtaak/engine';
import { run } from './run.js';

export interface CliOptions {
  /** The command name shown in usage and messages. Default `jt`. */
  command?: string;
  /**
   * The names users see: `run` reads exports of its `exportFormat` and runs
   * their scripts under its `scriptNamespace` (`--format` and `--namespace`
   * override them). Default `DEFAULT_ENGINE_PROFILE`.
   */
  profile?: EngineProfile;
}

export function usage(command = 'jt'): string {
  return (
    `Usage: ${command} [-k|--insecure] <METHOD> <URL>\n  e.g. ${command} GET https://api.example.com/users\n` +
    "  -k, --insecure  don't check the server's TLS certificate (for testing only)\n" +
    '  Sent through the proxy in $HTTPS_PROXY or $HTTP_PROXY, if set (not to $NO_PROXY hosts).\n\n' +
    `       ${command} run <export file> [options]   run a collection with its tests (${command} run --help)`
  );
}

function parseArgs(argv: string[]): { method: RequestConfig['method']; url: string | undefined; insecure: boolean } {
  // -k/--insecure, as in curl: don't check the server's TLS certificate.
  const insecure = argv.some((arg) => arg === '-k' || arg === '--insecure');
  const [first, second] = argv.filter((arg) => arg !== '-k' && arg !== '--insecure');
  const url = second ?? first;
  const method = (second ? first : 'GET')?.toUpperCase() as RequestConfig['method'];
  return { method, url, insecure };
}

async function send(argv: string[], command: string): Promise<number> {
  const { method, url, insecure } = parseArgs(argv);
  if (!url) {
    console.error(usage(command));
    return 1;
  }

  const config: RequestConfig = {
    id: 'cli',
    name: 'cli request',
    method,
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...(insecure && { verifyTls: false }),
  };
  const proxy = proxyFromEnvironment();
  if (proxy) config.network = { proxy };

  const result = await executeRequest(config);
  console.log(
    `${result.status} ${result.statusText} — ${result.timings.durationMs.toFixed(0)}ms, ${result.sizeBytes}B`,
  );
  console.log(result.body);
  return 0;
}

/**
 * Runs the CLI on `argv` (the arguments after the command, as in
 * `process.argv.slice(2)`) and resolves to its exit code. It never exits the
 * process itself; an unexpected error is printed and gives 1.
 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const command = options.command ?? 'jt';
  const profile = options.profile ?? DEFAULT_ENGINE_PROFILE;
  try {
    if (argv[0] === 'run') return await run(argv.slice(1), { command, profile });
    if (argv[0] === '--help' || argv[0] === '-h') {
      console.log(usage(command));
      return 0;
    }
    return await send(argv, command);
  } catch (error) {
    console.error(error);
    return 1;
  }
}
