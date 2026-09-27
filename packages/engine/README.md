# @jtaak/engine

A local-first API request engine for Node.js. It sends and times HTTP, GraphQL,
Server-Sent Events, unary gRPC, WebSocket and MCP (Model Context Protocol)
requests; runs pre-request and test scripts in a sandbox; resolves `{{variables}}`;
imports Postman, OpenAPI and cURL; and stores workspaces, collections and
environments in SQLite. It has no UI, no account and no telemetry: it only ever
talks to the APIs you send requests to.

It's the engine behind the [`jtaak` CLI](https://www.npmjs.com/package/jtaak), and
is built to be embedded in other tools.

```bash
npm install @jtaak/engine
```

Requires Node.js 22.12 or later. The package is ESM only. SQLite comes from
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

`protocol: 'graphql'` sends GraphQL over HTTP. For long-lived connections
(`sse`, `websocket`, `mcp`) use `openStream(config, onEvent)`, and for unary gRPC
calls from a pasted `.proto` file, `executeGrpcUnaryCall(config)`.

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
`jt.response`, `jt.request` (read-only) and `jt.variables`. They also get
`console`, whose output is returned in `scriptLogs`.

Scripts run in [QuickJS](https://github.com/justjake/quickjs-emscripten), a
separate JavaScript engine compiled to WebAssembly: a fresh runtime per script,
a 1 s deadline (including promise callbacks) and a 64 MB memory cap. The
deadline is hard: a script still running just after it, even inside one long
built-in call such as a large `sort`, is terminated. They get no
Node.js or host objects, no timers and no network; data goes in and out only as
JSON.

`runCollection(requests, scopes, onProgress)` runs a list of requests in order
with their scripts and returns a pass/fail report.

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
`{{variables}}` could hold secrets. Response bodies over 256 kB are cut
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
