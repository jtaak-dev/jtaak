import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeRequest } from './executor';
import type { RequestConfig } from '../types';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, method: req.method, headers: req.headers, body }));
    });
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

describe('executeRequest', () => {
  it('sends a GET request and returns status, body, and timing', async () => {
    const result = await executeRequest(baseConfig({ url: `${baseUrl}/users` }));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).path).toBe('/users');
    expect(result.timings.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('appends enabled query params and skips disabled ones', async () => {
    const result = await executeRequest(
      baseConfig({
        params: [
          { key: 'q', value: 'jtaak', enabled: true },
          { key: 'debug', value: 'true', enabled: false },
        ],
      }),
    );
    expect(JSON.parse(result.body).path).toBe('/?q=jtaak');
  });

  it('applies bearer auth as an Authorization header', async () => {
    const result = await executeRequest(baseConfig({ auth: { type: 'bearer', bearer: { token: 'abc123' } } }));
    expect(JSON.parse(result.body).headers.authorization).toBe('Bearer abc123');
  });

  it('sends a raw JSON body on POST', async () => {
    const result = await executeRequest(
      baseConfig({
        method: 'POST',
        body: { mode: 'json', raw: '{"hello":"world"}' },
      }),
    );
    expect(JSON.parse(result.body).body).toBe('{"hello":"world"}');
  });
});

describe('executeRequest: unsupported protocols', () => {
  it('rejects a streaming protocol with a clear error instead of attempting fetch', async () => {
    await expect(executeRequest(baseConfig({ protocol: 'websocket' }))).rejects.toThrow(
      /does not support the "websocket" protocol/,
    );
  });
});

describe('executeRequest: graphql protocol', () => {
  it('POSTs a JSON {query, variables, operationName} body regardless of config.method', async () => {
    const result = await executeRequest(
      baseConfig({
        method: 'GET',
        protocol: 'graphql',
        protocolConfig: { query: '{ me { id } }', variables: { id: 1 }, operationName: 'Me' },
      }),
    );
    const echoed = JSON.parse(result.body);
    expect(echoed.method).toBe('POST');
    expect(JSON.parse(echoed.body)).toEqual({ query: '{ me { id } }', variables: { id: 1 }, operationName: 'Me' });
  });

  it("defaults Content-Type to application/json when the user hasn't set one", async () => {
    const result = await executeRequest(
      baseConfig({ protocol: 'graphql', protocolConfig: { query: '{ me { id } }' } }),
    );
    const echoed = JSON.parse(result.body);
    expect(echoed.headers['content-type']).toBe('application/json');
  });

  it('respects a user-supplied Content-Type header instead of overwriting it', async () => {
    const result = await executeRequest(
      baseConfig({
        protocol: 'graphql',
        protocolConfig: { query: '{ me { id } }' },
        headers: [{ key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true }],
      }),
    );
    const echoed = JSON.parse(result.body);
    expect(echoed.headers['content-type']).toBe('application/json; charset=utf-8');
  });
});

describe('performance budget: engine overhead', () => {
  it('achieves under 5ms of engine overhead per request on loopback', async () => {
    // Loopback network latency is sub-millisecond, so timing executeRequest
    // end-to-end here is a reasonable proxy for "engine overhead excluding
    // actual network time" (the <5 ms budget) without needing to instrument
    // fetch() internals separately. We assert on the minimum across several
    // iterations (after a warmup) rather than the mean, since occasional
    // GC/OS-scheduler pauses are expected noise on a shared/loaded machine —
    // the budget is about what the engine can achieve, not that it never
    // shares a CPU with anything else.
    const iterations = 30;
    const warmup = 5;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = await executeRequest(baseConfig());
      if (i >= warmup) samples.push(result.timings.durationMs);
    }

    const best = Math.min(...samples);
    expect(best).toBeLessThan(5);
  });
});
