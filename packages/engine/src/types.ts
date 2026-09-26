// Core data types shared by host applications, the CLI, and (later) any
// backend sync service. Nothing in this package may import UI-framework or DOM
// APIs — see the README for why that boundary matters.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Every wire protocol the request builder can target. `http` is the only one
 * `executeRequest` (request/executor.ts) currently implements; `websocket`,
 * `sse`, `grpc`, and `mcp` are streaming protocols routed through
 * `openStream` (request/streamExecutor.ts) instead, once each is
 * implemented. `graphql` and `soap` stay one-shot, riding the same HTTP
 * transport as `http` once they land.
 */
export type Protocol = 'http' | 'graphql' | 'websocket' | 'sse' | 'grpc' | 'mcp' | 'soap';

/** The subset of `Protocol` that doesn't fit a single awaited request/response
 * and is routed through `openStream` instead of `executeRequest`. */
export type StreamingProtocol = 'websocket' | 'sse' | 'grpc' | 'mcp';

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export interface RequestBody {
  mode: 'none' | 'raw' | 'json' | 'form-data' | 'urlencoded' | 'binary';
  raw?: string;
  formData?: KeyValue[];
  binaryPath?: string;
}

export interface AuthConfig {
  type: 'none' | 'basic' | 'bearer' | 'apiKey';
  basic?: { username: string; password: string };
  bearer?: { token: string };
  apiKey?: { key: string; value: string; addTo: 'header' | 'query' };
}

export interface RequestConfig {
  id: string;
  name: string;
  /** Defaults to `'http'` when absent — every request saved in older versions predates
   * this field, so callers must not assume it's set. */
  protocol?: Protocol;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: RequestBody;
  auth: AuthConfig;
  preRequestScript?: string;
  testScript?: string;
  /** Payload specific to `protocol` (e.g. a GraphQL query/variables, gRPC
   * service/method) — shape is owned by each protocol; `http`
   * doesn't use it since `method`/`url`/`body`/`auth` above already cover it.
   * Widened to the protocol-specific type (e.g. `GraphQlProtocolConfig`) as
   * each protocol adds its own shape. */
  protocolConfig?:
    Record<string, unknown> | GraphQlProtocolConfig | WebSocketProtocolConfig | GrpcProtocolConfig | McpProtocolConfig;
}

/** `protocolConfig` shape for `protocol: 'graphql'` — POSTed as
 * `{ query, variables, operationName }` over the same HTTP transport
 * `executeRequest` already uses (see request/executor.ts); `method`/`body`
 * on `RequestConfig` are ignored for this protocol. */
export interface GraphQlProtocolConfig {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** One field on a GraphQL type, as surfaced by introspection — `typeName` is
 * already unwrapped/formatted (e.g. `[User!]!`) so a UI doesn't need to
 * walk `NON_NULL`/`LIST` wrappers itself. */
export interface GraphQlFieldSummary {
  name: string;
  description?: string;
  typeName: string;
}

export interface GraphQlTypeSummary {
  name: string;
  kind: string;
  description?: string;
  fields: GraphQlFieldSummary[];
}

/** Normalized result of introspecting a GraphQL endpoint (see
 * graphql/introspection.ts) — introspection's own `__`-prefixed meta-types
 * are dropped since they're never useful to autocomplete against. */
export interface GraphQlSchemaSummary {
  queryType?: string;
  mutationType?: string;
  subscriptionType?: string;
  types: GraphQlTypeSummary[];
  fetchedAt: number;
}

export interface ExecutedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timings: {
    start: number;
    end: number;
    durationMs: number;
  };
  sizeBytes: number;
}

/** One event pushed by an open protocol connection (`openStream` in
 * request/streamExecutor.ts) — a WebSocket frame, an SSE event, a gRPC
 * stream message, or an MCP notification, all normalized to one shape so a
 * host application and its UI don't need a separate event type per protocol. */
export interface StreamEvent {
  type: 'open' | 'message' | 'error' | 'close';
  data?: unknown;
  timestamp: number;
}

/** Handle to an open protocol connection. `send` is absent for receive-only
 * protocols (e.g. SSE); `close` always tears the connection down. */
export interface StreamHandle {
  send?: (data: unknown) => void;
  close: () => void;
}

/** The `data` payload of a `StreamEvent` whose `type` is `'message'` when
 * `protocol` is `'sse'` — one dispatched `text/event-stream` message (see
 * request/sse.ts). `event` defaults to `'message'` per the SSE spec when the
 * server doesn't send an explicit `event:` field. */
export interface SseMessage {
  event?: string;
  data: string;
  id?: string;
}

/** `protocolConfig` shape for `protocol: 'websocket'` — the WHATWG
 * WebSocket constructor has no `headers` option (a browser-security
 * limitation Node's `ws` client isn't bound by), so `RequestConfig.headers`/
 * `auth` above cover the handshake's headers and this only needs to carry
 * `Sec-WebSocket-Protocol` subprotocol offers. */
export interface WebSocketProtocolConfig {
  subprotocols?: string[];
}

/** The `data` payload of a `StreamEvent` whose `type` is `'message'` when
 * `protocol` is `'websocket'` (see request/websocket.ts). Binary frames are
 * base64-encoded into `data` with `isBinary: true` so a UI and its host
 * process only ever handle strings. */
export interface WebSocketMessage {
  data: string;
  isBinary: boolean;
  /** `'sent'` for a frame this client sent via `StreamHandle.send`, `'received'`
   * for one that arrived from the server — the timeline needs this to render
   * a direction, which a raw `ws` message event doesn't carry on its own. */
  direction: 'sent' | 'received';
}

/**
 * A saved WebSocket endpoint — deliberately not a `RequestConfig`/
 * `SavedRequest`: a connection is a persistent session with its own message
 * history, not something with a body, scripts, or a single response, so it
 * gets its own storage entity rather than overloading the request model. It
 * still lives in a collection/folder hierarchy of its own ('websocket'
 * category, see `CollectionCategory`).
 * Opening one still builds a `RequestConfig`-shaped object at connect time
 * to hand to `openStream`, since that's the one runtime contract every
 * protocol shares (see request/streamExecutor.ts).
 */
export interface WebSocketConnection {
  id: string;
  workspaceId: string;
  /** The 'websocket'-category collection/folder holding this connection. */
  collectionId: string;
  sortOrder: number;
  name: string;
  url: string;
  headers: KeyValue[];
  subprotocols: string[];
  auth: AuthConfig;
  createdAt: number;
  updatedAt: number;
}

/**
 * `protocolConfig` shape for `protocol: 'grpc'` — `RequestConfig.url` holds
 * the plain `host:port` target (no scheme; that's how grpcurl/BloomRPC/etc.
 * address a gRPC server too), `headers`/`auth` become call metadata, and
 * everything gRPC-specific lives here. Only unary calls are wired up so far
 * (see request/grpc.ts) — `requestStream`/`responseStream` methods are
 * listed by `parseGrpcProto` but rejected by `executeGrpcUnaryCall`.
 */
export interface GrpcProtocolConfig {
  /** Raw `.proto` source text — a single self-contained file; cross-file
   * `import` statements aren't resolved (see request/grpc.ts). */
  protoFile: string;
  /** Fully-qualified service name, e.g. `"greeter.Greeter"`. */
  serviceFullName: string;
  methodName: string;
  requestMessage: Record<string, unknown>;
  /** Defaults to `true` — plaintext (no TLS), matching grpcurl's `-plaintext`
   * default for the local/dev servers this tool is most often pointed at. */
  usePlaintext?: boolean;
}

/** One field on a gRPC message, as surfaced by `parseGrpcProto` — `type` is
 * either a protobuf scalar keyword (`string`, `int32`, `bool`, ...) or
 * another message/enum's full name; a UI can treat scalars as a plain input
 * and anything else as a nested JSON sub-editor. */
export interface GrpcFieldSummary {
  name: string;
  type: string;
  repeated: boolean;
}

export interface GrpcMessageSummary {
  /** Fully-qualified message name, e.g. `"greeter.HelloRequest"`. */
  name: string;
  fields: GrpcFieldSummary[];
}

export interface GrpcMethodSummary {
  name: string;
  requestType: string;
  responseType: string;
  requestStream: boolean;
  responseStream: boolean;
}

export interface GrpcServiceSummary {
  name: string;
  /** Fully-qualified, e.g. `"greeter.Greeter"` — what `serviceFullName` in
   * `GrpcProtocolConfig` and `executeGrpcUnaryCall` expect. */
  fullName: string;
  methods: GrpcMethodSummary[];
}

/** Parsed `.proto` file, flattened for browsing and dynamic form generation
 * (see request/grpc.ts's `parseGrpcProto`) — `messages` includes every
 * message type in the file (top-level and nested), keyed by full name so a
 * method's `requestType`/`responseType` can be looked up directly. */
export interface GrpcProtoSummary {
  services: GrpcServiceSummary[];
  messages: GrpcMessageSummary[];
}

/** Result of a unary gRPC call (see request/grpc.ts's `executeGrpcUnaryCall`).
 * `message` is absent when `status.code` isn't OK (0) — mirrors how
 * `RequestRunResult.response` is absent on a failed send, rather than
 * throwing, since a non-OK status is a normal, inspectable outcome. */
export interface GrpcUnaryResult {
  status: { code: number; details: string };
  message?: Record<string, unknown>;
  /** Trailer metadata the server returned. */
  metadata: Record<string, string>;
  timings: { start: number; end: number; durationMs: number };
}

// ---- MCP (Model Context Protocol) --------------------------------------

/** JSON-RPC 2.0 message shapes — the wire format MCP itself is built on
 * (see mcp/jsonRpc.ts). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type McpTransportKind = 'stdio' | 'http';

/**
 * `protocolConfig` shape for `protocol: 'mcp'`. Which of `RequestConfig`'s
 * other fields matter depends on `transport`: for `stdio`, `url` holds the
 * command to spawn (e.g. `"npx"`) and `args`/`env` here are its arguments/
 * environment — `headers`/`auth` are meaningless, there's no HTTP request.
 * For `http`, `url` is the MCP server's HTTP endpoint and `headers`/`auth`
 * on `RequestConfig` become real request headers, same as every other
 * HTTP-based protocol.
 */
export interface McpProtocolConfig {
  transport: McpTransportKind;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

/** Result of the `initialize` handshake (see mcp/client.ts) — surfaced as a
 * stream's `'open'` event data (request/mcp.ts's `openMcpStream`). */
export interface McpInitializeResult {
  protocolVersion: string;
  serverInfo: McpServerInfo;
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export interface McpToolSummary {
  name: string;
  description?: string;
  /** Raw JSON Schema for the tool's arguments — kept as-is (not flattened,
   * unlike gRPC's message summaries) since a dynamic form generator can
   * walk JSON Schema directly. */
  inputSchema: Record<string, unknown>;
}

export interface McpResourceSummary {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptArgumentSummary {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpPromptSummary {
  name: string;
  description?: string;
  arguments?: McpPromptArgumentSummary[];
}

/** One block of a tool-call result or prompt message — MCP's `content`
 * items are themselves a small tagged union (`text`/`image`/`resource`);
 * kept loose here rather than fully modeled, since a UI only ever
 * needs to render `text` specially and can show anything else as JSON. */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolCallResult {
  content: McpContentBlock[];
  isError?: boolean;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpPromptMessage {
  role: string;
  content: McpContentBlock;
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

/**
 * A saved MCP server connection — its own storage entity for the same
 * reason `WebSocketConnection` is: a persistent session with its own
 * capability set and call history, not a `RequestConfig`. Opening one still
 * builds a `RequestConfig`-shaped object at connect time for `openStream`
 * (see request/mcp.ts), same as every other streaming protocol.
 */
export interface McpServerConnection {
  id: string;
  workspaceId: string;
  /** The 'mcp'-category collection/folder holding this server. */
  collectionId: string;
  sortOrder: number;
  name: string;
  transport: McpTransportKind;
  /** stdio: the command to spawn (e.g. `"npx"`). http: the server's URL. */
  command: string;
  /** stdio only. */
  args: string[];
  /** stdio only. */
  env: KeyValue[];
  /** http only. */
  headers: KeyValue[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Variable scopes, ordered here from highest to lowest precedence.
 * A variable defined in a narrower scope always wins over a wider one —
 * this precedence must be documented for users, since ambiguity here is
 * one of the most common sources of confusion in existing API clients.
 */
export interface VariableScope {
  local: Record<string, string>;
  environment: Record<string, string>;
  collection: Record<string, string>;
  workspace: Record<string, string>;
  global: Record<string, string>;
}

export function emptyScopes(): VariableScope {
  return { local: {}, environment: {}, collection: {}, workspace: {}, global: {} };
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
}

export type CollectionNodeKind = 'collection' | 'folder';

/**
 * Which kind of item a collection hierarchy holds. Each category has its
 * own, separate set of collections: 'api' holds saved requests, 'websocket'
 * holds `WebSocketConnection`s, 'mcp' holds `McpServerConnection`s. A folder
 * always shares its root collection's category.
 */
export type CollectionCategory = 'api' | 'websocket' | 'mcp';

export interface CollectionNode {
  id: string;
  workspaceId: string;
  parentFolderId: string | null;
  name: string;
  kind: CollectionNodeKind;
  category: CollectionCategory;
  sortOrder: number;
  createdAt: number;
}

/** Lightweight request summary used for the collection tree — the full
 * `RequestConfig` is fetched separately (via `getRequest`) only when a
 * request is opened, so a 10,000-request tree stays cheap to load. */
export interface SavedRequestSummary {
  id: string;
  collectionId: string;
  name: string;
  protocol: Protocol;
  method: HttpMethod;
  url: string;
  sortOrder: number;
  updatedAt: number;
}

export interface SavedRequest extends SavedRequestSummary {
  config: RequestConfig;
}

/** A `CollectionNode` plus its nested children and requests, sorted by
 * `sortOrder`, as returned by `getCollectionTree`. */
export interface CollectionTreeNode extends CollectionNode {
  children: CollectionTreeNode[];
  requests: SavedRequestSummary[];
}

/** Same shape as `CollectionTreeNode`, for the 'websocket'/'mcp' categories —
 * as returned by `getWebSocketTree`/`getMcpTree`. Connections are few and
 * small, so the full objects are included rather than summaries. */
export interface ConnectionTreeNode<TConnection> extends CollectionNode {
  children: ConnectionTreeNode<TConnection>[];
  connections: TConnection[];
}

export interface Environment {
  id: string;
  workspaceId: string;
  name: string;
  variables: Record<string, string>;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  error?: string;
}

/** A single `console.log`/`warn`/`error`/`info` call captured while running a
 * pre-request or test script — scripts run in a QuickJS sandbox with no
 * console of its own (see scripting/sandbox.ts), so this is how their output
 * reaches a UI. */
export interface ScriptLogEntry {
  phase: 'pre-request' | 'test';
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

/** Result of running a request through the full pre-request → send → test
 * pipeline (see `runRequestWithScripts`). `response` is absent if the
 * pre-request script threw or the send itself failed. */
export interface RequestRunResult {
  response?: ExecutedResponse;
  testResults: AssertionResult[];
  scriptLogs: ScriptLogEntry[];
  preRequestError?: string;
  sendError?: string;
}

export interface CollectionRunItemResult {
  requestId: string;
  requestName: string;
  result: RequestRunResult;
}

export interface CollectionRunReport {
  total: number;
  items: CollectionRunItemResult[];
  passedAssertions: number;
  failedAssertions: number;
  requestsFailedToSend: number;
  durationMs: number;
}

/** Result of importing a Postman collection or OpenAPI spec into a workspace. */
export interface ImportResult {
  collectionId: string;
  folderCount: number;
  requestCount: number;
}

export type CodegenLanguage = 'curl' | 'js-fetch' | 'js-axios' | 'python-requests' | 'go';

// ---- Engine profile ----------------------------------------------------------

/**
 * The names the engine shows to users. An application built on the engine
 * passes its own profile to the functions that use these names (the script
 * sandbox, the native export and import, the MCP client); without one, they
 * use DEFAULT_ENGINE_PROFILE.
 */
export interface EngineProfile {
  /** Product name used in messages, such as native import errors. */
  productName: string;
  /** Name of the global object scripts use (`jt.test(...)` by default). Must
   * be a plain JavaScript identifier. */
  scriptNamespace: string;
  /** The `format` field that identifies a native export document. */
  exportFormat: string;
  /** File extension for native export files, including the leading dot. */
  exportExtension: string;
  /** Client name sent to MCP servers during the `initialize` handshake. */
  mcpClientName: string;
}

export const DEFAULT_ENGINE_PROFILE: EngineProfile = {
  productName: 'jtaak',
  scriptNamespace: 'jt',
  exportFormat: 'jtaak-export',
  exportExtension: '.jt',
  mcpClientName: 'jtaak',
};

// ---- Native export/import format ---------------------------------------------

/** How much of a workspace an export file holds. Every scope is the same
 * document shape — they differ only in which collections/environments are in it. */
export type ExportScope = 'collection' | 'category' | 'workspace';

/** One saved item in an export file, discriminated by `type`. Database ids,
 * sort orders and timestamps are deliberately left out: order is array order,
 * and every import creates fresh rows, so the file stays stable and diffable. */
export type NativeExportItem =
  | { type: 'request'; name: string; config: Omit<RequestConfig, 'id' | 'name'> }
  | { type: 'websocket'; name: string; url: string; headers: KeyValue[]; subprotocols: string[]; auth: AuthConfig }
  | {
      type: 'mcp';
      name: string;
      transport: McpTransportKind;
      command: string;
      args: string[];
      env: KeyValue[];
      headers: KeyValue[];
    };

export interface NativeExportFolder {
  name: string;
  folders: NativeExportFolder[];
  items: NativeExportItem[];
}

/** A root collection — the only level that records its category, since
 * folders always share their collection's. */
export interface NativeExportCollection extends NativeExportFolder {
  category: CollectionCategory;
}

export interface NativeExportEnvironment {
  name: string;
  variables: Record<string, string>;
}

export const NATIVE_EXPORT_VERSION = 1;

export interface NativeExportDocument {
  /** The profile's `exportFormat` (see EngineProfile). */
  format: string;
  version: typeof NATIVE_EXPORT_VERSION;
  scope: ExportScope;
  exportedAt: string;
  /** True when credentials were blanked at export time (see export/nativeExport.ts's
   * secret rules), so the importer can tell the user to fill them back in. */
  secretsStripped: boolean;
  collections: NativeExportCollection[];
  environments: NativeExportEnvironment[];
}

/** What to export. A folder can be exported too — it becomes a collection
 * in the file (`nodeId` may be any collection/folder). */
export type NativeExportTarget =
  | { scope: 'collection'; nodeId: string }
  | { scope: 'category'; category: CollectionCategory }
  | { scope: 'workspace' };

export interface NativeExportOptions {
  /** Off by default: credentials are blanked unless this is true. */
  includeSecrets: boolean;
  /** Environments to include for collection/category exports. A workspace
   * export always includes every environment and ignores this. */
  environmentIds: string[];
}

/** Summary of a validated export file, shown before anything is written. */
export interface NativeImportPreview {
  scope: ExportScope;
  exportedAt: string;
  secretsStripped: boolean;
  collections: { name: string; category: CollectionCategory; folderCount: number; itemCount: number }[];
  environments: string[];
  /** Requests carrying a pre-request or test script. Scripts run in the
   * QuickJS sandbox, but a pre-request script from someone else's file can
   * still change the variables its request is sent with (and so where
   * credentials go), so the user opts in to them. */
  scriptRequestCount: number;
  /** Every stdio MCP server's command line — connecting one runs it locally. */
  mcpStdioCommands: string[];
  /** Requests whose binary body points at a file on the exporter's machine. */
  localFileRequestCount: number;
}

export interface NativeImportOptions {
  /** When false, pre-request/test scripts are dropped from imported requests. */
  includeScripts: boolean;
  includeEnvironments: boolean;
}

export interface NativeImportResult {
  /** New root collections, in file order. */
  collections: { id: string; name: string; category: CollectionCategory }[];
  folderCount: number;
  itemCount: number;
  environmentCount: number;
}
