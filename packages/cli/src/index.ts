#!/usr/bin/env node
// A thin wrapper around the same core engine any host application uses.
// This is what keeps a future CI runner (Newman-style) from drifting out
// of sync with what a GUI built on the engine does — one engine, one source of truth.
import { executeRequest, type RequestConfig } from '@jtaak/engine';

function parseArgs(argv: string[]): { method: RequestConfig['method']; url: string; insecure: boolean } {
  // -k/--insecure, as in curl: don't check the server's TLS certificate.
  const insecure = argv.some((arg) => arg === '-k' || arg === '--insecure');
  const [first, second] = argv.filter((arg) => arg !== '-k' && arg !== '--insecure');
  const url = second ?? first;
  const method = (second ? first : 'GET').toUpperCase() as RequestConfig['method'];

  if (!url) {
    console.error(
      'Usage: jt [-k|--insecure] <METHOD> <URL>\n  e.g. jt GET https://api.example.com/users\n' +
        "  -k, --insecure  don't check the server's TLS certificate (for testing only)",
    );
    process.exit(1);
  }

  return { method, url, insecure };
}

async function main(): Promise<void> {
  const { method, url, insecure } = parseArgs(process.argv.slice(2));

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

  const result = await executeRequest(config);
  console.log(
    `${result.status} ${result.statusText} — ${result.timings.durationMs.toFixed(0)}ms, ${result.sizeBytes}B`,
  );
  console.log(result.body);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
