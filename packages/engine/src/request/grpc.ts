import * as grpc from '@grpc/grpc-js';
import { performance } from 'node:perf_hooks';
import { buildRequestHeaders } from './executor.js';
import { parseProtoRoot } from './grpcProto.js';
import { verifiesTls } from './tls.js';
import type { GrpcProtocolConfig, GrpcUnaryResult, RequestConfig } from '../types.js';

function metadataToRecord(metadata: grpc.Metadata): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata.getMap())) {
    record[key] = typeof value === 'string' ? value : value.toString();
  }
  return record;
}

// grpcurl/BloomRPC/etc. all address a gRPC server as a plain host:port, no
// scheme — accepting an optional grpc:// prefix is just a UX nicety for
// anyone who types it out of http:// habit.
function normalizeGrpcTarget(url: string): string {
  return url.replace(/^grpc:\/\//i, '').replace(/\/+$/, '');
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
  const protocolConfig = config.protocolConfig as GrpcProtocolConfig | undefined;
  if (!protocolConfig) {
    throw new Error('gRPC calls need protocolConfig: { protoFile, serviceFullName, methodName, requestMessage }.');
  }

  const root = parseProtoRoot(protocolConfig.protoFile);
  const service = root.lookupService(protocolConfig.serviceFullName);
  const method = service.methods[protocolConfig.methodName];
  if (!method) {
    throw new Error(`Method "${protocolConfig.methodName}" not found on service "${protocolConfig.serviceFullName}".`);
  }
  if (method.requestStream || method.responseStream) {
    throw new Error(
      `"${method.name}" is a streaming method (requestStream=${Boolean(method.requestStream)}, ` +
        `responseStream=${Boolean(method.responseStream)}) — only unary calls are supported so far.`,
    );
  }

  const requestType = method.resolvedRequestType!;
  const responseType = method.resolvedResponseType!;

  const verifyError = requestType.verify(protocolConfig.requestMessage);
  if (verifyError) throw new Error(`Invalid request message for ${requestType.fullName}: ${verifyError}`);

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

  const methodPath = `/${service.fullName.replace(/^\./, '')}/${method.name}`;
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
