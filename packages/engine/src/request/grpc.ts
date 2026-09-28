import * as grpc from '@grpc/grpc-js';
import { performance } from 'node:perf_hooks';
import { buildRequestHeaders } from './executor.js';
import { grpcRoot } from './grpcProto.js';
import { verifiesTls } from './tls.js';
import type { GrpcProtocolConfig, GrpcUnaryResult, RequestConfig } from '../types.js';

export function metadataToRecord(metadata: grpc.Metadata): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata.getMap())) {
    record[key] = typeof value === 'string' ? value : value.toString();
  }
  return record;
}

// grpcurl/BloomRPC/etc. all address a gRPC server as a plain host:port, no
// scheme — accepting an optional grpc:// prefix is just a UX nicety for
// anyone who types it out of http:// habit.
export function normalizeGrpcTarget(url: string): string {
  return url.replace(/^grpc:\/\//i, '').replace(/\/+$/, '');
}

/** What a call needs, for a unary call or a stream: the method, its (de)serializers, a client and the metadata. */
export function prepareGrpcCall(config: RequestConfig) {
  const protocolConfig = config.protocolConfig as GrpcProtocolConfig | undefined;
  if (!protocolConfig) {
    throw new Error('gRPC calls need protocolConfig: { protoFile, serviceFullName, methodName, requestMessage }.');
  }

  const root = grpcRoot(protocolConfig);
  const service = root.lookupService(protocolConfig.serviceFullName);
  const method = service.methods[protocolConfig.methodName];
  if (!method) {
    throw new Error(`Method "${protocolConfig.methodName}" not found on service "${protocolConfig.serviceFullName}".`);
  }

  const requestType = method.resolvedRequestType!;
  const responseType = method.resolvedResponseType!;
  /** Why a message can't be sent as the request type, or undefined when it can. */
  const invalid = (message: unknown): string | undefined => {
    const error = requestType.verify(message as Record<string, unknown>);
    return error ? `Invalid request message for ${requestType.fullName.replace(/^\./, '')}: ${error}` : undefined;
  };
  const serialize = (value: Record<string, unknown>): Buffer =>
    Buffer.from(requestType.encode(requestType.fromObject(value)).finish());
  const deserialize = (value: Buffer): Record<string, unknown> =>
    responseType.toObject(responseType.decode(value), { longs: String, enums: String, defaults: true });

  const target = normalizeGrpcTarget(config.url);
  const credentials =
    protocolConfig.usePlaintext === false
      ? grpc.credentials.createSsl(null, null, null, { rejectUnauthorized: verifiesTls(config) })
      : grpc.credentials.createInsecure();
  const client = new grpc.Client(target, credentials);

  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(buildRequestHeaders(config))) {
    metadata.set(key, value);
  }

  return {
    protocolConfig,
    method,
    kind: method.requestStream
      ? method.responseStream
        ? ('bidi' as const)
        : ('client' as const)
      : method.responseStream
        ? ('server' as const)
        : ('unary' as const),
    methodPath: `/${service.fullName.replace(/^\./, '')}/${method.name}`,
    invalid,
    serialize,
    deserialize,
    client,
    metadata,
  };
}

/**
 * Executes a unary gRPC call. Streaming methods (`requestStream`/
 * `responseStream`) are rejected here; `openStream` (streamExecutor.ts) is where they'll eventually route,
 * the same as WebSocket/SSE, once that lands.
 *
 * Builds the client dynamically from the parsed proto's reflection types
 * (protobufjs `Type.encode`/`decode`) rather than going through
 * `@grpc/proto-loader`'s generated-client path — this is the same approach
 * dynamic/reflection-based gRPC clients (BloomRPC, Postman's own gRPC
 * support) use, and it's what lets a single self-contained `.proto` file be
 * enough without a code-generation step.
 */
export async function executeGrpcUnaryCall(config: RequestConfig): Promise<GrpcUnaryResult> {
  const { protocolConfig, method, kind, methodPath, invalid, serialize, deserialize, client, metadata } =
    prepareGrpcCall(config);
  if (kind !== 'unary') {
    client.close();
    throw new Error(`"${method.name}" is a streaming method: open it with openStream instead.`);
  }
  const verifyError = invalid(protocolConfig.requestMessage);
  if (verifyError) {
    client.close();
    throw new Error(verifyError);
  }

  const start = performance.now();

  return new Promise((resolve) => {
    let trailerMetadata: grpc.Metadata | undefined;

    client
      .makeUnaryRequest(
        methodPath,
        serialize,
        deserialize,
        protocolConfig.requestMessage,
        metadata,
        {},
        (error, value) => {
          const end = performance.now();
          client.close();
          const timings = { start, end, durationMs: end - start };
          const trailers = trailerMetadata ? metadataToRecord(trailerMetadata) : {};

          if (error) {
            resolve({
              status: { code: error.code ?? grpc.status.UNKNOWN, details: error.details ?? error.message },
              metadata: trailers,
              timings,
            });
            return;
          }
          resolve({ status: { code: grpc.status.OK, details: 'OK' }, message: value, metadata: trailers, timings });
        },
      )
      .on('status', (status) => {
        trailerMetadata = status.metadata;
      });
  });
}
