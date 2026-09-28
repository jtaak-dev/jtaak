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
export type Protocol = 'http' | 'graphql' | 'websocket' | 'sse' | 'grpc' | 'mcp' | 'soap' | MessagingProtocol;

/** Brokers and event servers: connect, subscribe to channels and publish to
 * them (see request/messaging/). Each is an adapter behind the same
 * `MessagingStreamHandle`. */
export type MessagingProtocol = 'mqtt' | 'kafka' | 'socketio' | 'amqp' | 'nats';

/** Every `MessagingProtocol`. Here rather than in request/messaging/, whose
 * adapters import Node client libraries, so the browser entry can use it. */
export const MESSAGING_PROTOCOLS: readonly MessagingProtocol[] = ['mqtt', 'kafka', 'socketio', 'amqp', 'nats'];

/** The subset of `Protocol` that doesn't fit a single awaited request/response
 * and is routed through `openStream` instead of `executeRequest`. */
export type StreamingProtocol = 'websocket' | 'sse' | 'grpc' | 'mcp' | MessagingProtocol;

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

/** A form-data or urlencoded row. In form-data it can be a file. */
export interface FormField extends KeyValue {
  /** `file` sends the file at `src` as a file part, named after the file,
   * with a Content-Type from its extension (form-data only; a urlencoded
   * body leaves file rows out). Text by default. */
  type?: 'text' | 'file';
  /** A file row's path, read when the request is sent (a relative path is
   * from the working directory). */
  src?: string;
}

export interface RequestBody {
  mode: 'none' | 'raw' | 'json' | 'form-data' | 'urlencoded' | 'binary';
  raw?: string;
  formData?: FormField[];
  /** A `binary` body's file, read and streamed when the request is sent (a
   * relative path is from the working directory). Its Content-Type comes from
   * the file's extension unless a header sets one. */
  binaryPath?: string;
}

export interface AuthConfig {
  /** `digest` and `oauth2` apply to HTTP and GraphQL requests (executeRequest, runRequestWithScripts). */
  type: 'none' | 'basic' | 'bearer' | 'apiKey' | 'digest' | 'oauth2';
  basic?: { username: string; password: string };
  bearer?: { token: string };
  apiKey?: { key: string; value: string; addTo: 'header' | 'query' };
  /** HTTP Digest (RFC 7616): the server's challenge is answered in executeRequest. */
  digest?: { username: string; password: string };
  oauth2?: OAuth2Config;
}

export type OAuth2GrantType = 'authorization_code' | 'client_credentials' | 'password';

/**
 * OAuth 2.0 (RFC 6749) settings. runRequestWithScripts gets a token before
 * sending (request/oauth2.ts): the stored one while it's valid, else a
 * refreshed or new one, and sends it as `token`.
 */
export interface OAuth2Config {
  grantType: OAuth2GrantType;
  /** The provider's authorization endpoint (authorization code only). */
  authUrl?: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  /** Space-separated. */
  scope?: string;
  /** Sent as `audience`, which some providers (Auth0, for one) need. */
  audience?: string;
  /** Resource owner's credentials (password grant only). */
  username?: string;
  password?: string;
  /** Where the provider sends the browser back (authorization code only).
   * Must be `http://127.0.0.1`, `http://localhost` or `http://[::1]`, with a
   * port if the provider only accepts a registered one; default
   * `http://127.0.0.1:<a free port>/callback`. */
  redirectUri?: string;
  /** Proof Key for Code Exchange (RFC 7636, S256), for authorization code. On unless `false`. */
  usePkce?: boolean;
  /** How the client id and secret reach the token endpoint: an HTTP Basic
   * header (the default, RFC 6749 §2.3.1) or form fields in the body. */
  clientAuth?: 'basic' | 'body';
  /** Where the token goes: the Authorization header (the default) or the `access_token` query parameter. */
  addTo?: 'header' | 'query';
  /** Before the token in the Authorization header; default `Bearer`. */
  headerPrefix?: string;
  /** The token to send. runRequestWithScripts sets it from its token store;
   * set it yourself to send a token you already have. */
  token?: OAuth2Token;
}

export interface OAuth2Token {
  accessToken: string;
  tokenType?: string;
  refreshToken?: string;
  /** Milliseconds since the epoch; absent when the provider gave no `expires_in`. */
  expiresAt?: number;
  scope?: string;
  idToken?: string;
  obtainedAt: number;
}

/** An HTTP(S) proxy (request/network.ts). */
export interface ProxyConfig {
  /** `http://host:port`, or `https://host:port` for a proxy spoken to over TLS. */
  url: string;
  /** Basic auth for the proxy (`Proxy-Authorization`). */
  username?: string;
  password?: string;
  /** Hosts reached directly: `example.com` (and its subdomains),
   * `*.example.com` or `.example.com` (its subdomains), `*` (every host),
   * each optionally with `:port`. */
  noProxy?: string[];
}

/** A client certificate (mTLS), offered to the hosts `host` matches when they ask for one. */
export interface ClientCertificate {
  /** `api.example.com` (and its subdomains) or `*.example.com`, optionally with `:port`. */
  host: string;
  /** A PEM certificate and its PEM key... */
  certPath?: string;
  keyPath?: string;
  /** ...or a PKCS #12 (.pfx/.p12) file holding both. */
  pfxPath?: string;
  /** For an encrypted key or PFX. */
  passphrase?: string;
}

/**
 * How connections reach servers. HTTP, GraphQL, SSE, WebSocket, gRPC, MCP
 * over HTTP, OAuth 2.0 token requests, MQTT over WebSocket and Socket.IO go
 * through the proxy (brokers over plain TCP connect directly); every TLS
 * connection (messaging brokers too) uses the certificates.
 */
export interface NetworkSettings {
  proxy?: ProxyConfig;
  clientCertificates?: ClientCertificate[];
  /** PEM files of certificate authorities to trust as well as the system's. */
  caPaths?: string[];
}

/**
 * A response saved as a named example of its request (storage/examples.ts):
 * what it looks like, for reading later and for a mock server to serve.
 */
export interface ResponseExample {
  id: string;
  requestId: string;
  name: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  createdAt: number;
}

/** A response example without its headers and body, for listing. */
export type ResponseExampleSummary = Omit<ResponseExample, 'headers' | 'body'>;

/** A response example in an export file (secret-named headers blanked unless secrets are kept). */
export type NativeExportExample = Pick<ResponseExample, 'name' | 'status' | 'statusText' | 'headers' | 'body'>;

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
  /** Check the server's TLS certificate. On unless set to `false`, which
   * accepts expired, self-signed and wrong-host certificates: for testing a
   * server you control (the connection is still encrypted, but not
   * authenticated). Applies to HTTP, GraphQL, SSE, WebSocket, gRPC over TLS
   * and MCP over HTTP (see request/tls.ts). */
  verifyTls?: boolean;
  /** How to reach the server: a proxy, client certificates and extra
   * certificate authorities (request/network.ts). Settings of the host
   * application, not of the request: the host adds them when it sends, and
   * storage, history and exports never keep them. */
  network?: NetworkSettings;
  /** Use the cookie jar, when the caller gives one (see `ExecuteOptions`):
   * send its cookies and keep what the response sets. On unless set to
   * `false`. */
  useCookies?: boolean;
  /** Payload specific to `protocol` (e.g. a GraphQL query/variables, gRPC
   * service/method) — shape is owned by each protocol; `http`
   * doesn't use it since `method`/`url`/`body`/`auth` above already cover it.
   * Widened to the protocol-specific type (e.g. `GraphQlProtocolConfig`) as
   * each protocol adds its own shape. */
  protocolConfig?:
    | Record<string, unknown>
    | GraphQlProtocolConfig
    | SoapProtocolConfig
    | WebSocketProtocolConfig
    | GrpcProtocolConfig
    | McpProtocolConfig
    | MqttProtocolConfig
    | SocketIoProtocolConfig
    | NatsProtocolConfig
    | AmqpProtocolConfig
    | KafkaProtocolConfig;
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

/** `protocolConfig` for `protocol: 'soap'`: the envelope is the request's raw
 * body, POSTed as request/soap.ts's `soapAsHttp` describes. */
export interface SoapProtocolConfig {
  version: '1.1' | '1.2';
  /** The operation's action URI: SOAP 1.1's `SOAPAction` header, SOAP 1.2's `action` parameter. */
  action?: string;
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

/**
 * Where a request's time went, in milliseconds (request/timing.ts). The
 * phases don't add up to the total: the rest is building the request, queuing
 * for a connection, sending it, and any redirects.
 */
export interface RequestTimingPhases {
  /** Resolving the host name; 0 for an IP address or a reused connection. */
  dnsMs: number;
  /** Opening the TCP connection; 0 for a reused connection. */
  connectMs: number;
  /** The TLS handshake; 0 for plain HTTP or a reused connection. */
  tlsMs: number;
  /** From the request being sent to the response's first byte (its headers). */
  waitMs: number;
  /** Reading the response body. */
  downloadMs: number;
  /** Whether the request went over an already-open connection. */
  reusedConnection: boolean;
}

export interface ExecutedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timings: {
    /** performance.now() readings: a monotonic clock, not times of day. */
    start: number;
    end: number;
    durationMs: number;
    /** Absent where the runtime gave no timing events. */
    phases?: RequestTimingPhases;
  };
  sizeBytes: number;
  /** Each `Set-Cookie` header as sent: `headers` joins them into one value,
   * which can't be split again (dates contain commas). `parseSetCookie`
   * reads one. With a cookie jar, redirects' cookies are here too, in the
   * order they came. Absent on responses stored before it existed. */
  setCookies?: string[];
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
  /** See `RequestConfig.verifyTls`; `true` unless the user turned it off. */
  verifyTls: boolean;
  /** Tests over the messages the connection sees (runConnectionTests); absent when there are none. */
  testScript?: string;
  createdAt: number;
  updatedAt: number;
}

/** What a messaging connection subscribes to. `channel` is the protocol's
 * name for it: an MQTT topic filter, a Kafka topic, a Socket.IO event name,
 * an AMQP queue or a NATS subject. `options` holds the protocol's own
 * settings (for MQTT, `qos`). */
export interface MessagingSubscription {
  channel: string;
  options?: Record<string, unknown>;
}

/** A message to publish. `payload` is text, or base64 with
 * `encoding: 'base64'` for binary data. `options` holds the protocol's own
 * settings (for MQTT, `qos` and `retain`). */
export interface MessagingPublish {
  channel: string;
  payload: string;
  encoding?: 'utf8' | 'base64';
  key?: string;
  headers?: KeyValue[];
  options?: Record<string, unknown>;
}

/** What the broker reported for a publish, when it reports anything (for
 * MQTT QoS 1 and 2, the packet id it acknowledged). */
export interface MessagingPublishResult {
  meta?: Record<string, unknown>;
}

/** The `data` of a messaging stream's `'message'` event: a message received
 * on a subscription, or one this client published (`direction: 'sent'`), so
 * a timeline shows both. `payload` is text, or base64 with `isBinary: true`
 * when it isn't valid UTF-8. `meta` holds the protocol's details (MQTT:
 * `qos`, `retain`, `dup`). */
export interface MessagingMessage {
  direction: 'sent' | 'received';
  channel: string;
  payload: string;
  isBinary: boolean;
  key?: string;
  headers?: Record<string, string>;
  meta?: Record<string, unknown>;
}

/** The handle `openStream` returns for a `MessagingProtocol`. Every call
 * rejects with the reason (see errors.ts) if the connection isn't open or
 * the broker refuses. */
export interface MessagingStreamHandle extends StreamHandle {
  subscribe(subscription: MessagingSubscription): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  publish(message: MessagingPublish): Promise<MessagingPublishResult>;
}

/**
 * A saved connection to a broker or event server (any `MessagingProtocol`),
 * in the 'messaging' category. Like `WebSocketConnection`, it's its own
 * entity, not a request. `settings` is the protocol's `protocolConfig`
 * (`MqttProtocolConfig`, `KafkaProtocolConfig`, …), and `subscriptions` are
 * the channels a host subscribes to again on each connect.
 */
export interface MessagingConnection {
  id: string;
  workspaceId: string;
  /** The 'messaging'-category collection/folder holding this connection. */
  collectionId: string;
  sortOrder: number;
  name: string;
  protocol: MessagingProtocol;
  url: string;
  headers: KeyValue[];
  auth: AuthConfig;
  settings: Record<string, unknown>;
  subscriptions: MessagingSubscription[];
  /** See `RequestConfig.verifyTls`; `true` unless the user turned it off. */
  verifyTls: boolean;
  /** Tests over the messages the connection sees (runConnectionTests); absent when there are none. */
  testScript?: string;
  createdAt: number;
  updatedAt: number;
}

/** `protocolConfig` for `protocol: 'mqtt'`. `url` is `mqtt://`, `mqtts://`,
 * `ws://` or `wss://`; a username and password come from `auth` (basic). */
export interface MqttProtocolConfig {
  /** 4 is MQTT 3.1.1 (the default), 5 is MQTT 5. */
  protocolVersion?: 4 | 5;
  /** Generated when absent. */
  clientId?: string;
  /** Start without the session a previous connection left; defaults to true. */
  clean?: boolean;
  /** Seconds; defaults to 60. */
  keepalive?: number;
  /** Seconds to wait for the broker to accept the connection; defaults to 30. */
  connectTimeout?: number;
}

/** `protocolConfig` for `protocol: 'socketio'` (Socket.IO v4 servers).
 * `url` is `http(s)://host[:port]/namespace`. A bearer token from `auth` is
 * sent in the handshake's auth payload as `token`; headers go with the
 * handshake (not sent by browsers, but a Node client can). */
export interface SocketIoProtocolConfig {
  /** The server's Socket.IO path; defaults to `/socket.io`. */
  path?: string;
  /** Defaults to WebSocket, falling back to long-polling. */
  transports?: ('websocket' | 'polling')[];
  /** More fields for the handshake's auth payload (what the server reads as `socket.handshake.auth`). */
  auth?: Record<string, unknown>;
  /** Seconds to wait for the connection; defaults to 20. */
  connectTimeout?: number;
}

/** `protocolConfig` for `protocol: 'nats'`. `url` is `nats://` or
 * `tls://` (several servers comma-separated); a username and password
 * (basic) or a token (bearer) come from `auth`. */
export interface NatsProtocolConfig {
  /** The client name the server shows for this connection. */
  name?: string;
  /** Seconds to wait for the connection; defaults to 20. */
  connectTimeout?: number;
}

/** `protocolConfig` for `protocol: 'amqp'` (AMQP 0-9-1, as RabbitMQ
 * speaks). `url` is `amqp://` or `amqps://`, with the vhost as its path; a
 * username and password come from `auth` (basic) or the URL. */
export interface AmqpProtocolConfig {
  /** Seconds between heartbeats; defaults to 60. */
  heartbeat?: number;
  /** Seconds to wait for the connection; defaults to 20. */
  connectTimeout?: number;
}

/** `protocolConfig` for `protocol: 'kafka'`. `url` is `kafka://` (plain) or
 * `kafkas://` (TLS) with one or more bootstrap brokers,
 * `kafka://host:9092,host2:9092`. A username and password (basic) sign in
 * with SASL. */
export interface KafkaProtocolConfig {
  /** Generated when absent. */
  clientId?: string;
  /** The SASL mechanism for a username and password; defaults to PLAIN. */
  saslMechanism?: 'PLAIN' | 'SCRAM-SHA-256' | 'SCRAM-SHA-512';
  /** Seconds to wait for a connection; defaults to 20. */
  connectTimeout?: number;
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
   * `import` statements aren't resolved (see request/grpc.ts). Empty when
   * the definitions come from server reflection. */
  protoFile: string;
  /** Where the service definitions come from: `protoFile` (the default), or
   * `reflectedSchema`, what the server itself described (see
   * request/grpcReflection.ts). */
  source?: 'proto' | 'reflection';
  /** The server's services and messages as its reflection service described
   * them, as protobufjs JSON (`reflectGrpcServer`). */
  reflectedSchema?: Record<string, unknown>;
  /** Fully-qualified service name, e.g. `"greeter.Greeter"`. */
  serviceFullName: string;
  methodName: string;
  /** The request, for a unary or server-streaming call; for client and
   * bidirectional streams, messages go through `GrpcStreamHandle.send`. */
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
/** The `data` of a `message` event on a gRPC stream (request/grpcStream.ts). */
export interface GrpcStreamMessage {
  direction: 'sent' | 'received';
  message: Record<string, unknown>;
}

/** The `data` of a gRPC stream's `close` event: how the call ended. */
export interface GrpcStreamStatus {
  status: { code: number; details: string };
  /** The server's response headers, then its trailers. */
  headers: Record<string, string>;
  metadata: Record<string, string>;
}

/** An open gRPC streaming call (openStream with `protocol: 'grpc'`). */
export interface GrpcStreamHandle extends StreamHandle {
  /** Sends a message (an object, or JSON text) on a client or bidirectional stream. */
  send: (message: unknown) => void;
  /** Half-closes: the client is done sending, and the server may answer and finish. */
  end: () => void;
}

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
  /** http only. See `RequestConfig.verifyTls`; `true` unless the user turned it off. */
  verifyTls: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Variable scopes, ordered here from highest to lowest precedence.
 * A variable defined in a narrower scope always wins over a wider one —
 * this precedence must be documented for users, since ambiguity here is
 * one of the most common sources of confusion in existing API clients.
 */
/**
 * One pass of a run that repeats its requests, for example once per row of
 * a data file: which pass it is, of how many, and the row's values. Scripts
 * read it as `<namespace>.iteration` (and Postman's `pm.iterationData`,
 * `pm.info.iteration`); the values also resolve as `{{variables}}`.
 */
export interface ScriptIteration {
  /** From 0. */
  index: number;
  count: number;
  data: Record<string, string>;
}

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
export type CollectionCategory = 'api' | 'websocket' | 'mcp' | 'messaging';

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

// ---- Request history (storage/history.ts) --------------------------------

/** One sent request to record. The engine stores `config` as given; whether
 * it holds `{{variables}}` or their resolved values is the caller's choice
 * (resolved values can include secrets from environments). */
export interface HistoryEntryInput {
  workspaceId: string;
  /** The saved request it was sent from, if any. */
  requestId?: string | null;
  config: RequestConfig;
  /** Absent when the request couldn't be sent (see `error`). */
  response?: ExecutedResponse;
  /** Why it couldn't be sent. */
  error?: string;
  testResults?: AssertionResult[];
  /** When it was sent (ms since the epoch); now by default. */
  executedAt?: number;
}

/** A history entry without its request and response, for lists. */
export interface HistoryEntrySummary {
  id: string;
  workspaceId: string;
  /** The saved request it came from; null for an unsaved request, or once
   * that request is deleted. */
  requestId: string | null;
  executedAt: number;
  name: string;
  protocol: Protocol;
  method: HttpMethod;
  url: string;
  /** Null when it couldn't be sent. */
  status: number | null;
  durationMs: number | null;
  /** The full response size, even when the stored body is truncated. */
  sizeBytes: number | null;
  testsPassed: number;
  testsTotal: number;
  error: string | null;
}

export interface HistoryEntry extends HistoryEntrySummary {
  config: RequestConfig;
  /** Null when it couldn't be sent (`error` says why), or when the response
   * wasn't kept (addHistoryEntry's `storeResponse: false`; `status` is set). */
  response: ExecutedResponse | null;
  /** The stored body was cut to the size limit (the response's sizeBytes is
   * the full size). */
  responseTruncated: boolean;
}

export interface HistoryQuery {
  /** At most this many entries (default 100, at most 1000). */
  limit?: number;
  /** Entries older than this one: pass the last entry of the previous page. */
  before?: { executedAt: number; id: string };
  /** Only entries whose name or URL contains this text (case-insensitive). */
  search?: string;
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
/** Changes to an environment's values: a new value, or null for one removed. */
export type EnvironmentUpdates = Record<string, string | null>;

export interface RequestRunResult {
  response?: ExecutedResponse;
  testResults: AssertionResult[];
  scriptLogs: ScriptLogEntry[];
  preRequestError?: string;
  sendError?: string;
  /**
   * What the request's scripts changed in the environment
   * (`<namespace>.environment`), when they changed anything. The engine
   * doesn't save them; a host can apply them to the environment
   * (applyEnvironmentUpdates). `<namespace>.variables` changes are never
   * here: they last only for the request.
   */
  environmentUpdates?: EnvironmentUpdates;
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
  /** The run's net changes to the environment, when there are any: each
   * request's scripts see the changes made before them. */
  environmentUpdates?: EnvironmentUpdates;
  /** Set when `stopOnFailure` ended the run before its last request (`items` has those that ran). */
  stoppedEarly?: boolean;
  /** Set when the run's `signal` stopped it before its last request (`items` has those that ran). */
  cancelled?: boolean;
}

/** Result of importing a Postman collection or OpenAPI spec into a workspace. */
export interface ImportResult {
  collectionId: string;
  folderCount: number;
  requestCount: number;
  /** Postman imports: each request whose scripts call parts of Postman's API the sandbox doesn't have. */
  scriptWarnings?: { requestName: string; calls: string[] }[];
  /** What was left out (WSDL imports: an import that couldn't be read, a port that isn't SOAP). */
  warnings?: string[];
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
  | {
      type: 'request';
      name: string;
      config: Omit<RequestConfig, 'id' | 'name'>;
      /** Only written when the request has some. */
      examples?: NativeExportExample[];
    }
  | {
      type: 'websocket';
      name: string;
      url: string;
      headers: KeyValue[];
      subprotocols: string[];
      auth: AuthConfig;
      /** Only written when `false` (see `RequestConfig.verifyTls`); absent means on. */
      verifyTls?: boolean;
      testScript?: string;
    }
  | {
      type: 'mcp';
      name: string;
      transport: McpTransportKind;
      command: string;
      args: string[];
      env: KeyValue[];
      headers: KeyValue[];
      /** As for websocket items. */
      verifyTls?: boolean;
    }
  | {
      type: 'messaging';
      name: string;
      protocol: MessagingProtocol;
      url: string;
      headers: KeyValue[];
      auth: AuthConfig;
      settings: Record<string, unknown>;
      subscriptions: MessagingSubscription[];
      /** As for websocket items. */
      verifyTls?: boolean;
      testScript?: string;
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
  /** Requests carrying a pre-request or test script, and connections carrying
   * a test script. Scripts run in the QuickJS sandbox, but a pre-request
   * script from someone else's file can still change the variables its
   * request is sent with (and so where credentials go), so the user opts in
   * to them. */
  scriptRequestCount: number;
  /** Every stdio MCP server's command line — connecting one runs it locally. */
  mcpStdioCommands: string[];
  /** Requests that send a file from the exporter's machine (a binary body or a form-data file). */
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
