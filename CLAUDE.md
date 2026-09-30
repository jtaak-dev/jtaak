# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

jtaak is a local-first API request engine and command-line client, published to npm as two packages: `@jtaak/engine` (the library) and `jtaak` (the CLI, command `jt`). It covers HTTP, GraphQL (with schema introspection), Server-Sent Events, gRPC (unary, streaming, server reflection), SOAP 1.1 and 1.2 (`request/soap.ts`: `soapAsHttp`, `parseSoapFault`), WebSocket, MCP (Model Context Protocol) and messaging (MQTT, Kafka, Socket.IO, AMQP and NATS), plus collections, environments, pre-request/test scripts, a collection runner, Postman/OpenAPI/cURL import, a native export format and code snippets. No account, no cloud, no telemetry. Apache-2.0, copyright Jana Software Lab.

## Commands

A pnpm workspace (`pnpm@9.15.9` via corepack, Node 24 per `.nvmrc`; minimum 22.22, which the Kafka client needs). Root commands fan out with `pnpm -r`:

```bash
pnpm install
pnpm lint                  # ESLint (flat config in eslint.config.mjs)
pnpm test                  # builds the engine first, then every package's tests
pnpm typecheck             # builds the engine first (pretypecheck), then typechecks every package
pnpm build
pnpm build:engine
pnpm format                # Prettier; CI runs pnpm format:check
pnpm check:pack            # publint (+ arethetypeswrong for the engine) on the packed packages
pnpm check:install         # packs both, installs them with npm into an empty folder, runs `jt` (needs network)
pnpm bench                 # builds the engine, then packages/engine/bench/bench.mjs against dist/ (--quick: a tenth)
```

Single tests use Vitest directly:

```bash
pnpm --filter @jtaak/engine exec vitest run src/request/executor.test.ts
pnpm --filter @jtaak/engine exec vitest run -t "test name"
pnpm --filter jtaak start GET https://httpbin.org/get   # run the CLI from source via tsx
```

The CLI imports the engine through its built `dist/`; `pnpm test` and `pnpm typecheck` build it first, otherwise run `pnpm build:engine` after changing the engine.

CI (`.github/workflows/ci.yml`) runs a DCO sign-off check on pull requests, then install, format:check, lint, typecheck, test, build, the benchmarks (their table goes to the job summary; they report, they don't fail the build), check:pack and check:install. The engine README's Performance table is one run of `pnpm bench`; update it when the numbers move. `.github/workflows/publish.yml` publishes both packages on a `v*` tag, using npm trusted publishing (no token); the tag must match both package versions.

## Architecture

- **`packages/engine`** (`@jtaak/engine`): must never import a UI framework or DOM APIs, so any Node.js application and the CLI share one tested implementation.
  - `request/executor.ts`: builds, sends and times HTTP (and GraphQL) requests with `fetch` and `performance.now()`. `request/timing.ts` breaks the time into DNS, connect, TLS, wait and download (`timings.phases`) from Node's diagnostics-channel events (`net.client.socket`, `undici:request:*`, `undici:client:sendHeaders`): undici's request object is tied to the calling fetch through `AsyncLocalStorage` when created, and connections are timed on the socket and claimed by the first request sent over them. Don't attribute socket-level events by async context alone; they run in the socket creator's context. Performance matters (<5 ms engine overhead per request, excluding network time); keep this path free of anything not needed to build, send and time the request.
  - `request/tls.ts`: `RequestConfig.verifyTls: false` skips the certificate check for every protocol. `fetchFor(config)` returns Node's built-in `fetch`, or for `verifyTls: false` or `network` settings the `undici` package's own `fetch` with its own dispatchers, chosen per URL (never mix the package's dispatcher with Node's bundled undici; it also only sends its own `FormData`, so `fetchFor` converts Node's); both publish the diagnostics events timing uses. `request/network.ts`: `RequestConfig.network` (a proxy, client certificates per host pattern, extra CAs), host settings rather than the request's, so `storableConfig` strips it before storage and history. `tlsOptionsFor` gives every TLS client (fetch, `ws`, gRPC via `createFromSecureContext`, the messaging adapters) the same options; WebSocket proxies through `https-proxy-agent` (loaded only when used) and gRPC through grpc-js's own CONNECT channel options. `request/errors.ts`: `describeError` adds Node's `error.cause` chain to a message (fetch's own is just "fetch failed"); use it wherever a connection error reaches a user.
  - `request/grpc.ts`, `grpcProto.ts`: gRPC calls from a pasted `.proto` or a reflected schema (`GrpcProtocolConfig.source`, `grpcRoot`); `grpc.ts`'s `prepareGrpcCall` is shared by the unary call and `grpcStream.ts` (server, client and bidirectional streams through `openStream`). `grpcReflection.ts`: server reflection (v1, then v1alpha), tested against `@grpc/reflection`. `request/streamExecutor.ts` with `sse.ts`, `websocket.ts`, `mcp.ts`: long-lived streams, each with a `streamId`, emitting events. `mcp/`: the MCP client (JSON-RPC over HTTP or stdio).
  - `request/messaging/`: brokers behind one `MessagingStreamHandle` (`subscribe`, `unsubscribe`, `publish`), opened through `openStream`. `index.ts` owns the connection's life (calls made before it opens wait for it, errors go through `describeError`, nothing is reported after `close()`, published messages are echoed as `sent`), and each protocol is an adapter (`adapter.ts`'s `ConnectAdapter`: `mqtt.ts`, `socketio.ts`, `amqp.ts`, `nats.ts`, `kafka.ts`). Kafka, RabbitMQ, NATS and MQTT 5 are tested against real brokers in containers (`*.containers.test.ts`, `src/test/containers.ts`, Testcontainers with Docker or Podman). The engine's `pnpm test` runs Vitest's `unit` project, then its `containers` project, so brokers starting up don't slow the performance-budget tests. Without a container runtime those tests are skipped; CI sets `JTAAK_REQUIRE_CONTAINERS`, which makes that a failure. Adapters load their client library with `import()` only when a connection opens, so nothing loads for HTTP or the CLI; keep it that way, and check a new library through `dist/` in plain Node (the CommonJS ones export on `default` there).
  - `graphql/introspection.ts`: schema introspection.
  - `variables/resolver.ts`: resolves `{{var}}` with precedence `local > environment > collection > workspace > global`. An unresolved variable is left as-is, by design.
  - `scripting/sandbox.ts`: scripts run in **QuickJS** (`quickjs-emscripten`, WebAssembly), a fresh runtime per script with a 1 s deadline (covering promise callbacks) and a 64 MB memory cap. QuickJS's interrupt only fires between bytecode instructions, so the whole run is also wrapped in a Node `vm` timeout (`withHardStop`) that terminates a single long built-in call; the QuickJS module is then discarded and reloaded, never reused. The script API is JavaScript source (`PRELUDE`) evaluated inside the sandbox, under the profile's namespace (`jt` by default); data crosses only as JSON. Never expose host functions to the sandbox. `scripting/runRequest.ts` runs pre-request script → resolve → send → test script. `runner/collectionRunner.ts` runs a list of requests in order.
  - `import/`: Postman collection and environment, OpenAPI, cURL and WSDL importers, and `nativeImport.ts`. `wsdl.ts` reads WSDL 1.1 (with the documents `loadWsdl` collects) through `xml.ts`, a small namespace-aware XML parser (no DTDs or external entities), and builds each operation's envelope from its XML Schema types. `export/nativeExport.ts` writes the native format (`format: 'jtaak-export'` by default, `version: 1`), deterministically, blanking credentials unless asked.
  - `codegen/snippets.ts`: code snippets for a request.
  - `storage/history.ts`: request history per workspace (`request_history`, from migration 2): add, list (newest first, cursor-paged, searchable), get, delete, clear, prune. It stores the config as given (the caller decides whether variables are resolved) and cuts bodies over 256 kB.
  - `storage/examples.ts`: response examples (`response_examples`, migration 8): responses saved under a name for a request, deleted with it; native exports carry them on request items (`examples`, secret-named headers blanked), and Postman's saved responses import as them.
  - `storage/schema.ts`, `db.ts`, `repository.ts`, `migrations.ts`: SQLite (workspace → collection → folder → request / WebSocket connection / MCP connection, in `api`, `websocket` and `mcp` categories, plus environments and history). The schema is an inline SQL string, not a file read from disk. Migrations are numbered and tracked in `PRAGMA user_version`; append a new one, never edit a released one. A database from a newer version throws `DatabaseTooNewError`.
  - `types.ts`: the public types, including **`EngineProfile`**: the names users see (product name in messages, script namespace, export format id and file extension, MCP client name). `DEFAULT_ENGINE_PROFILE` is `jtaak` / `jt` / `jtaak-export` / `.jt` / `jtaak`. Functions that use one take an optional `profile` (`runScript`, `runRequestWithScripts`, `runCollection`, `openStream`, `exportNative`, `isNativeExport`, `validateNativeExport`); `connectMcpClient` takes the client name. Never hardcode a product name; add a profile setting instead.
  - **Build:** one native ESM build to `dist/` (`tsconfig.build.json`, `module: NodeNext`, no source maps; the build clears `dist/` first). Entry points: `.` (full engine) and `./browser` (`src/browser.ts`: types, resolver, snippets, cURL and `.proto` parsing, no Node built-ins or native modules). Relative imports need `.js`. No top-level `await`, so CommonJS consumers can `require()` the engine. CommonJS dependencies behave differently under Node's ESM than under Vitest (see the QuickJS and protobufjs import comments), so check dependency changes by loading `dist/` in plain Node.
  - `samples/jtaak-sample-workspace.jt`: a sample workspace covering every protocol; `src/import/sampleWorkspace.test.ts` checks it stays byte-for-byte what the exporter writes. `.gitattributes` keeps `*.jt` LF.
- **`packages/cli`** (`jtaak`, command `jt`): `jt <METHOD> <URL>` sends one request; `jt run <export>` (`src/run.ts`, output in `src/report.ts`) runs an export's requests with their scripts for CI, via the engine's `runnableRequestsFromExport`, `runCollection` and `junitReport`, and exits 0/1/2 (passed / failed / couldn't start). The logic is `src/cli.ts`'s `runCli(argv, { command, profile })`, which returns the exit code (never calls `process.exit`); `src/index.ts` is the bin that calls it, and the `jtaak/cli` subpath exports it so an application built on jtaak can ship the CLI under its own command name and `EngineProfile`. Usage text takes the command name; never hardcode `jt` in it. Its `@jtaak/engine` dependency is `workspace:*`, which `pnpm pack` rewrites to the exact engine version; the two are always released together at the same version. Its tests run the CLI as a child process via `tsx`; `scripts/check-install.mjs` tests the published shape.

Dependency direction is `cli` → `engine`, never the reverse.

## Conventions

- TypeScript 6.0, strict; each package extends the root `tsconfig.base.json`.
- Tests: Vitest. HTTP tests use a local server, never the network. Performance-budget tests assert timing ceilings; keep them passing.
- Prettier (`.prettierrc.json`: single quotes, 120 columns); CI fails on unformatted files. Markdown and `*.jt` are excluded (`.prettierignore`).
- Every commit needs a DCO sign-off (`git commit -s`); see `CONTRIBUTING.md`.
