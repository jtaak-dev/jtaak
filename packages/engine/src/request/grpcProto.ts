import protobuf from 'protobufjs';
import type {
  GrpcFieldSummary,
  GrpcMessageSummary,
  GrpcMethodSummary,
  GrpcProtoSummary,
  GrpcServiceSummary,
} from '../types.js';

// protobufjs is CommonJS. Node's native ESM can't detect the named exports of
// every version it may resolve to (7.x exposes none), so take the exports
// object as the default import and destructure it.
const { Namespace, parse, Root, Service, Type } = protobuf;
type Namespace = InstanceType<typeof Namespace>;
type Root = InstanceType<typeof Root>;

// Split out of grpc.ts specifically so it stays importable from browser.ts:
// protobufjs is pure JS (no Node builtins), so browser-side code can parse
// a pasted .proto file locally and instantly, with no round-trip to a separate
// process — unlike grpc.ts's executeGrpcUnaryCall, which needs @grpc/grpc-js
// (Node's http2/net) and can only run in a Node process.

function stripLeadingDot(name: string): string {
  return name.startsWith('.') ? name.slice(1) : name;
}

// Keyed by the raw .proto text itself (no endpoint concept to key by, unlike
// GraphQL introspection) — cheap enough that even a large file is a fine Map
// key, and it naturally invalidates the moment the text changes.
const protoRootCache = new Map<string, Root>();

/**
 * Parses `.proto` source into a live protobufjs `Root`. Only a single
 * self-contained file is supported — `import` statements referencing other
 * files aren't resolved, since supporting the full multi-file resolution
 * graph is out of scope for now. Exported
 * (not just internal to parseGrpcProto) so grpc.ts's executeGrpcUnaryCall
 * can reuse the same cached parse instead of re-parsing.
 */
export function parseProtoRoot(protoFileContent: string, options: { forceRefresh?: boolean } = {}): Root {
  if (!options.forceRefresh) {
    const cached = protoRootCache.get(protoFileContent);
    if (cached) return cached;
  }

  const root = new Root();
  parse(protoFileContent, root, { keepCase: true });
  try {
    root.resolveAll();
  } catch (error) {
    throw new Error(
      `Failed to resolve proto definitions — cross-file "import" statements aren't supported yet, ` +
        `only a single self-contained .proto file: ${(error as Error).message}`,
      { cause: error },
    );
  }

  protoRootCache.set(protoFileContent, root);
  return root;
}

function walkNamespace(ns: Namespace, services: GrpcServiceSummary[], messages: GrpcMessageSummary[]): void {
  for (const nested of ns.nestedArray) {
    if (nested instanceof Service) {
      const methods: GrpcMethodSummary[] = nested.methodsArray.map((method) => ({
        name: method.name,
        requestType: stripLeadingDot(method.resolvedRequestType?.fullName ?? method.requestType),
        responseType: stripLeadingDot(method.resolvedResponseType?.fullName ?? method.responseType),
        requestStream: Boolean(method.requestStream),
        responseStream: Boolean(method.responseStream),
      }));
      services.push({ name: nested.name, fullName: stripLeadingDot(nested.fullName), methods });
    } else if (nested instanceof Type) {
      const fields: GrpcFieldSummary[] = nested.fieldsArray.map((field) => ({
        name: field.name,
        type: field.resolvedType ? stripLeadingDot(field.resolvedType.fullName) : field.type,
        repeated: field.repeated,
      }));
      messages.push({ name: stripLeadingDot(nested.fullName), fields });
      walkNamespace(nested, services, messages); // nested message types
    } else if (nested instanceof Namespace) {
      walkNamespace(nested, services, messages);
    }
  }
}

/**
 * Parses (and caches) a `.proto` file into a flattened summary of its
 * services/methods/messages, for the service/method browser and dynamic
 * request-form generation in a UI.
 */
export function parseGrpcProto(protoFileContent: string, options: { forceRefresh?: boolean } = {}): GrpcProtoSummary {
  const root = parseProtoRoot(protoFileContent, options);
  const services: GrpcServiceSummary[] = [];
  const messages: GrpcMessageSummary[] = [];
  walkNamespace(root, services, messages);
  return { services, messages };
}

/** Clears the cached parse for one proto file's text, or every one if omitted. */
export function clearGrpcProtoCache(protoFileContent?: string): void {
  if (protoFileContent) protoRootCache.delete(protoFileContent);
  else protoRootCache.clear();
}
