// `jt run`, as a user runs it: a child process on an export file written for
// each test, against a local HTTP server.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NativeExportDocument, RequestConfig } from '@jtaak/engine';

const require = createRequire(import.meta.url);
const TSX_CLI = require.resolve('tsx/cli');
const ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));

let baseUrl = '';
const server = http.createServer((req, res) => {
  if (req.url === '/login') res.setHeader('set-cookie', 'session=s1; Path=/');
  res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null, key: req.headers['x-key'] ?? null }));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-run-'));

function request(name: string, url: string, testScript?: string, extra: Partial<RequestConfig> = {}) {
  return {
    type: 'request' as const,
    name,
    config: {
      method: 'GET' as const,
      url,
      params: [],
      headers: [],
      body: { mode: 'none' as const },
      auth: { type: 'none' as const },
      ...(testScript && { testScript }),
      ...extra,
    },
  };
}

const status200 = 'jt.test("status is 200", () => jt.expect(jt.response.status).toBe(200));';

function exportFile(overrides: Partial<NativeExportDocument> = {}, name = 'api.jt'): string {
  const doc: NativeExportDocument = {
    format: 'jtaak-export',
    version: 1,
    scope: 'workspace',
    exportedAt: '2026-09-28T00:00:00.000Z',
    secretsStripped: false,
    environments: [{ name: 'Local', variables: { base: baseUrl, key: 'from-env' } }],
    collections: [
      {
        name: 'Shop',
        category: 'api',
        items: [
          request('Log in', '{{base}}/login', status200),
          request(
            'Profile',
            '{{base}}/me',
            'jt.test("has the session", () => jt.expect(jt.response.json().cookie).toBe("session=s1"));',
            { headers: [{ key: 'X-Key', value: '{{key}}', enabled: true }] },
          ),
        ],
        folders: [{ name: 'Admin', items: [request('Missing', '{{base}}/missing', status200)], folders: [] }],
      },
    ],
    ...overrides,
  };
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

function jt(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [TSX_CLI, ENTRY, ...args], (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('jt run', () => {
  it('runs every request with its tests, keeps cookies, and exits 1 when a test fails', async () => {
    const { code, stdout } = await jt('run', exportFile(), '--env', 'Local');
    expect(code).toBe(1);
    expect(stdout).toContain('jt run');
    expect(stdout).toContain('environment "Local": 3 requests');
    expect(stdout).toMatch(/Shop\n {2}✓ Log in GET \{\{base\}\}\/login → 200 OK, \d+ ms\n {6}✓ status is 200/);
    expect(stdout).toContain('✓ has the session');
    expect(stdout).toMatch(/Shop \/ Admin\n {2}✗ Missing .* → 404 Not Found/);
    expect(stdout).toContain('✗ status is 200: expected 404 to be 200');
    expect(stdout).toMatch(/3 requests, 3 tests \(1 failed\), \d+\.\d s\n$/);
  });

  it('runs only a folder with --folder, and writes JUnit XML with --junit', async () => {
    const junit = path.join(dir, 'report.xml');
    const { code, stdout } = await jt('run', exportFile(), '-e', 'Local', '--folder', 'Shop/Admin', '--junit', junit);
    expect(code).toBe(1);
    expect(stdout).toContain('"Shop/Admin" in');
    expect(stdout).not.toContain('Log in');
    const xml = fs.readFileSync(junit, 'utf8');
    expect(xml).toContain('<testsuites name="Shop/Admin" tests="1" failures="1" errors="0"');
    expect(xml).toContain('<testsuite name="Shop / Admin / Missing"');
    expect(xml).toContain('<failure message="expected 404 to be 200"');
  });

  it('takes variables from --env-file and --var, --var winning', async () => {
    const envFile = path.join(dir, 'postman.json');
    fs.writeFileSync(
      envFile,
      JSON.stringify({
        name: 'CI',
        values: [
          { key: 'base', value: baseUrl, enabled: true },
          { key: 'key', value: 'from-file' },
        ],
      }),
    );
    const file = exportFile({
      collections: [
        {
          name: 'One',
          category: 'api',
          folders: [],
          items: [
            request(
              'Key',
              '{{base}}/key',
              'jt.test("key", () => jt.expect(jt.response.json().key).toBe("from-var"));',
              {
                headers: [{ key: 'X-Key', value: '{{key}}', enabled: true }],
              },
            ),
          ],
        },
      ],
    });
    const passing = await jt('run', file, '--env-file', envFile, '--var', 'key=from-var');
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain('environment "postman.json"');
    const { code, stdout } = await jt('run', file, '--env-file', envFile);
    expect(code).toBe(1);
    expect(stdout).toContain('expected "from-file" to be "from-var"');
  });

  it('stops at the first failure with --bail', async () => {
    const file = exportFile({
      collections: [
        {
          name: 'One',
          category: 'api',
          folders: [],
          items: [request('Missing', '{{base}}/missing', status200), request('Never', '{{base}}/never')],
        },
      ],
    });
    const { code, stdout } = await jt('run', file, '-e', 'Local', '--bail');
    expect(code).toBe(1);
    expect(stdout).not.toContain('Never');
    expect(stdout).toContain('Stopped after the first failure (--bail): 1 request not run.');
  });

  it('reports a request that could not be sent, and skips streaming ones', async () => {
    const file = exportFile({
      collections: [
        {
          name: 'One',
          category: 'api',
          folders: [],
          items: [
            request('Down', 'http://127.0.0.1:1/'),
            request('Events', '{{base}}/events', undefined, { protocol: 'sse' }),
          ],
        },
      ],
    });
    const { code, stdout } = await jt('run', file, '-e', 'Local');
    expect(code).toBe(1);
    expect(stdout).toContain("Skipping 1 request jt run can't send: Events (SSE)");
    expect(stdout).toMatch(/✗ Down GET http:\/\/127\.0\.0\.1:1\/\n {6}fetch failed/);
    expect(stdout).toContain('1 request (1 failed to send), 0 tests');
  });

  it('exits 2 for a missing file, an unknown environment or folder, or a bad option', async () => {
    const file = exportFile();
    const missing = await jt('run', path.join(dir, 'nope.jt'));
    expect([missing.code, missing.stderr]).toEqual([2, expect.stringContaining("Can't read the export file")]);
    const env = await jt('run', file, '--env', 'Prod');
    expect([env.code, env.stderr]).toEqual([2, expect.stringContaining('No environment "Prod" in') as string]);
    expect(env.stderr).toContain('it has "Local"');
    const folder = await jt('run', file, '--folder', 'Nope');
    expect([folder.code, folder.stderr]).toEqual([2, expect.stringContaining('No collection or folder named "Nope"')]);
    expect((await jt('run', file, '--nope')).code).toBe(2);
    expect((await jt('run')).code).toBe(2);
  });

  it('says how to run an export from another app built on jtaak', async () => {
    const file = exportFile({ format: 'other-export' }, 'other.json');
    const { code, stderr } = await jt('run', file, '-e', 'Local');
    expect(code).toBe(2);
    expect(stderr).toContain('add --format other-export');
    const withFormat = await jt('run', file, '-e', 'Local', '--format', 'other-export', '--folder', 'Admin');
    expect(withFormat.stdout).toContain('Missing');
  });

  it('prints its usage with --help', async () => {
    const { code, stdout } = await jt('run', '--help');
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: jt run <export file> [options]');
  });
});
