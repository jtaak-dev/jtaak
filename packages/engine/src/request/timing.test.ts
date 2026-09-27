import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeRequest } from './executor';
import { timingPhases } from './timing';
import type { RequestConfig } from '../types';

// A server that waits `headers` ms before sending its headers, then `body` ms
// before finishing the body (both from the query string).
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const query = new URL(req.url ?? '/', 'http://x').searchParams;
    const headersDelay = Number(query.get('headers') ?? 0);
    const bodyDelay = Number(query.get('body') ?? 0);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('first part, ');
      setTimeout(() => res.end('second part'), bodyDelay);
    }, headersDelay);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

function request(url: string): RequestConfig {
  return {
    id: 'req',
    name: 'timing',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
  };
}

// Timers can fire a little early or late; the phases are measured around them.
const SLACK = 15;

describe('timing phases', () => {
  it('splits a request into connect, wait and download', async () => {
    // localhost, so there's a DNS lookup.
    const { timings } = await executeRequest(request(`http://localhost:${port}/fresh?headers=80&body=60`));
    const phases = timings.phases!;
    expect(phases).toBeDefined();
    expect(phases.reusedConnection).toBe(false);
    expect(phases.waitMs).toBeGreaterThanOrEqual(80 - SLACK);
    expect(phases.downloadMs).toBeGreaterThanOrEqual(60 - SLACK);
    expect(phases.tlsMs).toBe(0);
    const phaseSum = phases.dnsMs + phases.connectMs + phases.tlsMs + phases.waitMs + phases.downloadMs;
    expect(phaseSum).toBeLessThanOrEqual(timings.durationMs + 1);
  });

  it('reports a reused connection, with no DNS, connect or TLS time', async () => {
    const url = `http://127.0.0.1:${port}/reuse`;
    await executeRequest(request(url));
    // undici returns a connection to its pool just after the body ends; a
    // request sent at once would open a second one.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { timings } = await executeRequest(request(url));
    expect(timings.phases).toMatchObject({ reusedConnection: true, dnsMs: 0, connectMs: 0, tlsMs: 0 });
  });

  it('keeps concurrent requests apart', async () => {
    const [slow, quick] = await Promise.all([
      executeRequest(request(`http://127.0.0.1:${port}/slow?headers=150`)),
      executeRequest(request(`http://127.0.0.1:${port}/quick?headers=10`)),
    ]);
    expect(slow.timings.phases!.waitMs).toBeGreaterThanOrEqual(150 - SLACK);
    expect(quick.timings.phases!.waitMs).toBeLessThan(100);
  });
});

describe('timingPhases', () => {
  it('computes each phase from its marks, including TLS', () => {
    const phases = timingPhases(
      {
        connection: { created: 100, lookup: 110, connect: 130, secureConnect: 170, claimed: true },
        requestSent: 172,
        firstByte: 222,
      },
      260,
    );
    expect(phases).toEqual({
      dnsMs: 10,
      connectMs: 20,
      tlsMs: 40,
      waitMs: 50,
      downloadMs: 38,
      reusedConnection: false,
    });
  });

  it('measures connect from socket creation when there was no lookup (an IP address)', () => {
    const phases = timingPhases(
      { connection: { created: 100, connect: 105, claimed: true }, requestSent: 106, firstByte: 120 },
      130,
    );
    expect(phases).toMatchObject({ dnsMs: 0, connectMs: 5, tlsMs: 0 });
  });

  it('reports a reused connection when no connection was claimed', () => {
    expect(timingPhases({ requestSent: 5, firstByte: 25 }, 30)).toEqual({
      dnsMs: 0,
      connectMs: 0,
      tlsMs: 0,
      waitMs: 20,
      downloadMs: 5,
      reusedConnection: true,
    });
  });

  it('has nothing to report without the response event', () => {
    expect(timingPhases({}, 10)).toBeUndefined();
  });
});
