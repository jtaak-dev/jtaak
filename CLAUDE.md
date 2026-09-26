# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

jtaak is a local-first API request engine and command-line client, published to npm as two packages: `@jtaak/engine` (the library) and `jtaak` (the CLI, command `jt`). It covers HTTP, GraphQL (with schema introspection), Server-Sent Events, unary gRPC, WebSocket and MCP (Model Context Protocol), plus collections, environments, pre-request/test scripts, a collection runner, Postman/OpenAPI/cURL import, a native export format and code snippets. No account, no cloud, no telemetry. Apache-2.0, copyright Jana Software Lab.

## Commands

A pnpm workspace (`pnpm@9.15.9` via corepack, Node 24 per `.nvmrc`; minimum 22.12). Root commands fan out with `pnpm -r`:

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
```

Single tests use Vitest directly:

```bash
pnpm --filter @jtaak/engine exec vitest run src/request/executor.test.ts
pnpm --filter @jtaak/engine exec vitest run -t "test name"
pnpm --filter jtaak start GET https://httpbin.org/get   # run the CLI from source via tsx
```

The CLI imports the engine through its built `dist/`; `pnpm test` and `pnpm typecheck` build it first, otherwise run `pnpm build:engine` after changing the engine.

CI (`.github/workflows/ci.yml`) runs a DCO sign-off check on pull requests, then install, format:check, lint, typecheck, test, build, check:pack and check:install. `.github/workflows/publish.yml` publishes both packages on a `v*` tag, using npm trusted publishing (no token); the tag must match both package versions.

## Architecture

- **`packages/engine`** (`@jtaak/engine`): must never import a UI framework or DOM APIs, so any Node.js application and the CLI share one tested implementation.
  - `request/executor.ts`: builds, sends and times HTTP (and GraphQL) requests with `fetch` and `performance.now()`. Performance matters (<5 ms engine overhead per request, excluding network time); keep this path free of anything not needed to build, send and time the request.
  - `request/grpc.ts`, `grpcProto.ts`: unary gRPC from a pasted `.proto`. `request/streamExecutor.ts` with `sse.ts`, `websocket.ts`, `mcp.ts`: long-lived streams, each with a `streamId`, emitting events. `mcp/`: the MCP client (JSON-RPC over HTTP or stdio).
  - `graphql/introspection.ts`: schema introspection.
  - `variables/resolver.ts`: resolves `{{var}}` with precedence `local > environment > collection > workspace > global`. An unresolved variable is left as-is, by design.
  - `scripting/sandbox.ts`: scripts run in **QuickJS** (`quickjs-emscripten`, WebAssembly), a fresh runtime per script with a 1 s deadline (covering promise callbacks) and a 64 MB memory cap. The script API is JavaScript source (`PRELUDE`) evaluated inside the sandbox, under the profile's namespace (`jt` by default); data crosses only as JSON. Never expose host functions to the sandbox. `scripting/runRequest.ts` runs pre-request script → resolve → send → test script. `runner/collectionRunner.ts` runs a list of requests in order.
  - `import/`: Postman collection and environment, OpenAPI and cURL importers, and `nativeImport.ts`. `export/nativeExport.ts` writes the native format (`format: 'jtaak-export'` by default, `version: 1`), deterministically, blanking credentials unless asked.
  - `codegen/snippets.ts`: code snippets for a request.
  - `storage/schema.ts`, `db.ts`, `repository.ts`, `migrations.ts`: SQLite (workspace → collection → folder → request / WebSocket connection / MCP connection, in `api`, `websocket` and `mcp` categories, plus environments and history). The schema is an inline SQL string, not a file read from disk. Migrations are numbered and tracked in `PRAGMA user_version`; append a new one, never edit a released one. A database from a newer version throws `DatabaseTooNewError`.
  - `types.ts`: the public types, including **`EngineProfile`**: the names users see (product name in messages, script namespace, export format id and file extension, MCP client name). `DEFAULT_ENGINE_PROFILE` is `jtaak` / `jt` / `jtaak-export` / `.jt` / `jtaak`. Functions that use one take an optional `profile` (`runScript`, `runRequestWithScripts`, `runCollection`, `openStream`, `exportNative`, `isNativeExport`, `validateNativeExport`); `connectMcpClient` takes the client name. Never hardcode a product name; add a profile setting instead.
  - **Build:** one native ESM build to `dist/` (`tsconfig.build.json`, `module: NodeNext`, no source maps; the build clears `dist/` first). Entry points: `.` (full engine) and `./browser` (`src/browser.ts`: types, resolver, snippets, cURL and `.proto` parsing, no Node built-ins or native modules). Relative imports need `.js`. No top-level `await`, so CommonJS consumers can `require()` the engine. CommonJS dependencies behave differently under Node's ESM than under Vitest (see the QuickJS and protobufjs import comments), so check dependency changes by loading `dist/` in plain Node.
  - `samples/jtaak-sample-workspace.jt`: a sample workspace covering every protocol; `src/import/sampleWorkspace.test.ts` checks it stays byte-for-byte what the exporter writes. `.gitattributes` keeps `*.jt` LF.
- **`packages/cli`** (`jtaak`, command `jt`): a minimal CLI (`jt <METHOD> <URL>`), meant to become a CI collection runner. Its `@jtaak/engine` dependency is `workspace:*`, which `pnpm pack` rewrites to the exact engine version; the two are always released together at the same version. Its tests run the CLI as a child process via `tsx`; `scripts/check-install.mjs` tests the published shape.

Dependency direction is `cli` → `engine`, never the reverse.

## Conventions

- TypeScript 6.0, strict; each package extends the root `tsconfig.base.json`.
- Tests: Vitest. HTTP tests use a local server, never the network. Performance-budget tests assert timing ceilings; keep them passing.
- Prettier (`.prettierrc.json`: single quotes, 120 columns); CI fails on unformatted files. Markdown and `*.jt` are excluded (`.prettierignore`).
- Every commit needs a DCO sign-off (`git commit -s`); see `CONTRIBUTING.md`.
