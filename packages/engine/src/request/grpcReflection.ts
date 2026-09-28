import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import descriptor from 'protobufjs/ext/descriptor.js';
import { buildRequestHeaders } from './executor.js';
import { grpcClient } from './grpc.js';
import { describeError } from './errors.js';
import type { RequestConfig } from '../types.js';

// protobufjs is CommonJS (see grpcProto.ts): take the exports object and destructure it.
const { parse, Root } = protobuf;

/** The server reflection protocol (grpc/reflection/v1/reflection.proto), minus what isn't used. */
const reflectionProto = (pkg: string) => `
syntax = "proto3";
package ${pkg};
service ServerReflection {
  rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse);
}
message ServerReflectionRequest {
  string host = 1;
  oneof message_request {
    string file_by_filename = 3;
    string file_containing_symbol = 4;
    string list_services = 7;
  }
}
message ServerReflectionResponse {
  string valid_host = 1;
  ServerReflectionRequest original_request = 2;
  oneof message_response {
    FileDescriptorResponse file_descriptor_response = 4;
    ListServiceResponse list_services_response = 6;
    ErrorResponse error_response = 7;
  }
}
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

// v1 is the current package; many servers still offer only v1alpha, which is the same protocol.
const PACKAGES = ['grpc.reflection.v1', 'grpc.reflection.v1alpha'];

interface ReflectionResponse {
  fileDescriptorResponse?: { fileDescriptorProto: Uint8Array[] };
  listServicesResponse?: { service: Array<{ name: string }> };
  errorResponse?: { errorCode: number; errorMessage: string };
}

export interface GrpcReflectionResult {
  /** protobufjs JSON of every service and message the server described: `GrpcProtocolConfig.reflectedSchema`. */
  schema: Record<string, unknown>;
  /** The services it offers, fully qualified, without the reflection service itself. */
  services: string[];
}

/** One ServerReflectionInfo call on one package: answers each request in order. */
async function reflectWith(
  pkg: string,
  client: grpc.Client,
  metadata: grpc.Metadata,
  timeoutMs: number,
): Promise<GrpcReflectionResult> {
  const root = new Root();
  parse(reflectionProto(pkg), root, { keepCase: false });
  root.resolveAll();
  const requestType = root.lookupType(`${pkg}.ServerReflectionRequest`);
  const responseType = root.lookupType(`${pkg}.ServerReflectionResponse`);

  const call = client.makeBidiStreamRequest(
    `/${pkg}.ServerReflection/ServerReflectionInfo`,
    (value: Record<string, unknown>) => Buffer.from(requestType.encode(requestType.fromObject(value)).finish()),
    (bytes: Buffer) => responseType.toObject(responseType.decode(bytes), { bytes: Array }) as ReflectionResponse,
    metadata,
    { deadline: Date.now() + timeoutMs },
  );
  const waiting: Array<{ resolve: (r: ReflectionResponse) => void; reject: (e: Error) => void }> = [];
  let failure: Error | undefined;
  call.on('data', (response: ReflectionResponse) => waiting.shift()?.resolve(response));
  call.on('error', (error: grpc.ServiceError) => {
    failure = error;
    for (const pending of waiting.splice(0)) pending.reject(error);
  });
  const ask = (request: Record<string, unknown>) =>
    new Promise<ReflectionResponse>((resolve, reject) => {
      if (failure) return reject(failure);
      waiting.push({ resolve, reject });
      call.write(request);
    });

  try {
    const listed = await ask({ listServices: '' });
    if (listed.errorResponse) throw new Error(listed.errorResponse.errorMessage);
    const services = (listed.listServicesResponse?.service ?? [])
      .map((service) => service.name)
      .filter((name) => !name.startsWith('grpc.reflection.'));

    // Each service's file, then every file those depend on (descriptor.proto's well-known types included).
    const files = new Map<string, Uint8Array>();
    const addFiles = (response: ReflectionResponse) => {
      if (response.errorResponse) throw new Error(response.errorResponse.errorMessage);
      for (const bytes of response.fileDescriptorResponse?.fileDescriptorProto ?? []) {
        const file = descriptor.FileDescriptorProto.decode(bytes) as unknown as { name: string };
        if (!files.has(file.name)) files.set(file.name, bytes);
      }
    };
    for (const service of services) addFiles(await ask({ fileContainingSymbol: service }));
    for (let missing = neededFiles(files); missing.length > 0; missing = neededFiles(files)) {
      for (const name of missing) {
        const response = await ask({ fileByFilename: name });
        // A file the server can't give (a well-known type it didn't register, say) is left out.
        if (response.errorResponse) files.set(name, new Uint8Array());
        else addFiles(response);
      }
    }
    call.end();

    const set = descriptor.FileDescriptorSet.fromObject({
      file: [...files.values()]
        .filter((bytes) => bytes.length > 0)
        .map((bytes) => descriptor.FileDescriptorProto.decode(bytes)),
    });
    const described = Root.fromDescriptor(descriptor.FileDescriptorSet.encode(set).finish());
    described.resolveAll();
    return { schema: described.toJSON() as Record<string, unknown>, services };
  } finally {
    call.cancel();
  }
}

/** Files the collected ones import that aren't collected yet. */
function neededFiles(files: Map<string, Uint8Array>): string[] {
  const needed = new Set<string>();
  for (const bytes of files.values()) {
    if (bytes.length === 0) continue;
    const file = descriptor.FileDescriptorProto.decode(bytes) as unknown as { dependency?: string[] };
    for (const dependency of file.dependency ?? []) if (!files.has(dependency)) needed.add(dependency);
  }
  return [...needed];
}

/**
 * Asks a gRPC server what it offers, through its reflection service (v1,
 * or v1alpha for older servers), so its methods can be called without a
 * `.proto` file. The result's `schema` goes in `GrpcProtocolConfig.reflectedSchema`
 * with `source: 'reflection'`.
 */
export async function reflectGrpcServer(
  config: Pick<RequestConfig, 'url' | 'headers' | 'auth' | 'verifyTls' | 'network' | 'protocolConfig'>,
  options: { timeoutMs?: number } = {},
): Promise<GrpcReflectionResult> {
  const client = grpcClient(config);
  const metadata = new grpc.Metadata();
  for (const [key, value] of Object.entries(
    buildRequestHeaders({ ...config, id: '', name: '', method: 'POST', params: [], body: { mode: 'none' } }),
  )) {
    metadata.set(key, value);
  }
  try {
    let lastError: unknown;
    for (const pkg of PACKAGES) {
      try {
        return await reflectWith(pkg, client, metadata, options.timeoutMs ?? 10_000);
      } catch (error) {
        lastError = error;
        // Only a server without this package's service is worth trying the next one on.
        if ((error as grpc.ServiceError).code !== grpc.status.UNIMPLEMENTED) break;
      }
    }
    const code = (lastError as grpc.ServiceError).code;
    if (code === grpc.status.UNIMPLEMENTED) {
      throw new Error("This server doesn't offer gRPC server reflection; paste its .proto file instead.");
    }
    throw new Error(`Server reflection failed: ${describeError(lastError)}`, { cause: lastError });
  } finally {
    client.close();
  }
}
