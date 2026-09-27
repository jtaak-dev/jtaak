import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { Root, parse, type Type } from 'protobufjs';
import { WebSocketServer } from 'ws';
import { selfSignedCertificate } from '../test/tls';
import { executeRequest } from './executor';
import { executeGrpcUnaryCall } from './grpc';
import { openMcpStream } from './mcp';
import { openSseStream } from './sse';
import { openWebSocketStream } from './websocket';
import type { RequestConfig, StreamEvent } from '../types';

// One HTTPS server with a self-signed certificate answers plain requests,
// SSE and MCP (by path), and a WebSocket server shares it. Every protocol
// must refuse it by default, saying why, and accept it with verifyTls: false.
let server: https.Server;
let wss: WebSocketServer;
let origin: string;

beforeAll(async () => {
  const { key, cert } = await selfSignedCertificate();
  server = https.createServer({ key, cert }, (req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.url === '/sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: hello\n\n');
      } else if (req.url === '/mcp') {
        const message = JSON.parse(body);
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'tls-mcp', version: '1.0.0' },
              capabilities: {},
            },
          }),
        );
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      }
    });
  });
  wss = new WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  wss.close();
  server.close();
});

function config(overrides: Partial<RequestConfig>): RequestConfig {
  return {
    id: 'tls',
    name: 'tls',
    method: 'GET',
    url: `https://${origin}/`,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

/** Collects a stream's events until one of `until` arrives. */
function firstEvent(
  open: (onEvent: (event: StreamEvent) => void) => { close(): void },
  until: StreamEvent['type'][],
): Promise<StreamEvent> {
  return new Promise((resolve) => {
    const handle = open((event) => {
      if (!until.includes(event.type)) return;
      handle.close();
      resolve(event);
    });
  });
}

// Node's message for a certificate that signed itself.
const SELF_SIGNED = /self-signed certificate.*\(DEPTH_ZERO_SELF_SIGNED_CERT\)/;

describe('HTTP', () => {
  it('refuses a self-signed certificate, with the reason in the message', async () => {
    await expect(executeRequest(config({}))).rejects.toThrow(SELF_SIGNED);
  });

  it('accepts it with verifyTls: false, and still times the request', async () => {
    const response = await executeRequest(config({ verifyTls: false }));
    expect(response.status).toBe(200);
    expect(response.body).toBe('ok');
    expect(response.timings.phases?.tlsMs).toBeGreaterThanOrEqual(0);
  });
});

describe('SSE', () => {
  it('refuses a self-signed certificate, with the reason in the error event', async () => {
    const event = await firstEvent(
      (onEvent) => openSseStream(config({ url: `https://${origin}/sse` }), onEvent),
      ['error', 'open'],
    );
    expect(event.type).toBe('error');
    expect((event.data as { message: string }).message).toMatch(SELF_SIGNED);
  });

  it('connects with verifyTls: false', async () => {
    const event = await firstEvent(
      (onEvent) => openSseStream(config({ url: `https://${origin}/sse`, verifyTls: false }), onEvent),
      ['message', 'error'],
    );
    expect(event).toMatchObject({ type: 'message', data: { data: 'hello' } });
  });
});

describe('WebSocket', () => {
  it('refuses a self-signed certificate, with the reason in the error event', async () => {
    const event = await firstEvent(
      (onEvent) => openWebSocketStream(config({ protocol: 'websocket', url: `wss://${origin}/` }), onEvent),
      ['error', 'open'],
    );
    expect(event.type).toBe('error');
    expect((event.data as { message: string }).message).toMatch(/self-signed certificate/);
  });

  it('connects with verifyTls: false', async () => {
    const event = await firstEvent(
      (onEvent) =>
        openWebSocketStream(config({ protocol: 'websocket', url: `wss://${origin}/`, verifyTls: false }), onEvent),
      ['open', 'error'],
    );
    expect(event.type).toBe('open');
  });
});

describe('MCP over HTTP', () => {
  const mcp = (overrides: Partial<RequestConfig>) =>
    config({ protocol: 'mcp', url: `https://${origin}/mcp`, protocolConfig: { transport: 'http' }, ...overrides });

  it('fails the handshake with the reason, instead of waiting forever', async () => {
    const events: StreamEvent[] = [];
    const handle = openMcpStream(mcp({}), (event) => events.push(event));
    await expect.poll(() => events.length).toBeGreaterThan(0);
    handle.close();
    expect(events[0].type).toBe('error');
    expect((events[0].data as { message: string }).message).toMatch(SELF_SIGNED);
    // One error for the failed initialize, not a second from the transport.
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('connects with verifyTls: false', async () => {
    const event = await firstEvent((onEvent) => openMcpStream(mcp({ verifyTls: false }), onEvent), ['open', 'error']);
    expect(event).toMatchObject({ type: 'open', data: { serverInfo: { name: 'tls-mcp' } } });
  });
});

describe('gRPC over TLS', () => {
  const PROTO = `
    syntax = "proto3";
    package greeter;
    service Greeter { rpc SayHello (HelloRequest) returns (HelloReply); }
    message HelloRequest { string name = 1; }
    message HelloReply { string message = 1; }
  `;
  let grpcServer: grpc.Server;
  let grpcPort: number;

  beforeAll(async () => {
    const root = new Root();
    parse(PROTO, root, { keepCase: true });
    root.resolveAll();
    const method = root.lookupService('greeter.Greeter').methods.SayHello;
    const requestType: Type = method.resolvedRequestType!;
    const responseType: Type = method.resolvedResponseType!;
    grpcServer = new grpc.Server();
    grpcServer.addService(
      {
        SayHello: {
          path: '/greeter.Greeter/SayHello',
          requestStream: false,
          responseStream: false,
          requestSerialize: (v: Record<string, unknown>) => Buffer.from(requestType.encode(v).finish()),
          requestDeserialize: (buf: Buffer) => requestType.toObject(requestType.decode(buf)),
          responseSerialize: (v: Record<string, unknown>) => Buffer.from(responseType.encode(v).finish()),
          responseDeserialize: (buf: Buffer) => responseType.toObject(responseType.decode(buf)),
        },
      },
      {
        SayHello: (
          call: grpc.ServerUnaryCall<{ name: string }, { message: string }>,
          callback: grpc.sendUnaryData<{ message: string }>,
        ) => callback(null, { message: `Hello, ${call.request.name}!` }),
      },
    );
    const { key, cert } = await selfSignedCertificate();
    const credentials = grpc.ServerCredentials.createSsl(
      null,
      [{ private_key: Buffer.from(key), cert_chain: Buffer.from(cert) }],
      false,
    );
    grpcPort = await new Promise((resolve, reject) =>
      grpcServer.bindAsync('127.0.0.1:0', credentials, (error, port) => (error ? reject(error) : resolve(port))),
    );
  });

  afterAll(() => grpcServer.forceShutdown());

  const call = (overrides: Partial<RequestConfig>) =>
    config({
      protocol: 'grpc',
      url: `127.0.0.1:${grpcPort}`,
      protocolConfig: {
        protoFile: PROTO,
        serviceFullName: 'greeter.Greeter',
        methodName: 'SayHello',
        requestMessage: { name: 'TLS' },
        usePlaintext: false,
      },
      ...overrides,
    });

  it('refuses a self-signed certificate', async () => {
    const result = await executeGrpcUnaryCall(call({}));
    expect(result.status.code).toBe(grpc.status.UNAVAILABLE);
  });

  it('calls the method with verifyTls: false', async () => {
    const result = await executeGrpcUnaryCall(call({ verifyTls: false }));
    expect(result.status.code).toBe(grpc.status.OK);
    expect(result.message).toEqual({ message: 'Hello, TLS!' });
  });
});
