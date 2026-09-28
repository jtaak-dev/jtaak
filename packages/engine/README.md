# @jtaak/engine

A local-first API request engine for Node.js. It sends and times HTTP, GraphQL,
Server-Sent Events, gRPC (unary and streaming), SOAP, WebSocket and MCP (Model Context Protocol)
requests; connects to MQTT, Kafka, Socket.IO, AMQP and NATS; runs pre-request
and test scripts in a sandbox; resolves `{{variables}}`; imports Postman,
OpenAPI and cURL; and stores workspaces, collections and environments in SQLite.
It has no UI, no account and no telemetry: it only ever talks to the APIs you
send requests to.

It's the engine behind the [`jtaak` CLI](https://www.npmjs.com/package/jtaak), and
is built to be embedded in other tools.

```bash
npm install @jtaak/engine
```

Requires Node.js 22.22 or later. The package is ESM only. SQLite comes from
`better-sqlite3`, which ships prebuilt binaries, so installing needs no compiler.

## Send a request

```ts
import { executeRequest } from '@jtaak/engine';

const response = await executeRequest({
  id: 'r1',
  name: 'List users',
  method: 'GET',
  url: 'https://api.example.com/users',
  params: [{ key: 'page', value: '2', enabled: true }],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'bearer', bearer: { token: 'secret' } },
});

console.log(response.status, response.statusText, `${response.timings.durationMs.toFixed(0)} ms`);
console.log(response.body);
```

`response.timings.phases` breaks the time down: `dnsMs`, `connectMs`, `tlsMs`,
`waitMs` (from the request being sent to the first byte of the response),
`downloadMs`, and `reusedConnection` (a reused connection has no DNS, connect or
TLS time). The phases come from the diagnostics-channel events Node's `fetch`
publishes; they don't add up to `durationMs`, which also covers building the
request and any redirects.

`protocol: 'graphql'` sends GraphQL over HTTP, and `protocol: 'soap'` a SOAP
1.1 or 1.2 envelope (the raw body) as a POST with the version's content type
and action (`protocolConfig: { version, action }`); `soapEnvelopeTemplate`
starts one, and `parseSoapFault(body)` reads a fault's code, reason and
detail. For long-lived connections
(`sse`, `websocket`, `mcp`) use `openStream(config, onEvent)`.

## gRPC

A gRPC request's `protocolConfig` names the service and method, and where
their definitions come from: a pasted `.proto` file (`protoFile`), or the
server itself. `reflectGrpcServer(config)` asks the server's reflection
service (v1, or v1alpha for older servers) for its services and messages,
including the files they import; put its `schema` in `reflectedSchema` with
`source: 'reflection'`. `summarizeGrpcSchema(protocolConfig)` lists the
services, methods and message fields of either, for building a form.

`executeGrpcUnaryCall(config)` makes a unary call. A streaming method goes
through `openStream(config, onEvent)`, which returns a `GrpcStreamHandle`:

```ts
const call = openStream(
  { ...config, protocol: 'grpc', protocolConfig: { ...grpc, methodName: 'Chat' } },
  (event) => console.log(event.type, event.data), // open, message ({ direction, message }), error, close ({ status })
) as GrpcStreamHandle;
call.send({ text: 'hi' }); // client and bidirectional streams
call.end(); // done sending; the server finishes
call.close(); // or cancel
```

A server-streaming call sends `requestMessage` when it opens. Messages are
checked against the request type before they're sent.

`verifyTls: false` skips checking the server's TLS certificate, for testing a
server with a self-signed, expired or wrong-host certificate. It works for every
protocol above (gRPC when it uses TLS). The connection is still encrypted, but not
authenticated, so leave it on for anything else.

When a request can't be sent, the error message includes the reason Node keeps
in the error's `cause`, for example
`fetch failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)`, not just
`fetch failed`.

## Messaging

`openStream` also connects to message brokers and event servers: MQTT, Kafka,
Socket.IO, AMQP (RabbitMQ) and NATS, all behind the same handle. Subscribe to
channels, publish to them, and every message sent and received arrives as a
`message` event:

```ts
import { openStream, type MessagingStreamHandle } from '@jtaak/engine';

const mqtt = openStream(
  {
    id: 'm1',
    name: 'Sensors',
    protocol: 'mqtt',
    method: 'GET',
    url: 'mqtts://broker.example.com:8883',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } },
    protocolConfig: { protocolVersion: 5 },
  },
  (event) => console.log(event.type, event.data),
) as MessagingStreamHandle;

await mqtt.subscribe({ channel: 'sensors/+/temp', options: { qos: 1 } });
await mqtt.publish({ channel: 'sensors/kitchen/temp', payload: '21.5', options: { retain: true } });
mqtt.close();
```

| Protocol | `url` | A channel is | Subscribe options | Publish options |
|---|---|---|---|---|
| `mqtt` (3.1.1, 5) | `mqtt://`, `mqtts://`, `ws://`, `wss://` | a topic (filter) | `qos` | `qos`, `retain`; `headers` as MQTT 5 user properties |
| `kafka` | `kafka://host:9092[,…]`, `kafkas://` (TLS) | a topic | `groupId`, `fromBeginning` | `key`, `headers`, `partition` |
| `socketio` (v4) | `http(s)://host/namespace` | an event name (`*` for all) | | `ack`, `timeout`, `spread` |
| `amqp` (0-9-1) | `amqp://`, `amqps://`, vhost as the path | a queue (`''` for a private one) | `declare`, `durable`, `exchange`, `routingKey` | `exchange`, `persistent`, message properties; `headers` |
| `nats` | `nats://`, `tls://` | a subject | `queue` | `request`, `timeout`; `headers` |

- Calls made before the connection is accepted wait for it, and fail with the
  reason if it isn't.
- A message's `payload` is text, or base64 with `isBinary: true` (publish binary
  data with `encoding: 'base64'`). Its `meta` has the protocol's details: QoS,
  partition and offset, exchange and delivery tag, reply subject.
- Fields a protocol has no place for (a key outside Kafka, headers on Socket.IO)
  are refused rather than dropped.
- Credentials come from `auth`: basic for a username and password (SASL for
  Kafka), bearer for a token (NATS, Socket.IO). `verifyTls` applies to every
  protocol's TLS.
- AMQP publishes are confirmed by the broker and mandatory, so a message no queue
  receives fails with the broker's reason. Kafka creates a topic on first use if
  the broker allows it. NATS and Socket.IO requests wait for a reply or an
  acknowledgement.
- No connection reconnects by itself: a lost connection ends with `close`.
- Each protocol's client library loads only when one of its connections opens.

## Variables

`{{name}}` tokens in a request resolve against a `VariableScope` with a fixed
precedence: `local > environment > collection > workspace > global`. An unknown
variable is left as it is, so it's easy to spot.

```ts
import { emptyScopes, resolveDeep } from '@jtaak/engine';

const scopes = { ...emptyScopes(), environment: { baseUrl: 'https://api.example.com' } };
const resolved = resolveDeep(request, scopes); // every string field, resolved
```

## Scripts and tests

`runRequestWithScripts` runs a request's pre-request script, resolves variables,
sends the request, then runs its test script against the response:

```ts
import { emptyScopes, runRequestWithScripts } from '@jtaak/engine';

const result = await runRequestWithScripts(
  {
    ...request,
    preRequestScript: 'jt.variables.requestId = "req-" + Date.now();',
    testScript: `
      jt.test('status is 200', () => jt.expect(jt.response.status).toBe(200));
      jt.test('has users', () => jt.expect(jt.response.json().users.length).toBeGreaterThan(0));
    `,
  },
  emptyScopes(),
);

console.log(result.testResults); // [{ name: 'status is 200', passed: true }, ...]
```

Scripts use the `jt` object: `jt.test`, `jt.expect` (`toBe`, `toEqual`,
`toContain`, `toHaveProperty`, `toBeGreaterThan`, `not`, and more),
`jt.response`, `jt.request` (read-only), `jt.variables` and
`jt.environment`. They also get `console`, whose output is returned in
`scriptLogs`.

Both `jt.variables` and `jt.environment` start as the environment's values
(`scopes.environment`), and the request resolves `{{name}}` against what
scripts set in either. What they set in `jt.variables` lasts only for this
request. What they set in `jt.environment` (or delete from it) comes back
as `result.environmentUpdates`, a new value per name or `null` for one
removed, so the caller can save it. The engine never changes the
environment itself; `applyEnvironmentUpdates(values, updates)` applies them:

```ts
import { applyEnvironmentUpdates, runRequestWithScripts } from '@jtaak/engine';

const login = await runRequestWithScripts(
  { ...loginRequest, testScript: 'jt.environment.token = jt.response.json().token;' },
  scopes,
);
if (login.environmentUpdates) {
  environment.variables = applyEnvironmentUpdates(environment.variables, login.environmentUpdates);
}
```

Scripts run in [QuickJS](https://github.com/justjake/quickjs-emscripten), a
separate JavaScript engine compiled to WebAssembly: a fresh runtime per script,
a 1 s deadline (including promise callbacks) and a 64 MB memory cap. The
deadline is hard: a script still running just after it, even inside one long
built-in call such as a large `sort`, is terminated. They get no
Node.js or host objects, no timers and no network; data goes in and out only as
JSON.

`runConnectionTests(script, { request, messages })` runs a test script over
what a WebSocket, SSE or messaging connection has sent and received. Each of
`jt.messages` has `direction`, `channel`, `data`, `at` (milliseconds since
the connection opened) and `json()`; run it again as messages arrive for
results that say how the connection is doing so far:

```ts
jt.test('an order is paid within 5 s', () => {
  const paid = jt.messages.find((m) => m.channel === 'orders' && m.json().status === 'paid');
  jt.expect(paid).toBeDefined();
  jt.expect(paid.at).toBeLessThan(5000);
});
```

WebSocket and messaging connections keep a script as `testScript`.

`runCollection(requests, scopes, onProgress)` runs a list of requests in order
with their scripts and returns a pass/fail report. What one request's scripts
set in `jt.environment` reaches the requests after it (a login request's
token, say), and the report's `environmentUpdates` has the run's net
changes.

## Cookies

Pass a `CookieJar` and requests keep cookies the way a browser does (RFC
6265): what a response sets is stored for its domain and path, and sent with
later requests that match. Secure cookies go only over HTTPS or to the local
machine, and redirects are followed with the jar, so a cookie a login's
redirect sets isn't lost. A request with `useCookies: false` neither sends nor
keeps cookies. Scripts read the URL's cookies as `jt.cookies`: `get(name)`,
`has(name)`, `toObject()` and `all()`.

```ts
import { CookieJar, loadCookieJar, runCollection, runRequestWithScripts, saveCookieJar } from '@jtaak/engine';

const cookieJar = new CookieJar();
await runRequestWithScripts(login, scopes, undefined, { cookieJar }); // stores the session cookie
await runRequestWithScripts(profile, scopes, undefined, { cookieJar }); // sends it
await runCollection(requests, scopes, undefined, undefined, { cookieJar });

// Or a workspace's cookies, kept in the database:
const jar = loadCookieJar(db, workspace.id);
await runRequestWithScripts(request, scopes, undefined, { cookieJar: jar });
saveCookieJar(db, workspace.id, jar); // writes only what changed
```

`listCookies`, `saveCookie`, `deleteCookie` and `clearCookies` read and edit
a workspace's stored cookies.

## Digest and OAuth 2.0

`auth: { type: 'digest', digest: { username, password } }` answers a
server's Digest challenge (RFC 7616: MD5 or SHA-256, and their `-sess`
forms): `executeRequest` sends the request, and on a 401 with a challenge
sends it again with the answer.

`auth: { type: 'oauth2', oauth2 }` gets a token before `runRequestWithScripts`
sends the request, and sends it as `Authorization: Bearer …` (or
`headerPrefix`, or the `access_token` query parameter with
`addTo: 'query'`). The client credentials and password grants get one from
`tokenUrl`; the authorization code grant (with PKCE) opens the provider's
page through `openBrowser` and catches the redirect on a loopback address
(`redirectUri`, default `http://127.0.0.1:<a free port>/callback`). Tokens
are kept in an `OAuth2TokenStore` and refreshed with their refresh token
when they expire; requests with the same client and provider share one.

```ts
import { runRequestWithScripts, sqliteOAuth2TokenStore } from '@jtaak/engine';

const request = {
  ...base,
  auth: {
    type: 'oauth2',
    oauth2: {
      grantType: 'authorization_code',
      authUrl: 'https://id.example.com/authorize',
      tokenUrl: 'https://id.example.com/token',
      clientId: 'my-app',
      scope: 'openid profile',
    },
  },
};
await runRequestWithScripts(request, scopes, undefined, {
  oauth2Tokens: sqliteOAuth2TokenStore(db, workspace.id), // or new MemoryOAuth2TokenStore()
  openBrowser: (url) => open(url), // any way of showing the user the page
});
```

`getOAuth2Token` (with `forceNew` for "get a new token"), `authorizeInBrowser`,
`fetchClientCredentialsToken`, `fetchPasswordToken` and `refreshOAuth2Token`
do each step on their own.

## Performance

`pnpm bench` measures what the engine costs on top of the network, and how
it scales to a large workspace, against a server on the same machine (so the
network is as fast as it gets). CI runs it on every change and shows the
table in the job summary. One run, on a laptop (Node v24.21.0, Windows_NT 10.0.26200 (x64), 11th Gen Intel(R) Core(TM) i5-1135G7 @ 2.40GHz, 8 threads):

| Benchmark | Result | Budget |
| --- | ---: | --- |
| A request, bare fetch (p50) | 0.15 ms |  |
| A request through executeRequest (p50) | 0.16 ms |  |
| Engine overhead per request (p50) | 0.01 ms | ≤ 5 ms |
| Engine overhead per request (p95) | 0.06 ms | ≤ 5 ms |
| A request with a pre-request and a test script (p50) | 2.40 ms |  |
| One script in the sandbox (p50) | 0.92 ms | ≤ 10 ms |
| Resolving 70 {{variables}} in a request (p50) | 0.04 ms | ≤ 1 ms |
| Collection run, 10,000 requests, no scripts | 3153 ms |  |
| Collection run, 1,000 requests with tests | 2197 ms |  |
| Saving 10,000 requests in 100 folders | 880 ms |  |
| Loading a 10,000-request tree (p50 of 5) | 36.8 ms | ≤ 1000 ms |
| Exporting the 10,000-request workspace | 84.9 ms |  |

The engine adds a few hundredths of a millisecond to a request; what a
script costs is starting a fresh sandbox for it (about a millisecond).

## Storage

```ts
import { createRequest, getOrCreateDefaultWorkspace, getCollectionTree, openDatabase } from '@jtaak/engine';

const db = openDatabase('jtaak.db'); // or ':memory:'
const { workspace } = getOrCreateDefaultWorkspace(db);
const tree = getCollectionTree(db, workspace.id);
```

The schema is versioned: opening a database migrates it forward, and a database
written by a newer version of the engine is refused with `DatabaseTooNewError`
rather than modified.

Collections belong to a sidebar category (`COLLECTION_CATEGORIES`): `api` for
requests, `websocket` and `mcp` for those connections, and `messaging` for broker
connections (`createMessagingConnection`, `updateMessagingConnection`,
`getMessagingTree` and the rest, like the WebSocket ones). A messaging
connection keeps its protocol, URL, headers, auth, the protocol's `settings`
(its `protocolConfig`) and the `subscriptions` to make again on each connect.

Request history is stored per workspace:

```ts
import { addHistoryEntry, listHistory, getHistoryEntry, pruneHistory } from '@jtaak/engine';

addHistoryEntry(db, { workspaceId: workspace.id, requestId, config, response, testResults });
const page = listHistory(db, workspace.id, { limit: 50, search: 'users' }); // newest first
const older = listHistory(db, workspace.id, { before: page.at(-1) }); // the next page
const entry = getHistoryEntry(db, page[0].id); // with its request and response
pruneHistory(db, workspace.id, 500); // keep the newest 500
```

It stores the `config` it's given, so pass the request as written if resolved
`{{variables}}` could hold secrets. `addHistoryEntry(db, input, { storeResponse:
false })` keeps only the response's status, duration and size. Response bodies over 256 kB are cut
(`responseTruncated`); `sizeBytes` keeps the full size. `deleteHistoryEntry` and
`clearHistory` delete entries, and deleting a workspace deletes its history.

## Import and export

- `importPostmanCollection`, `importPostmanEnvironment`, `importOpenApi` and
  `parseCurlCommand` bring in existing work.
- `exportNative` writes the engine's own format (`.jt` files,
  `format: "jtaak-export"`). The output is deterministic, so exports diff
  cleanly in Git, and credentials are blanked unless you ask for them.
  `validateNativeExport`, `previewNativeImport` and `importNative` read it back,
  treating the file as untrusted input.
- `generateSnippet(request, language)` produces cURL, `fetch`, axios, Python
  `requests` and Go code for a request.

See [`samples/`](https://github.com/jtaak-dev/jtaak/tree/main/packages/engine/samples)
for a sample workspace covering every protocol.

## Embedding: profiles

Applications built on the engine can use their own names for what users see.
Pass an `EngineProfile` to the functions that use one (`runScript`,
`runRequestWithScripts`, `runCollection`, `openStream`, `exportNative`,
`isNativeExport`, `validateNativeExport`):

```ts
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '@jtaak/engine';

const profile: EngineProfile = {
  productName: 'Acme',        // in messages, such as import errors
  scriptNamespace: 'acme',    // scripts call acme.test(...)
  exportFormat: 'acme-export',
  exportExtension: '.acme',
  mcpClientName: 'acme',
};
```

Without one, everything uses `DEFAULT_ENGINE_PROFILE` (`jtaak`, `jt`,
`jtaak-export`, `.jt`).

## Browser-safe entry point

`@jtaak/engine/browser` exports only the parts with no Node.js built-ins or
native modules (the types, the variable resolver, code snippets, cURL parsing and
`.proto` parsing), for bundling into browser code.

## License

Apache-2.0. Copyright 2026 Jana Software Lab.
