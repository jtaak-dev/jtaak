// Explicit named re-exports, not `export *`: under the CommonJS build,
// `export *` compiles to a runtime copy-loop that bundlers' static export
// analysis (Vite/esbuild's CJS interop) can't see through, which breaks
// named ESM imports of these values from bundled browser code. `export { X } from`
// compiles to a directly analyzable per-property getter instead.
export type {
  HttpMethod,
  KeyValue,
  RequestBody,
  AuthConfig,
  OAuth2Config,
  OAuth2GrantType,
  OAuth2Token,
  RequestConfig,
  ExecutedResponse,
  RequestTimingPhases,
  Protocol,
  StreamingProtocol,
  StreamEvent,
  StreamHandle,
  SseMessage,
  WebSocketProtocolConfig,
  WebSocketMessage,
  WebSocketConnection,
  GrpcProtocolConfig,
  GrpcFieldSummary,
  GrpcMessageSummary,
  GrpcMethodSummary,
  GrpcServiceSummary,
  GrpcProtoSummary,
  GrpcUnaryResult,
  MessagingProtocol,
  MessagingConnection,
  MessagingSubscription,
  MessagingPublish,
  MessagingPublishResult,
  MessagingMessage,
  MessagingStreamHandle,
  MqttProtocolConfig,
  SocketIoProtocolConfig,
  NatsProtocolConfig,
  AmqpProtocolConfig,
  KafkaProtocolConfig,
  McpTransportKind,
  McpProtocolConfig,
  McpServerInfo,
  McpInitializeResult,
  McpToolSummary,
  McpResourceSummary,
  McpPromptArgumentSummary,
  McpPromptSummary,
  McpContentBlock,
  McpToolCallResult,
  McpResourceContent,
  McpPromptMessage,
  McpPromptResult,
  McpServerConnection,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  GraphQlProtocolConfig,
  GraphQlFieldSummary,
  GraphQlTypeSummary,
  GraphQlSchemaSummary,
  VariableScope,
  Workspace,
  CollectionNodeKind,
  CollectionCategory,
  CollectionNode,
  SavedRequestSummary,
  SavedRequest,
  CollectionTreeNode,
  ConnectionTreeNode,
  Environment,
  AssertionResult,
  HistoryEntryInput,
  HistoryEntrySummary,
  HistoryEntry,
  HistoryQuery,
  ScriptLogEntry,
  RequestRunResult,
  CollectionRunItemResult,
  CollectionRunReport,
  ImportResult,
  CodegenLanguage,
  ExportScope,
  NativeExportItem,
  NativeExportFolder,
  NativeExportCollection,
  NativeExportEnvironment,
  NativeExportDocument,
  NativeExportTarget,
  NativeExportOptions,
  NativeImportPreview,
  NativeImportOptions,
  NativeImportResult,
  EngineProfile,
  EnvironmentUpdates,
} from './types.js';
export { emptyScopes, DEFAULT_ENGINE_PROFILE, NATIVE_EXPORT_VERSION, MESSAGING_PROTOCOLS } from './types.js';

export { executeRequest, buildRequestHeaders, type ExecuteOptions } from './request/executor.js';
export { openStream } from './request/streamExecutor.js';
export type { McpStreamHandle } from './request/mcp.js';

export type { FetchGraphQlSchemaOptions } from './graphql/introspection.js';
export { fetchGraphQlSchema, clearGraphQlSchemaCache } from './graphql/introspection.js';

export { parseGrpcProto, clearGrpcProtoCache } from './request/grpcProto.js';
export { executeGrpcUnaryCall } from './request/grpc.js';

export { resolveVariables, resolveDeep } from './variables/resolver.js';
export { parseSetCookie, type SetCookie } from './request/cookies.js';
export { CookieJar, type CookieKey, type StoredCookie } from './request/cookieJar.js';
export { parseDigestChallenge, digestAuthorization, type DigestChallenge, type DigestInput } from './request/digest.js';
export {
  MemoryOAuth2TokenStore,
  oauth2TokenKey,
  isOAuth2TokenValid,
  createPkce,
  buildAuthorizationUrl,
  fetchClientCredentialsToken,
  fetchPasswordToken,
  refreshOAuth2Token,
  authorizeInBrowser,
  getOAuth2Token,
  type OAuth2TokenStore,
  type OAuth2RequestOptions,
  type BrowserAuthorizationOptions,
  type GetOAuth2TokenOptions,
} from './request/oauth2.js';
export { sqliteOAuth2TokenStore, clearOAuth2Tokens } from './storage/oauth2Tokens.js';
export {
  listCookies,
  saveCookie,
  deleteCookie,
  clearCookies,
  loadCookieJar,
  saveCookieJar,
} from './storage/cookies.js';
export { applyEnvironmentUpdates, diffEnvironment } from './variables/environmentUpdates.js';

export type { ScriptContext, ScriptCookie } from './scripting/sandbox.js';
export { preloadScriptEngine, runScript } from './scripting/sandbox.js';
export { runRequestWithScripts, type RunRequestOptions } from './scripting/runRequest.js';

export type { RunnableRequest } from './runner/collectionRunner.js';
export { runCollection, type RunCollectionOptions } from './runner/collectionRunner.js';
export {
  runnableRequestsFromExport,
  type ExportedRequest,
  type ExportRequestSelection,
} from './runner/exportRunner.js';
export { junitReport, type JunitOptions } from './runner/junit.js';

export { CODEGEN_LANGUAGES, generateSnippet } from './codegen/snippets.js';

export { parseCurlCommand } from './import/curl.js';
export { importPostmanCollection } from './import/postmanCollection.js';
export { importPostmanEnvironment } from './import/postmanEnvironment.js';
export { importOpenApi } from './import/openApi.js';
export { exportNative, serializeNativeExport, isSecretName } from './export/nativeExport.js';
export { importNative, isNativeExport, previewNativeImport, validateNativeExport } from './import/nativeImport.js';

export { openDatabase } from './storage/db.js';
export { DatabaseTooNewError, schemaVersion } from './storage/migrations.js';
export {
  DEFAULT_HISTORY_BODY_LIMIT,
  addHistoryEntry,
  listHistory,
  getHistoryEntry,
  deleteHistoryEntry,
  clearHistory,
  pruneHistory,
} from './storage/history.js';

export {
  listWorkspaces,
  createWorkspace,
  getOrCreateDefaultWorkspace,
  createCollectionNode,
  renameCollectionNode,
  deleteCollectionNode,
  moveCollectionNode,
  reorderCollectionNodes,
  createRequest,
  updateRequest,
  deleteRequest,
  getRequest,
  renameRequest,
  moveRequest,
  reorderRequests,
  listRequestsForNode,
  listEnvironments,
  getEnvironment,
  createEnvironment,
  renameEnvironment,
  updateEnvironmentVariables,
  deleteEnvironment,
  getCollectionTree,
  getWebSocketTree,
  getMcpTree,
  listWebSocketConnections,
  getWebSocketConnection,
  createWebSocketConnection,
  renameWebSocketConnection,
  updateWebSocketConnection,
  deleteWebSocketConnection,
  moveWebSocketConnection,
  reorderWebSocketConnections,
  listMcpServerConnections,
  getMcpServerConnection,
  createMcpServerConnection,
  renameMcpServerConnection,
  updateMcpServerConnection,
  deleteMcpServerConnection,
  moveMcpServerConnection,
  reorderMcpServerConnections,
  getMessagingTree,
  listMessagingConnections,
  getMessagingConnection,
  createMessagingConnection,
  renameMessagingConnection,
  updateMessagingConnection,
  deleteMessagingConnection,
  moveMessagingConnection,
  reorderMessagingConnections,
  COLLECTION_CATEGORIES,
} from './storage/repository.js';
