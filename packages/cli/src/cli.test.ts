// Runs the CLI as a user would (a child process running src/index.ts via
// tsx) against a local HTTP server, and checks its output and exit code.
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));

let baseUrl = '';
const seen: { method?: string; url?: string }[] = [];
const server = http.createServer((req, res) => {
  seen.push({ method: req.method, url: req.url });
  res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: req.url !== '/missing', path: req.url }));
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function runCli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [TSX_CLI, ENTRY, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('jt CLI', () => {
  it('sends a GET and prints the status line and body', async () => {
    const { code, stdout } = await runCli('GET', `${baseUrl}/users`);
    expect(code).toBe(0);
    const [statusLine, body] = stdout.trim().split('\n');
    expect(statusLine).toMatch(/^200 OK — \d+ms, \d+B$/);
    expect(JSON.parse(body!)).toEqual({ ok: true, path: '/users' });
  });

  it('defaults to GET when only a URL is given', async () => {
    const { code } = await runCli(`${baseUrl}/default`);
    expect(code).toBe(0);
    expect(seen.at(-1)).toEqual({ method: 'GET', url: '/default' });
  });

  it('accepts the method in any case', async () => {
    const { code } = await runCli('post', `${baseUrl}/things`);
    expect(code).toBe(0);
    expect(seen.at(-1)).toEqual({ method: 'POST', url: '/things' });
  });

  it('prints error statuses and still exits 0', async () => {
    const { code, stdout } = await runCli('GET', `${baseUrl}/missing`);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^404 Not Found/);
  });

  it('prints usage and exits 1 without arguments', async () => {
    const { code, stderr } = await runCli();
    expect(code).toBe(1);
    expect(stderr).toContain('Usage: jt <METHOD> <URL>');
  });

  it('exits 1 when the server is unreachable', async () => {
    const { code, stderr } = await runCli('GET', 'http://127.0.0.1:1/nothing');
    expect(code).toBe(1);
    expect(stderr).not.toBe('');
  });
});
