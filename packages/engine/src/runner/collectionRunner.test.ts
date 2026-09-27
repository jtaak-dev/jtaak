import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runCollection, type RunnableRequest } from './collectionRunner';
import { emptyScopes } from '../types';
import type { CollectionRunItemResult, RequestConfig } from '../types';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/fail') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());

function config(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req',
    name: 'req',
    method: 'GET',
    url: baseUrl,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('runCollection', () => {
  it('runs requests sequentially and aggregates assertion pass/fail counts', async () => {
    const requests: RunnableRequest[] = [
      {
        id: '1',
        name: 'passes',
        config: config({ testScript: 'jt.test("ok", () => jt.expect(jt.response.status).toBe(200));' }),
      },
      {
        id: '2',
        name: 'fails',
        config: config({
          url: `${baseUrl}/fail`,
          testScript: 'jt.test("ok", () => jt.expect(jt.response.status).toBe(200));',
        }),
      },
    ];

    const report = await runCollection(requests, emptyScopes());

    expect(report.total).toBe(2);
    expect(report.passedAssertions).toBe(1);
    expect(report.failedAssertions).toBe(1);
    expect(report.requestsFailedToSend).toBe(0);
    expect(report.items.map((i) => i.requestName)).toEqual(['passes', 'fails']);
  });

  it('counts requests that fail to send', async () => {
    const requests: RunnableRequest[] = [{ id: '1', name: 'broken', config: config({ url: 'not-a-url' }) }];
    const report = await runCollection(requests, emptyScopes());
    expect(report.requestsFailedToSend).toBe(1);
  });

  it('reports progress after each request', async () => {
    const requests: RunnableRequest[] = [
      { id: '1', name: 'a', config: config() },
      { id: '2', name: 'b', config: config() },
    ];
    const progress: number[] = [];
    const items: CollectionRunItemResult[] = [];
    await runCollection(requests, emptyScopes(), (item, index) => {
      progress.push(index);
      items.push(item);
    });
    expect(progress).toEqual([0, 1]);
    expect(items.map((i) => i.requestName)).toEqual(['a', 'b']);
  });
});

describe('environment changes in a run', () => {
  it('passes what one request sets in the environment to the requests after it', async () => {
    const requests: RunnableRequest[] = [
      {
        id: 'login',
        name: 'Log in',
        config: config({ testScript: 'jt.environment.token = "t-" + jt.response.json().ok;' }),
      },
      {
        id: 'use',
        name: 'Use the token',
        config: config({
          url: `${baseUrl}/{{token}}`,
          testScript: 'jt.test("sent the token", () => jt.expect(jt.request.url).toContain("/t-true"));',
        }),
      },
      {
        id: 'logout',
        name: 'Log out',
        config: config({ testScript: 'delete jt.environment.session; jt.variables.scratch = "x";' }),
      },
    ];
    const report = await runCollection(requests, { ...emptyScopes(), environment: { session: 's1' } });
    expect(report.items[1].result.testResults).toEqual([{ name: 'sent the token', passed: true }]);
    expect(report.environmentUpdates).toEqual({ token: 't-true', session: null });
  });

  it('reports no environment updates when nothing changed', async () => {
    const report = await runCollection([{ id: 'a', name: 'a', config: config() }], emptyScopes());
    expect(report.environmentUpdates).toBeUndefined();
  });
});

describe('performance budget: 500-request collection run', () => {
  it('completes in a reasonable time without blocking on any single step', async () => {
    const requests: RunnableRequest[] = Array.from({ length: 500 }, (_, i) => ({
      id: `req-${i}`,
      name: `Request ${i}`,
      config: config({ testScript: 'jt.test("ok", () => jt.expect(jt.response.status).toBe(200));' }),
    }));

    const report = await runCollection(requests, emptyScopes());

    expect(report.total).toBe(500);
    expect(report.passedAssertions).toBe(500);
    expect(report.requestsFailedToSend).toBe(0);
    // Generous bound (real network I/O to localhost + 500 script runs) —
    // this isn't a literal "UI doesn't freeze" test (that needs an end-to-end
    // harness in a host application), but it is a genuine throughput regression guard: if this
    // starts creeping toward the bound, something got slow.
    expect(report.durationMs).toBeLessThan(10_000);
  });
});
