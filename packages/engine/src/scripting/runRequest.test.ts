import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runRequestWithScripts } from './runRequest';
import { emptyScopes } from '../types';
import type { RequestConfig, VariableScope } from '../types';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'test request',
    method: 'GET',
    url: baseUrl,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('runRequestWithScripts', () => {
  it('sends the request and returns no test results when no scripts are set', async () => {
    const result = await runRequestWithScripts(baseConfig(), emptyScopes());
    expect(result.response?.status).toBe(200);
    expect(result.testResults).toEqual([]);
    expect(result.preRequestError).toBeUndefined();
  });

  it('runs the test script against the real response', async () => {
    const result = await runRequestWithScripts(
      baseConfig({ testScript: 'jt.test("status is 200", () => jt.expect(jt.response.status).toBe(200));' }),
      emptyScopes(),
    );
    expect(result.testResults).toEqual([{ name: 'status is 200', passed: true }]);
  });

  it('lets a pre-request script set a variable this same request resolves against', async () => {
    const scopes: VariableScope = { ...emptyScopes(), environment: {} };
    const result = await runRequestWithScripts(
      baseConfig({
        url: `${baseUrl}/{{segment}}`,
        preRequestScript: 'jt.variables.segment = "users";',
      }),
      scopes,
    );
    expect(JSON.parse(result.response!.body).path).toBe('/users');
  });

  it('returns what scripts set in the environment, and not what they set in variables', async () => {
    const scopes: VariableScope = { ...emptyScopes(), environment: { keep: 'k', stale: 's' } };
    const result = await runRequestWithScripts(
      baseConfig({
        url: `${baseUrl}/{{segment}}`,
        preRequestScript: 'jt.environment.segment = "orders"; jt.variables.scratch = "x"; delete jt.environment.stale;',
        // A test script can keep something from the response, e.g. a token.
        testScript: 'jt.environment.lastPath = jt.response.json().path;',
      }),
      scopes,
    );
    // The environment write reached this request's URL.
    expect(JSON.parse(result.response!.body).path).toBe('/orders');
    expect(result.environmentUpdates).toEqual({ segment: 'orders', lastPath: '/orders', stale: null });
    // The caller's scopes aren't changed: saving is its choice.
    expect(scopes.environment).toEqual({ keep: 'k', stale: 's' });
  });

  it('returns no environment updates when scripts change nothing there', async () => {
    const result = await runRequestWithScripts(
      baseConfig({ preRequestScript: 'jt.variables.scratch = "x";', testScript: 'jt.environment.keep = "k";' }),
      { ...emptyScopes(), environment: { keep: 'k' } },
    );
    expect(result.environmentUpdates).toBeUndefined();
  });

  it('resolves against existing environment variables without needing a pre-request script', async () => {
    const scopes: VariableScope = { ...emptyScopes(), environment: { segment: 'orders' } };
    const result = await runRequestWithScripts(baseConfig({ url: `${baseUrl}/{{segment}}` }), scopes);
    expect(JSON.parse(result.response!.body).path).toBe('/orders');
  });

  it('tags captured console output from each script with its phase', async () => {
    const result = await runRequestWithScripts(
      baseConfig({
        preRequestScript: 'console.log("preparing request");',
        testScript: 'console.log("checking response");',
      }),
      emptyScopes(),
    );
    expect(result.scriptLogs).toEqual([
      { phase: 'pre-request', level: 'log', message: 'preparing request' },
      { phase: 'test', level: 'log', message: 'checking response' },
    ]);
  });

  it('reports a pre-request script error and never sends the request', async () => {
    const result = await runRequestWithScripts(
      baseConfig({ preRequestScript: 'throw new Error("boom");' }),
      emptyScopes(),
    );
    expect(result.preRequestError).toContain('boom');
    expect(result.response).toBeUndefined();
  });

  it('reports a send error (e.g. invalid URL) without throwing', async () => {
    const result = await runRequestWithScripts(baseConfig({ url: 'not-a-valid-url' }), emptyScopes());
    expect(result.sendError).toBeDefined();
    expect(result.response).toBeUndefined();
  });
});
