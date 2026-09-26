import { afterEach, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { Root, parse, type Type } from 'protobufjs';
import { executeGrpcUnaryCall } from './grpc';
import type { RequestConfig } from '../types';

const GREETER_PROTO = `
syntax = "proto3";
package greeter;

service Greeter {
  rpc SayHello (HelloRequest) returns (HelloReply);
  rpc StreamGreetings (HelloRequest) returns (stream HelloReply);
}

message HelloRequest {
  string name = 1;
}

message HelloReply {
  string message = 1;
}
`;

let server: grpc.Server | undefined;
let port: number;
let lastCallMetadata: grpc.Metadata | undefined;
let replyBehavior: 'echo' | 'not-found' = 'echo';

/** A minimal, hand-built ServiceDefinition — the same dynamic protobufjs-based
 * (de)serialization approach grpc.ts itself uses, just wired up as a server
 * instead of a client, so this test doesn't depend on generated code either. */
async function startGreeterServer(): Promise<number> {
  const root = new Root();
  parse(GREETER_PROTO, root, { keepCase: true });
  root.resolveAll();
  const service = root.lookupService('greeter.Greeter');
  const requestType: Type = service.methods.SayHello.resolvedRequestType!;
  const responseType: Type = service.methods.SayHello.resolvedResponseType!;

  const serviceDef: grpc.ServiceDefinition = {
    SayHello: {
      path: '/greeter.Greeter/SayHello',
      requestStream: false,
      responseStream: false,
      requestSerialize: (v: Record<string, unknown>) =>
        Buffer.from(requestType.encode(requestType.fromObject(v)).finish()),
      requestDeserialize: (buf: Buffer) => requestType.toObject(requestType.decode(buf), { defaults: true }),
      responseSerialize: (v: Record<string, unknown>) =>
        Buffer.from(responseType.encode(responseType.fromObject(v)).finish()),
      responseDeserialize: (buf: Buffer) => responseType.toObject(responseType.decode(buf), { defaults: true }),
    },
  };

  server = new grpc.Server();
  server.addService(serviceDef, {
    SayHello: (
      call: grpc.ServerUnaryCall<{ name: string }, { message: string }>,
      callback: grpc.sendUnaryData<{ message: string }>,
    ) => {
      lastCallMetadata = call.metadata;
      if (replyBehavior === 'not-found') {
        callback({
          code: grpc.status.NOT_FOUND,
          details: `No greeting found for "${call.request.name}"`,
        } as grpc.ServiceError);
        return;
      }
      callback(null, { message: `Hello, ${call.request.name}!` });
    },
  });

  return new Promise((resolve, reject) => {
    server!.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve(boundPort);
    });
  });
}

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'grpc request',
    protocol: 'grpc',
    method: 'GET',
    url: `127.0.0.1:${port}`,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    protocolConfig: {
      protoFile: GREETER_PROTO,
      serviceFullName: 'greeter.Greeter',
      methodName: 'SayHello',
      requestMessage: { name: 'World' },
    },
    ...overrides,
  };
}

afterEach(async () => {
  replyBehavior = 'echo';
  lastCallMetadata = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.tryShutdown(() => resolve()));
    server = undefined;
  }
});

describe('executeGrpcUnaryCall', () => {
  it('calls a unary method and returns the decoded response with OK status', async () => {
    port = await startGreeterServer();
    const result = await executeGrpcUnaryCall(baseConfig());

    expect(result.status).toEqual({ code: grpc.status.OK, details: 'OK' });
    expect(result.message).toEqual({ message: 'Hello, World!' });
    expect(result.timings.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends Authorization/custom headers as gRPC metadata', async () => {
    port = await startGreeterServer();
    await executeGrpcUnaryCall(
      baseConfig({
        auth: { type: 'bearer', bearer: { token: 'abc123' } },
        headers: [{ key: 'x-test', value: '1', enabled: true }],
      }),
    );

    expect(lastCallMetadata?.get('authorization')).toEqual(['Bearer abc123']);
    expect(lastCallMetadata?.get('x-test')).toEqual(['1']);
  });

  it('resolves (not throws) with the server-reported status on a non-OK response', async () => {
    port = await startGreeterServer();
    replyBehavior = 'not-found';
    const result = await executeGrpcUnaryCall(baseConfig());

    expect(result.status.code).toBe(grpc.status.NOT_FOUND);
    expect(result.status.details).toContain('World');
    expect(result.message).toBeUndefined();
  });

  it('rejects a streaming method instead of attempting a unary call', async () => {
    port = await startGreeterServer();
    await expect(
      executeGrpcUnaryCall(
        baseConfig({ protocolConfig: { ...baseConfig().protocolConfig, methodName: 'StreamGreetings' } }),
      ),
    ).rejects.toThrow(/streaming method/);
  });

  it('throws a clear error for an unknown method name', async () => {
    port = await startGreeterServer();
    await expect(
      executeGrpcUnaryCall(
        baseConfig({ protocolConfig: { ...baseConfig().protocolConfig, methodName: 'DoesNotExist' } }),
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('performance budget: unary call overhead', () => {
  it('completes a local unary call with overhead comparable to the HTTP budget', async () => {
    port = await startGreeterServer();
    const iterations = 10;
    const warmup = 2;
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const result = await executeGrpcUnaryCall(baseConfig());
      if (i >= warmup) samples.push(result.timings.durationMs);
    }

    // gRPC's HTTP/2 framing plus protobuf encode/decode is inherently
    // heavier than a plain HTTP GET, so this is a generous multiple of the
    // HTTP budget (<5ms) rather than the same number — "comparable
    // order of magnitude," not identical.
    const best = Math.min(...samples);
    expect(best).toBeLessThan(25);
  });
});
