import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { startTestProxy, type TestProxy } from '../test/proxy';
import { testPki } from '../test/tls';
import { executeRequest } from './executor';
import type { NetworkSettings, RequestConfig } from '../types';

// An HTTPS server that speaks HTTP/2 and HTTP/1.1 (and answers with the
// version and client certificate it saw), one that speaks only HTTP/1.1,
// and a plain-HTTP one, all with the test CA's certificate.
let dir: string;
let both: http2.Http2SecureServer;
let only1: https.Server;
let plain: http.Server;
let proxy: TestProxy;
let bothUrl: string;
let only1Url: string;
let plainUrl: string;
let caPaths: string[];
let clientCertificates: NetworkSettings['clientCertificates'];

const answer = (
  req: http.IncomingMessage | http2.Http2ServerRequest,
  res: http.ServerResponse | http2.Http2ServerResponse,
) => {
  const peer = (req.socket as TLSSocket).getPeerCertificate?.();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ version: req.httpVersion, client: peer?.subject?.CN ?? null }));
};
const listen = async (server: http.Server | https.Server | http2.Http2SecureServer) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

beforeAll(async () => {
  const pki = testPki();
  dir = mkdtempSync(join(tmpdir(), 'jtaak-http2-'));
  writeFileSync(join(dir, 'ca.pem'), pki.ca);
  writeFileSync(join(dir, 'client.pem'), pki.client.cert);
  writeFileSync(join(dir, 'client.key'), pki.client.key);
  caPaths = [join(dir, 'ca.pem')];
  clientCertificates = [{ host: '127.0.0.1', certPath: join(dir, 'client.pem'), keyPath: join(dir, 'client.key') }];

  both = http2.createSecureServer(
    { ...pki.server, ca: pki.ca, requestCert: true, rejectUnauthorized: false, allowHTTP1: true },
    answer,
  );
  bothUrl = `https://127.0.0.1:${await listen(both)}`;
  only1 = https.createServer({ ...pki.server }, answer);
  only1Url = `https://127.0.0.1:${await listen(only1)}`;
  plain = http.createServer(answer);
  plainUrl = `http://127.0.0.1:${await listen(plain)}`;
  proxy = await startTestProxy();
});

afterAll(async () => {
  await proxy.close();
  only1.closeAllConnections();
  plain.closeAllConnections();
  await Promise.all([both, only1, plain].map((s) => new Promise((resolve) => s.close(resolve))));
  rmSync(dir, { recursive: true, force: true });
});

const request = (url: string, network: NetworkSettings): RequestConfig => ({
  id: 'r',
  name: 'r',
  method: 'GET',
  url,
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
  network,
});
const seen = (body: string) => JSON.parse(body) as { version: string; client: string | null };

describe('HTTP/2', () => {
  it('stays on HTTP/1.1 unless asked, and says so', async () => {
    const response = await executeRequest(request(bothUrl, { caPaths }));
    expect(response.httpVersion).toBe('1.1');
    expect(seen(response.body).version).toBe('1.1');
  });

  it('uses HTTP/2 with a server that offers it', async () => {
    const response = await executeRequest(request(`${bothUrl}/a`, { caPaths, http2: true }));
    expect(response.status).toBe(200);
    expect(response.httpVersion).toBe('2');
    expect(seen(response.body).version).toBe('2.0');
    expect(response.tls?.alpnProtocol).toBe('h2');
  });

  it('keeps HTTP/1.1 and HTTP/2 connections apart', async () => {
    const first = await executeRequest(request(`${bothUrl}/b`, { caPaths, http2: true }));
    const second = await executeRequest(request(`${bothUrl}/c`, { caPaths }));
    expect([first.httpVersion, second.httpVersion]).toEqual(['2', '1.1']);
  });

  it('falls back to HTTP/1.1 with a server that only speaks that', async () => {
    const response = await executeRequest(request(only1Url, { caPaths, http2: true }));
    expect(response.httpVersion).toBe('1.1');
    expect(seen(response.body).version).toBe('1.1');
  });

  it('stays on HTTP/1.1 for plain HTTP', async () => {
    const response = await executeRequest(request(plainUrl, { http2: true }));
    expect(response.httpVersion).toBe('1.1');
  });

  it('sends a client certificate over HTTP/2', async () => {
    const response = await executeRequest(request(`${bothUrl}/d`, { caPaths, clientCertificates, http2: true }));
    expect(response.httpVersion).toBe('2');
    expect(seen(response.body).client).toBe('jtaak test client');
  });

  it("uses HTTP/2 through a proxy's tunnel", async () => {
    proxy.seen.length = 0;
    const response = await executeRequest(request(`${bothUrl}/e`, { caPaths, proxy: { url: proxy.url }, http2: true }));
    expect(response.httpVersion).toBe('2');
    expect(seen(response.body).version).toBe('2.0');
    expect(proxy.seen.map((s) => s.method)).toEqual(['CONNECT']);
  });
});
