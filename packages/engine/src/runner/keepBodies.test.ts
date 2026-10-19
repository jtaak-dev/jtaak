import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { runCollection, type RunnableRequest } from './collectionRunner';
import { emptyScopes, type CollectionRunItemResult } from '../types';

const BODY = 'x'.repeat(20_000);
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(req.url === '/fail' ? 500 : 200, { 'content-type': 'text/plain' });
    res.end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const okTest = 'jt.test("ok", () => jt.expect(jt.response.status).toBe(200));';
const request = (id: string, path: string, testScript?: string): RunnableRequest => ({
  id,
  name: id,
  config: {
    id,
    name: id,
    method: 'GET',
    url: `${baseUrl}${path}`,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    testScript,
  },
});
// Passes; fails its test; fails to send (nothing listens on port 1); has no tests.
let requests: RunnableRequest[];
beforeAll(() => {
  requests = [
    request('pass', '/ok', okTest),
    request('test fails', '/fail', okTest),
    request('send fails', '/ok'),
    request('no tests', '/ok'),
  ];
  requests[2].config.url = 'http://127.0.0.1:1/';
});

const kept = (items: CollectionRunItemResult[]) =>
  items.map((item) => [item.requestName, item.result.response?.body.length, item.result.response?.bodyDropped]);

describe('keepBodies', () => {
  it("keeps every body by default ('all')", async () => {
    const report = await runCollection(requests, emptyScopes());
    expect(kept(report.items)).toEqual([
      ['pass', 20_000, undefined],
      ['test fails', 20_000, undefined],
      ['send fails', undefined, undefined],
      ['no tests', 20_000, undefined],
    ]);
  });

  it("keeps only failed requests' bodies with 'failed', and the rest of their responses", async () => {
    const seen: CollectionRunItemResult[] = [];
    const report = await runCollection(requests, emptyScopes(), (item) => seen.push(item), undefined, {
      keepBodies: 'failed',
    });
    expect(kept(report.items)).toEqual([
      ['pass', 0, true],
      ['test fails', 20_000, undefined],
      ['send fails', undefined, undefined],
      ['no tests', 0, true],
    ]);
    expect(kept(seen)).toEqual(kept(report.items));
    expect(report.items[0].result.response).toMatchObject({ status: 200, sizeBytes: 20_000 });
    expect(report.items[0].result.response!.headers['content-type']).toBe('text/plain');
    expect(report.items[0].result.response!.timings.durationMs).toBeGreaterThan(0);
    // Scripts ran against the whole body.
    expect(report).toMatchObject({ passedAssertions: 1, failedAssertions: 1, requestsFailedToSend: 1 });
  });

  it("keeps no body with 'none'", async () => {
    const report = await runCollection(requests, emptyScopes(), undefined, undefined, { keepBodies: 'none' });
    expect(kept(report.items)).toEqual([
      ['pass', 0, true],
      ['test fails', 0, true],
      ['send fails', undefined, undefined],
      ['no tests', 0, true],
    ]);
  });

  it('stays flat in memory over a long run', { timeout: 60_000 }, async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const long = Array.from({ length: 10_000 }, (_, i) => request(`r${i}`, '/ok'));
    gc();
    const before = process.memoryUsage().heapUsed;
    const report = await runCollection(long, emptyScopes(), undefined, undefined, { keepBodies: 'none' });
    gc();
    const growth = process.memoryUsage().heapUsed - before;
    expect(report.items).toHaveLength(10_000);
    // Kept, the bodies alone would be 200 MB.
    expect(growth).toBeLessThan(40 * 1024 * 1024);
  });
});
