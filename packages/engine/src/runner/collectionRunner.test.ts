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

  it('stops after the first failure with stopOnFailure, and says so', async () => {
    const test = 'jt.test("ok", () => jt.expect(jt.response.status).toBe(200));';
    const requests: RunnableRequest[] = [
      { id: '1', name: 'a', config: config({ testScript: test }) },
      { id: '2', name: 'b', config: config({ url: `${baseUrl}/fail`, testScript: test }) },
      { id: '3', name: 'c', config: config() },
    ];
    const stopped = await runCollection(requests, emptyScopes(), undefined, undefined, { stopOnFailure: true });
    expect(stopped.items.map((i) => i.requestName)).toEqual(['a', 'b']);
    expect(stopped.stoppedEarly).toBe(true);
    const full = await runCollection(requests, emptyScopes());
    expect(full.items).toHaveLength(3);
    expect(full.stoppedEarly).toBeUndefined();
  });

  it('waits between requests with delayMs, and stops when its signal aborts', async () => {
    const requests: RunnableRequest[] = ['a', 'b', 'c'].map((name) => ({ id: name, name, config: config() }));
    const start = performance.now();
    const paced = await runCollection(requests, emptyScopes(), undefined, undefined, { delayMs: 60 });
    expect(paced.items).toHaveLength(3);
    // Two waits: none before the first request.
    expect(performance.now() - start).toBeGreaterThanOrEqual(110);
    expect(paced.cancelled).toBeUndefined();

    const controller = new AbortController();
    const stopped = await runCollection(
      requests,
      emptyScopes(),
      (_item, index) => {
        // Stopped during the wait after the first request.
        if (index === 0) setTimeout(() => controller.abort(), 20);
      },
      undefined,
      { delayMs: 5_000, signal: controller.signal },
    );
    expect(stopped.items.map((i) => i.requestName)).toEqual(['a']);
    expect(stopped.cancelled).toBe(true);

    const before = await runCollection(requests, emptyScopes(), undefined, undefined, { signal: AbortSignal.abort() });
    expect(before).toMatchObject({ items: [], cancelled: true });
  });
});

describe('cookies and tokens in a run', () => {
  let apiServer: http.Server;
  let api: string;
  let tokenRequests = 0;
  beforeAll(async () => {
    apiServer = http.createServer((req, res) => {
      if (req.url === '/token') {
        tokenRequests++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: `t${tokenRequests}`, expires_in: 60 }));
        return;
      }
      if (req.url === '/login') res.setHeader('set-cookie', 'session=s1; Path=/');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, authorization: req.headers.authorization ?? null }));
    });
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    api = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  });
  afterAll(() => apiServer.close());

  it('sends what a cookie jar kept to the requests after, and shares one OAuth token', async () => {
    const { CookieJar } = await import('../request/cookieJar');
    const oauth2 = { grantType: 'client_credentials' as const, tokenUrl: `${api}/token`, clientId: 'c' };
    const requests: RunnableRequest[] = [
      { id: '1', name: 'login', config: config({ url: `${api}/login` }) },
      { id: '2', name: 'me', config: config({ url: `${api}/me`, auth: { type: 'oauth2', oauth2 } }) },
      { id: '3', name: 'again', config: config({ url: `${api}/me`, auth: { type: 'oauth2', oauth2 } }) },
    ];
    const report = await runCollection(requests, emptyScopes(), undefined, undefined, { cookieJar: new CookieJar() });
    const bodies = report.items.map((i) => JSON.parse(i.result.response!.body));
    expect(bodies.map((b) => b.cookie)).toEqual([null, 'session=s1', 'session=s1']);
    expect(bodies.slice(1).map((b) => b.authorization)).toEqual(['Bearer t1', 'Bearer t1']);
    expect(tokenRequests).toBe(1);
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
    // Vitest's default 5 s timeout would otherwise end the test before that bound.
  }, 15_000);
});
