#!/usr/bin/env node
// A thin wrapper around the same core engine any host application uses, so
// a request or a run from the terminal (or CI) does exactly what a GUI built
// on the engine does: one engine, one source of truth.
import { executeRequest, proxyFromEnvironment, type RequestConfig } from '@jtaak/engine';
import { run } from './run.js';

const USAGE =
  'Usage: jt [-k|--insecure] <METHOD> <URL>\n  e.g. jt GET https://api.example.com/users\n' +
  "  -k, --insecure  don't check the server's TLS certificate (for testing only)\n" +
  '  Sent through the proxy in $HTTPS_PROXY or $HTTP_PROXY, if set (not to $NO_PROXY hosts).\n\n' +
  '       jt run <export file> [options]   run a collection with its tests (jt run --help)';

function parseArgs(argv: string[]): { method: RequestConfig['method']; url: string; insecure: boolean } {
  // -k/--insecure, as in curl: don't check the server's TLS certificate.
  const insecure = argv.some((arg) => arg === '-k' || arg === '--insecure');
  const [first, second] = argv.filter((arg) => arg !== '-k' && arg !== '--insecure');
  const url = second ?? first;
  const method = (second ? first : 'GET').toUpperCase() as RequestConfig['method'];

  if (!url) {
    console.error(USAGE);
    process.exit(1);
  }

  return { method, url, insecure };
}

async function send(argv: string[]): Promise<void> {
  const { method, url, insecure } = parseArgs(argv);

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
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'run') {
    process.exitCode = await run(argv.slice(1));
    return;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    return;
  }
  await send(argv);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
