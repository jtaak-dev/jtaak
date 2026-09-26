# jtaak samples

## Sample workspace

**[`jtaak-sample-workspace.jt`](./jtaak-sample-workspace.jt)** is a workspace in
the engine's native export format (`format: "jtaak-export"`), exercising
every category and request protocol the engine supports. Every request
points at a free public test service, so it all works with no sign-up or
API keys. Its scripts use the default script API, `jt`.

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
