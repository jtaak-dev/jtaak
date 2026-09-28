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
| API | **Sample — HTTP** (34 requests) | See the breakdown below. |
| API | **Sample — GraphQL** (7) | See the breakdown below. |
| API | **Sample — Server-Sent Events** (2) | Named events with ids; a busy live stream (Wikimedia recent edits). |
| API | **Sample — gRPC** (6) | See the breakdown below. |
| WebSocket | **Sample — WebSocket** (4) | Echo servers, plus connections with custom headers and a bearer token. Connect, send a message, and watch it echo back. |
| MCP | **Sample — MCP** (3) | See the breakdown below. |
| Messaging | **Sample — Messaging** (8 connections) | MQTT, Kafka, Socket.IO, AMQP and NATS: four public test brokers that work straight away, and four local ones. See below. |

**Sample — HTTP** covers:

- every method: GET, POST, PUT, PATCH, DELETE, HEAD and OPTIONS
- query params and headers, including disabled rows
- `{{variables}}` in the path, params and headers
- JSON, raw text, urlencoded and multipart bodies
- Basic, Bearer and API-key auth, sent as a header or in the query string
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
- all against the public grpcb.in server

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

### Good to know

- The local MCP servers need [Node.js](https://nodejs.org). The first time
  you connect one, it's downloaded automatically, which can take a minute.
- The sample credentials (`jtaak-user`, `sample-token`, `sample-api-key`,
  and so on) are placeholders that the public test services accept. They
  aren't real accounts.
- **Scripts & tests → "A failing test (on purpose)"** is meant to fail, so
  you can see what a failed test looks like.
- These are free public services run by others. If one is slow or briefly
  unavailable, try again later, or switch to the other environment.
