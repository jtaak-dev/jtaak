# jtaak samples

## Sample workspace

**[`jtaak-sample-workspace.jt`](./jtaak-sample-workspace.jt)** is a workspace
in the engine's native export format (`format: "jtaak-export"`), exercising
every category, request protocol and messaging protocol the engine supports.
Every request points at a free public test service, so it all works with no
sign-up or API keys, except the four local messaging brokers, which you start
with Docker. Its scripts use the default script API, `jt`.

It's also the reference example of the format:
`src/import/sampleWorkspace.test.ts` checks that it validates, imports, and
re-exports to exactly the same bytes (`importNative`, then `exportNative`
with the default profile). `.gitattributes` keeps it LF on every checkout
for that reason.

### What's inside

| Section | Collection | What it shows |
|---|---|---|
| API | **Sample — HTTP** (43 requests) | See the breakdown below. |
| API | **Sample — GraphQL** (7) | See the breakdown below. |
| API | **Sample — Server-Sent Events** (3) | Named events with ids, and the same with tests on what arrives; a busy live stream (Wikimedia recent edits). |
| API | **Sample — gRPC** (10) | See the breakdown below. |
| API | **Sample — SOAP** (3) | See the breakdown below. |
| API | **Sample — AI APIs** (4) | See the breakdown below. |
| WebSocket | **Sample — WebSocket** (5) | Echo servers, plus connections with custom headers and a bearer token, and one whose URL is a `{{variable}}`, with tests on what comes back. Connect, send a message, and watch it echo back. |
| MCP | **Sample — MCP** (3) | See the breakdown below. |
| Messaging | **Sample — Messaging** (9 connections) | MQTT, Kafka, Socket.IO, AMQP and NATS: five public test broker connections that work straight away (one with tests on what arrives), and four local ones. See below. |

**Sample — HTTP** covers:

- every method: GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS
- query params and headers, including disabled rows
- `{{variables}}` in the path, params and headers
- JSON, raw text, urlencoded and multipart bodies
- **Files:** a binary body, and a multipart form with a file field, both
  sending [`sample-upload.txt`](./sample-upload.txt). The path is relative,
  so run the sample from this folder (`jt run jtaak-sample-workspace.jt`
  from `samples/`)
- **Response examples:** **REST CRUD → Get one post** keeps two, *Found*
  and *Not found*, as examples of what it returns
- Basic, Bearer and API-key auth, sent as a header or in the query string;
  Digest auth; OAuth 2.0 client credentials (set `oauthTokenUrl`,
  `oauthClientId` and `oauthClientSecret` in the environment for your
  provider); and a client certificate (mutual TLS, see below)
- **Cookies:** a response that sets a cookie (through a redirect), a
  request that sends it back, and one with the cookie jar turned off
- a test script written for Postman (`pm.test`, `pm.expect`,
  `pm.response`), which runs as written
- 401, 404, 500 and 418 responses, redirects, a slow response, a large
  (~1 MB) response, and HTML and XML responses
- pre-request scripts, passing and failing tests, and `console.log`
- a full REST CRUD set (list, get, create, update, delete) on
  JSONPlaceholder

**Sample — GraphQL** covers:

- simple queries, and queries with variables
- picking one of several operations by name
- nested fields and filters
- an error response
- pagination
- all against the Countries and Rick and Morty APIs; use **Fetch schema**
  to browse them

**Sample — gRPC** covers:

- a plaintext call and a TLS call
- an empty request
- a message using every field type: strings, numbers, enums, nested and
  repeated messages, booleans and floats
- request metadata
- an error status
- server streaming, client streaming and bidirectional calls: send, send
  messages, **End**, and watch the replies
- a request with no `.proto`: it loads the service from the server itself
  (server reflection); click **Load services from the server**
- all against the public grpcb.in server

**Sample — SOAP** covers:

- a SOAP 1.1 call and a SOAP 1.2 call, each with its action, to a public
  calculator service
- a fault (dividing by zero), shown with its code and reason

**Sample — AI APIs** covers:

- streaming an answer from OpenAI's chat completions and from Anthropic's
  Messages API: an SSE request that POSTs a JSON body, with tests that
  pass once the stream has ended (`aiStreamText` puts the answer together, `aiUsage` reads the tokens)
- the same OpenAI request, not streamed, as a plain HTTP request (`jt run` sends it; streams are skipped there)
- a local model through Ollama's OpenAI-compatible API, which needs no key
  (`ollama run llama3.2` first)

They need your own API keys: set `openaiApiKey` and `anthropicApiKey` in
the environment (they're empty in the sample, and exports leave keys out).
`openaiBaseUrl`, `anthropicBaseUrl` and `localModelUrl` point the same
requests at another compatible service. Without a key, the error shows the
API's own explanation.

**Sample — MCP** covers:

- the reference "Everything" server, which has tools, resources and
  prompts
- the Memory server
- the remote DeepWiki server

Two environments come with it: **Sample — httpbin** and
**Sample — Postman Echo**. Switch between them to send the same requests
to a different server.

**Sample — Messaging** covers every messaging protocol:

- **Public test brokers**, which work straight away: the Mosquitto test
  broker over MQTT 3.1.1 and over WebSocket with TLS (`wss://`), HiveMQ's
  public broker over MQTT 5, and the NATS demo server. Each subscribes to
  `jtaak-sample/#` (NATS: `jtaak.sample.>`), so publish to, say,
  `jtaak-sample/hello` and watch it come back. These brokers are shared with
  everyone: don't send anything private.
- **Local brokers** for Kafka, RabbitMQ, NATS and a Socket.IO server, with
  their subscriptions set up: reading a Kafka topic from the beginning,
  declaring a RabbitMQ queue and binding a private one to `amq.topic`, and
  a NATS queue group. Start the brokers with Docker (or Podman):

  ```
  docker run -d --name kafka -p 9092:9092 apache/kafka-native:4.1.0
  docker run -d --name rabbitmq -p 5672:5672 rabbitmq:4-alpine
  docker run -d --name nats -p 4222:4222 nats:2.11-alpine
  ```

  (RabbitMQ's `guest` user only signs in from the broker's own machine,
  which a port published on localhost counts as.) For Socket.IO, point the
  connection at your own server.

### Things to try

- **A client certificate (mutual TLS):** **Authentication → Client
  certificate** calls badssl.com's test server, which answers 400 until you
  send it a certificate. Download
  [`badssl.com-client.pem`](https://badssl.com/certs/badssl.com-client.pem)
  (the certificate and its key in one file, passphrase `badssl.com`), then
  run it with the certificate:

  ```
  jt run jtaak-sample-workspace.jt -e "Sample — httpbin" --folder "Sample — HTTP/Authentication" \
    --cert badssl.com-client.pem --key badssl.com-client.pem --pass badssl.com
  ```

  (In code, that's `network.clientCertificates` on the request.) Save it, and send it again: 200.
- **A SOAP service from its WSDL:** `importWsdl(db, workspaceId, await
  loadWsdl('http://www.dneonline.com/calculator.asmx?WSDL'))` makes the
  **Sample — SOAP** calculator's requests (and Subtract and Divide) from
  the service's own description, with an envelope for each operation.
- **A proxy:** set `HTTPS_PROXY` (and `NO_PROXY`), or pass `--proxy`, and
  `jt run` sends everything through it.

### Good to know

- The local MCP servers need [Node.js](https://nodejs.org). The first time
  you connect one, it's downloaded automatically, which can take a minute.
- The sample credentials (`jtaak-user`, `sample-token`, `sample-api-key`,
  and so on) are placeholders that the public test services accept. They
  aren't real accounts.
- **Scripts & tests → "A failing test (on purpose)"** is meant to fail, so
  you can see what a failed test looks like. **Authentication → Client
  certificate** fails too until you give it the certificate.
- These are free public services run by others. If one is slow or briefly
  unavailable, try again later, or switch to the other environment.
