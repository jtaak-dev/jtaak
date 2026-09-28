import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import * as grpc from '@grpc/grpc-js';
import { Aedes } from 'aedes';
import { Root, parse, type Type } from 'protobufjs';
import { WebSocketServer } from 'ws';
import { executeRequest } from './executor';
import { executeGrpcUnaryCall } from './grpc';
import { hostMatches, proxyFor, proxyFromEnvironment, tlsOptionsFor } from './network';
import { openStream } from './streamExecutor';
import { startTestProxy, type TestProxy } from '../test/proxy';
import { testPki } from '../test/tls';
import { openDatabase } from '../storage/db';
import {
  createRequest,
  getCollectionTree,
  getOrCreateDefaultWorkspace,
  getRequest,
  updateRequest,
} from '../storage/repository';
import { addHistoryEntry, getHistoryEntry } from '../storage/history';
import type { MessagingStreamHandle, NetworkSettings, RequestConfig, StreamEvent } from '../types';

describe('hostMatches', () => {
  it('matches a host and its subdomains, wildcards, ports and IP addresses', () => {
    expect(hostMatches('example.com', 'example.com', 443)).toBe(true);
    expect(hostMatches('example.com', 'api.example.com', 443)).toBe(true);
    expect(hostMatches('example.com', 'badexample.com', 443)).toBe(false);
    expect(hostMatches('*.example.com', 'example.com', 443)).toBe(false);
    expect(hostMatches('*.example.com', 'a.b.example.com', 443)).toBe(true);
    expect(hostMatches('.example.com', 'api.example.com', 443)).toBe(true);
    expect(hostMatches('*', 'anything', 1)).toBe(true);
    expect(hostMatches('API.Example.com:8443', 'api.example.com', 8443)).toBe(true);
    expect(hostMatches('api.example.com:8443', 'api.example.com', 443)).toBe(false);
    expect(hostMatches('127.0.0.1', '127.0.0.1', 80)).toBe(true);
    expect(hostMatches('[::1]:8080', '::1', 8080)).toBe(true);
    expect(hostMatches('::1', '::1', 80)).toBe(true);
    expect(hostMatches(' ', 'x', 1)).toBe(false);
  });
});

describe('proxyFor and proxyFromEnvironment', () => {
  const network: NetworkSettings = { proxy: { url: 'http://proxy:3128', noProxy: ['localhost', '*.internal'] } };

  it('skips the proxy for the no-proxy hosts', () => {
    expect(proxyFor(network, 'https://api.example.com/x')?.url).toBe('http://proxy:3128');
    expect(proxyFor(network, 'http://localhost:8080/')).toBeUndefined();
    expect(proxyFor(network, 'wss://svc.internal/socket')).toBeUndefined();
    expect(proxyFor(undefined, 'https://a.test')).toBeUndefined();
    expect(proxyFor({ proxy: { url: '' } }, 'https://a.test')).toBeUndefined();
  });

  it('reads HTTPS_PROXY before HTTP_PROXY, with its login and NO_PROXY', () => {
    expect(
      proxyFromEnvironment({
        HTTPS_PROXY: 'http://me:p%40ss@proxy.corp:8080',
        HTTP_PROXY: 'http://other:1',
        NO_PROXY: 'localhost, .corp,10.0.0.1',
      }),
    ).toEqual({
      url: 'http://proxy.corp:8080',
      username: 'me',
      password: 'p@ss',
      noProxy: ['localhost', '.corp', '10.0.0.1'],
    });
    expect(proxyFromEnvironment({ http_proxy: 'proxy.corp:3128' })).toEqual({ url: 'http://proxy.corp:3128' });
    expect(proxyFromEnvironment({})).toBeUndefined();
  });
});

describe('tlsOptionsFor', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'jtaak-tls-'));
    const pki = testPki();
    writeFileSync(join(dir, 'ca.pem'), pki.ca);
    writeFileSync(join(dir, 'client.pem'), pki.client.cert);
    writeFileSync(join(dir, 'client.key'), pki.client.key);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the extra authorities to the system's, and offers the certificate for the host", () => {
    const network: NetworkSettings = {
      caPaths: [join(dir, 'ca.pem')],
      clientCertificates: [
        { host: 'other.test', pfxPath: join(dir, 'missing.pfx') },
        { host: 'api.test', certPath: join(dir, 'client.pem'), keyPath: join(dir, 'client.key'), passphrase: 'x' },
      ],
    };
    const options = tlsOptionsFor({ network }, 'api.test', 443);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca!.length).toBeGreaterThan(100);
    expect(options.ca!.at(-1)).toBe(testPki().ca);
    expect(options.cert!.toString()).toBe(testPki().client.cert);
    expect(options.key!.toString()).toBe(testPki().client.key);
    expect(options.passphrase).toBe('x');
    expect(tlsOptionsFor({ network: {}, verifyTls: false }, 'api.test', 443)).toEqual({ rejectUnauthorized: false });
  });

  it("names a file that can't be read", () => {
    const network: NetworkSettings = { clientCertificates: [{ host: '*', pfxPath: join(dir, 'missing.pfx') }] };
    expect(() => tlsOptionsFor({ network }, 'a.test', 443)).toThrow(
      /Couldn't read the client certificate \(PFX\) file ".*missing\.pfx": no such file/,
    );
  });
});

describe('network settings are never saved', () => {
  it('leaves them out of saved requests and history', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const [collection] = getCollectionTree(db, workspace.id);
    const network: NetworkSettings = { clientCertificates: [{ host: '*', pfxPath: 'a.pfx', passphrase: 'secret' }] };
    const config: RequestConfig = {
      id: 'x',
      name: 'r',
      method: 'GET',
      url: 'https://a.test',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
      network,
    };
    const saved = createRequest(db, { collectionId: collection.id, name: 'r', config });
    expect(getRequest(db, saved.id)!.config).not.toHaveProperty('network');
    updateRequest(db, saved.id, { ...saved.config, network });
    expect(getRequest(db, saved.id)!.config).not.toHaveProperty('network');
    const entry = addHistoryEntry(db, { workspaceId: workspace.id, config });
    expect(getHistoryEntry(db, entry.id)!.config).not.toHaveProperty('network');
    expect(JSON.stringify(db.prepare('SELECT * FROM request_history').all())).not.toContain('secret');
  });
});

// Servers for the connection tests: a plain HTTP echo server (also a
// WebSocket and gRPC server's port), and an HTTPS one with the test PKI's
// server certificate that asks for (but doesn't need) a client certificate.
let dir: string;
let proxy: TestProxy;
let authProxy: TestProxy;
let httpServer: http.Server;
let httpUrl: string;
let httpsServer: https.Server;
let httpsUrl: string;
let pemCertificate: NetworkSettings['clientCertificates'];
let pfxCertificate: NetworkSettings['clientCertificates'];

function echo(req: http.IncomingMessage, res: http.ServerResponse) {
  const peer = (req.socket as tls.TLSSocket).getPeerCertificate?.();
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ url: req.url, client: peer?.subject?.CN ?? null }));
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jtaak-network-'));
  const pki = testPki();
  writeFileSync(join(dir, 'ca.pem'), pki.ca);
  writeFileSync(join(dir, 'client.pem'), pki.client.cert);
  writeFileSync(join(dir, 'client.key'), pki.client.key);
  writeFileSync(join(dir, 'client.pfx'), pki.client.pfx);
  pemCertificate = [{ host: '127.0.0.1', certPath: join(dir, 'client.pem'), keyPath: join(dir, 'client.key') }];
  pfxCertificate = [{ host: '127.0.0.1', pfxPath: join(dir, 'client.pfx'), passphrase: pki.client.passphrase }];

  proxy = await startTestProxy();
  authProxy = await startTestProxy({ credentials: 'me:pw' });
  httpServer = http.createServer(echo);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  httpsServer = https.createServer(
    { ...pki.server, ca: pki.ca, requestCert: true, rejectUnauthorized: false },
    (req, res) => {
      // Only a certificate the test CA signed counts.
      if (!(req.socket as tls.TLSSocket).authorized) {
        res.writeHead(401).end('client certificate needed');
        return;
      }
      echo(req, res);
    },
  );
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  httpsUrl = `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await proxy.close();
  await authProxy.close();
  httpServer.closeAllConnections();
  httpsServer.closeAllConnections();
  httpServer.close();
  httpsServer.close();
  rmSync(dir, { recursive: true, force: true });
});

function request(url: string, network?: NetworkSettings, overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'r',
    name: 'r',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...(network && { network }),
    ...overrides,
  };
}

describe('HTTP through a proxy', () => {
  it('sends a plain-HTTP request to the proxy as it is', async () => {
    const before = proxy.seen.length;
    const response = await executeRequest(request(`${httpUrl}/plain?a=1`, { proxy: { url: proxy.url } }));
    expect(JSON.parse(response.body).url).toBe('/plain?a=1');
    expect(proxy.seen.slice(before)).toEqual([{ method: 'GET', target: `${httpUrl}/plain?a=1` }]);
  });

  it('tunnels HTTPS with CONNECT, checking the server against the extra authority', async () => {
    const before = proxy.seen.length;
    const network = { proxy: { url: proxy.url }, caPaths: [join(dir, 'ca.pem')], clientCertificates: pemCertificate };
    const response = await executeRequest(request(`${httpsUrl}/secure`, network));
    expect(JSON.parse(response.body)).toEqual({ url: '/secure', client: 'jtaak test client' });
    expect(proxy.seen.slice(before).map((s) => s.method)).toEqual(['CONNECT']);
  });

  it('logs in to the proxy, and says when it needs a login', async () => {
    const network = (login: boolean): NetworkSettings => ({
      proxy: { url: authProxy.url, ...(login && { username: 'me', password: 'pw' }) },
    });
    expect((await executeRequest(request(`${httpUrl}/in`, network(true)))).status).toBe(200);
    expect(authProxy.seen.at(-1)?.authorization).toBe(`Basic ${Buffer.from('me:pw').toString('base64')}`);
    await expect(executeRequest(request(`${httpUrl}/in`, network(false)))).rejects.toThrow(
      /Proxy Authentication Required \(407\)/,
    );
  });

  it('goes direct to a no-proxy host', async () => {
    const before = proxy.seen.length;
    const network = { proxy: { url: proxy.url, noProxy: ['127.0.0.1'] } };
    expect((await executeRequest(request(`${httpUrl}/direct`, network))).status).toBe(200);
    expect(proxy.seen.length).toBe(before);
  });

  it('sends a form-data body through the proxy', async () => {
    const response = await executeRequest(
      request(
        `${httpUrl}/form`,
        { proxy: { url: proxy.url } },
        { method: 'POST', body: { mode: 'form-data', formData: [{ key: 'a', value: '1', enabled: true }] } },
      ),
    );
    expect(response.status).toBe(200);
  });
});

describe('client certificates and extra authorities over HTTPS', () => {
  const ca = () => [join(dir, 'ca.pem')];

  it("fails the server's certificate without the authority that signed it", async () => {
    await expect(executeRequest(request(`${httpsUrl}/`))).rejects.toThrow(/certificate/i);
  });

  it('sends a PEM or a PFX certificate to its host only', async () => {
    const pem = await executeRequest(request(`${httpsUrl}/`, { caPaths: ca(), clientCertificates: pemCertificate }));
    expect(JSON.parse(pem.body).client).toBe('jtaak test client');
    const pfx = await executeRequest(request(`${httpsUrl}/`, { caPaths: ca(), clientCertificates: pfxCertificate }));
    expect(JSON.parse(pfx.body).client).toBe('jtaak test client');
    const elsewhere = [{ ...pemCertificate![0], host: 'example.com' }];
    const none = await executeRequest(request(`${httpsUrl}/`, { caPaths: ca(), clientCertificates: elsewhere }));
    expect(none.status).toBe(401);
  });

  it('says when the passphrase is wrong', async () => {
    const wrong = [{ ...pfxCertificate![0], passphrase: 'nope' }];
    await expect(executeRequest(request(`${httpsUrl}/`, { caPaths: ca(), clientCertificates: wrong }))).rejects.toThrow(
      /mac verify failure|bad decrypt|pkcs12/i,
    );
  });
});

function nextEvent(events: StreamEvent[], type: StreamEvent['type']): Promise<StreamEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const check = () => {
      const found = events.find((event) => event.type === type || event.type === 'error');
      if (found) return found.type === type ? resolve(found) : reject(new Error(JSON.stringify(found.data)));
      if (Date.now() - started > 5000) return reject(new Error(`No ${type} event`));
      setTimeout(check, 10);
    };
    check();
  });
}

describe('WebSocket', () => {
  it('connects through the proxy with CONNECT', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((resolve) => server.once('listening', resolve));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const before = proxy.seen.length;
    const events: StreamEvent[] = [];
    const handle = openStream(request(url, { proxy: { url: proxy.url } }, { protocol: 'websocket' }), (event) =>
      events.push(event),
    );
    await nextEvent(events, 'open');
    expect(proxy.seen.slice(before)).toEqual([expect.objectContaining({ method: 'CONNECT', target: url.slice(5) })]);
    handle.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it('offers the client certificate over wss', async () => {
    const pki = testPki();
    const server = https.createServer({ ...pki.server, ca: pki.ca, requestCert: true, rejectUnauthorized: true });
    const wss = new WebSocketServer({ server });
    let client: string | string[] | undefined;
    wss.on('connection', (_socket, req) => {
      client = (req.socket as tls.TLSSocket).getPeerCertificate().subject.CN;
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `wss://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const events: StreamEvent[] = [];
    const handle = openStream(
      request(url, { caPaths: [join(dir, 'ca.pem')], clientCertificates: pfxCertificate }, { protocol: 'websocket' }),
      (event) => events.push(event),
    );
    await nextEvent(events, 'open');
    expect(client).toBe('jtaak test client');
    handle.close();
    wss.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
});

describe('gRPC', () => {
  const PROTO = `syntax = "proto3"; package t; service Echo { rpc Say (Msg) returns (Msg); } message Msg { string text = 1; }`;

  async function startServer(credentials: grpc.ServerCredentials): Promise<{ server: grpc.Server; port: number }> {
    const root = new Root();
    parse(PROTO, root, { keepCase: true });
    root.resolveAll();
    const type: Type = root.lookupType('t.Msg');
    const codec = {
      serialize: (v: Record<string, unknown>) => Buffer.from(type.encode(type.fromObject(v)).finish()),
      deserialize: (b: Buffer) => type.toObject(type.decode(b)),
    };
    const server = new grpc.Server();
    server.addService(
      {
        Say: {
          path: '/t.Echo/Say',
          requestStream: false,
          responseStream: false,
          requestSerialize: codec.serialize,
          requestDeserialize: codec.deserialize,
          responseSerialize: codec.serialize,
          responseDeserialize: codec.deserialize,
        },
      },
      {
        Say: (
          call: grpc.ServerUnaryCall<{ text: string }, { text: string }>,
          done: grpc.sendUnaryData<{ text: string }>,
        ) => {
          const peer = (
            call as unknown as { getAuthContext?: () => { sslPeerCertificate?: tls.PeerCertificate } }
          ).getAuthContext?.()?.sslPeerCertificate?.subject?.CN;
          done(null, { text: `${call.request.text}${peer ? ` from ${peer}` : ''}` });
        },
      },
    );
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync('127.0.0.1:0', credentials, (error, bound) => (error ? reject(error) : resolve(bound))),
    );
    return { server, port };
  }

  const call = (port: number, network: NetworkSettings, usePlaintext: boolean) =>
    executeGrpcUnaryCall(
      request(`127.0.0.1:${port}`, network, {
        protocol: 'grpc',
        protocolConfig: {
          protoFile: PROTO,
          serviceFullName: 't.Echo',
          methodName: 'Say',
          requestMessage: { text: 'hi' },
          usePlaintext,
        },
      }),
    );

  it('calls through the proxy', async () => {
    const { server, port } = await startServer(grpc.ServerCredentials.createInsecure());
    const before = proxy.seen.length;
    const result = await call(port, { proxy: { url: proxy.url } }, true);
    expect(result.message).toEqual({ text: 'hi' });
    expect(proxy.seen.slice(before)).toEqual([
      expect.objectContaining({ method: 'CONNECT', target: `127.0.0.1:${port}` }),
    ]);
    server.forceShutdown();
  });

  it('offers the client certificate over TLS', async () => {
    const pki = testPki();
    const { server, port } = await startServer(
      grpc.ServerCredentials.createSsl(
        Buffer.from(pki.ca),
        [{ private_key: Buffer.from(pki.server.key), cert_chain: Buffer.from(pki.server.cert) }],
        true,
      ),
    );
    const result = await call(port, { caPaths: [join(dir, 'ca.pem')], clientCertificates: pemCertificate }, false);
    expect(result.status.code).toBe(grpc.status.OK);
    expect(result.message).toEqual({ text: 'hi from jtaak test client' });
    server.forceShutdown();
  });
});

describe('MQTT over TLS', () => {
  it('offers the client certificate to a broker that needs one', async () => {
    const pki = testPki();
    const broker = await Aedes.createBroker();
    const server = tls.createServer(
      { ...pki.server, ca: pki.ca, requestCert: true, rejectUnauthorized: true },
      broker.handle,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `mqtts://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const events: StreamEvent[] = [];
    const handle = openStream(
      request(url, { caPaths: [join(dir, 'ca.pem')], clientCertificates: pemCertificate }, { protocol: 'mqtt' }),
      (event) => events.push(event),
    ) as MessagingStreamHandle;
    await nextEvent(events, 'open');
    handle.close();
    server.close();
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });
});
