// A second, deliberately narrow entry point: import from
// '@jtaak/engine/browser' (not the package root) when bundling for a
// browser context (such as a UI renderer). It re-exports only the parts of the engine
// that touch no Node builtins and no native modules (types + the variable
// resolver) — the storage layer (better-sqlite3, node:fs) and the request
// executor (node:perf_hooks) stay out, so a bundler never has to externalize
// Node builtins into browser code that can't actually run there.
export type {
  HttpMethod,
  FormField,
  KeyValue,
  RequestBody,
  AuthConfig,
  OAuth2Config,
  OAuth2GrantType,
  OAuth2Token,
  ClientCertificate,
  NetworkSettings,
  ProxyConfig,
  RequestConfig,
  ExecutedResponse,
  RequestTimingPhases,
  AssertionResult,
  HistoryEntrySummary,
  HistoryEntry,
  HistoryQuery,
  VariableScope,
  CodegenLanguage,
  GrpcProtocolConfig,
  SoapProtocolConfig,
  GrpcStreamMessage,
  GrpcStreamStatus,
  GrpcFieldSummary,
  GrpcMessageSummary,
  GrpcMethodSummary,
  GrpcServiceSummary,
  GrpcProtoSummary,
  EnvironmentUpdates,
  MessagingProtocol,
  MessagingConnection,
  MessagingSubscription,
  MessagingPublish,
  MessagingMessage,
  MqttProtocolConfig,
  SocketIoProtocolConfig,
  NatsProtocolConfig,
  AmqpProtocolConfig,
  KafkaProtocolConfig,
} from './types.js';
export { emptyScopes, MESSAGING_PROTOCOLS } from './types.js';

export { resolveVariables, resolveDeep, findVariables, type VariableReference } from './variables/resolver.js';
export { parseSetCookie, type SetCookie } from './request/cookies.js';
export {
  soapAsHttp,
  soapEnvelopeTemplate,
  parseSoapFault,
  SOAP_ENVELOPE_NAMESPACES,
  type SoapFault,
} from './request/soap.js';
export { junitReport, type JunitOptions } from './runner/junit.js';
export { CookieJar, type CookieKey, type StoredCookie } from './request/cookieJar.js';
export { applyEnvironmentUpdates, diffEnvironment } from './variables/environmentUpdates.js';

export { CODEGEN_LANGUAGES, generateSnippet } from './codegen/snippets.js';
export { parseCurlCommand } from './import/curl.js';

// protobufjs (unlike @grpc/grpc-js, which grpc.ts needs for the actual call)
// is pure JS — parsing a pasted .proto file can happen locally in
// browser-side code with no round-trip to a separate process. See grpcProto.ts's own comment for why
// this is split out of grpc.ts.
export { parseGrpcProto, clearGrpcProtoCache, summarizeGrpcSchema } from './request/grpcProto.js';
