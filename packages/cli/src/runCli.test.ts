// runCli in process, as an application built on jtaak calls it from its own
// bin: under its own command name and profile.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '@jtaak/engine';
import { runCli, usage } from './cli.js';
import { runUsage } from './run.js';

const PROFILE: EngineProfile = {
  productName: 'Other',
  scriptNamespace: 'ot',
  exportFormat: 'other-export',
  exportExtension: '.ot',
  mcpClientName: 'other',
};

let baseUrl = '';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: req.url }));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Runs runCli with its console and stdout output captured. */
async function capture(argv: string[], options?: Parameters<typeof runCli>[1]) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ') + '\n'));
  vi.spyOn(console, 'error').mockImplementation((...args) => void err.push(args.join(' ') + '\n'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
  const code = await runCli(argv, options);
  vi.restoreAllMocks();
  return { code, stdout: out.join(''), stderr: err.join('') };
}
afterEach(() => vi.restoreAllMocks());

describe('runCli', () => {
  it("keeps jt's usage text for the default command and profile", () => {
    expect(usage()).toMatch(/^Usage: jt \[-k\|--insecure\] <METHOD> <URL>\n {2}e\.g\. jt GET /);
    expect(usage()).toContain('jt run <export file> [options]   run a collection with its tests (jt run --help)');
    expect(runUsage()).toMatch(/^Usage: jt run <export file> \[options\]/);
    expect(runUsage()).toContain(`(default ${DEFAULT_ENGINE_PROFILE.exportFormat})`);
    expect(runUsage()).toContain(`(default ${DEFAULT_ENGINE_PROFILE.scriptNamespace})`);
  });

  it('shows the host command name in its usage text', async () => {
    const help = await capture(['--help'], { command: 'other' });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: other [-k|--insecure] <METHOD> <URL>');
    expect(help.stdout).toContain('other run <export file> [options]');
    expect(help.stdout).not.toMatch(/\bjt\b/);

    const none = await capture([], { command: 'other' });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('Usage: other [-k|--insecure]');
  });

  it("shows the host command and its profile's defaults in run's help", async () => {
    const { code, stdout } = await capture(['run', '--help'], { command: 'other', profile: PROFILE });
    expect(code).toBe(0);
    expect(stdout).toContain('Usage: other run <export file> [options]');
    expect(stdout).toContain('(default other-export)');
    expect(stdout).toContain('(default ot)');
  });

  it("runs a file in the profile's format and namespace without --format", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jt-host-'));
    const file = path.join(dir, 'api.ot');
    fs.writeFileSync(
      file,
      JSON.stringify({
        format: 'other-export',
        version: 1,
        scope: 'workspace',
        exportedAt: '2026-09-30T00:00:00.000Z',
        secretsStripped: false,
        environments: [],
        collections: [
          {
            name: 'Api',
            category: 'api',
            folders: [],
            items: [
              {
                type: 'request',
                name: 'Hello',
                config: {
                  method: 'GET',
                  url: `${baseUrl}/hello`,
                  params: [],
                  headers: [],
                  body: { mode: 'none' },
                  auth: { type: 'none' },
                  testScript: 'ot.test("path", () => ot.expect(ot.response.json().path).toBe("/hello"));',
                },
              },
            ],
          },
        ],
      }),
    );
    const { code, stdout } = await capture(['run', file], { command: 'other', profile: PROFILE });
    expect(stdout).toContain(`other run ${file}: 1 request`);
    expect(stdout).toContain('✓ path');
    expect(code).toBe(0);

    // The default profile doesn't read it, and says how to.
    const plain = await capture(['run', file]);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain("isn't an export jt can run");
    expect(plain.stderr).toContain('add --format other-export');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
