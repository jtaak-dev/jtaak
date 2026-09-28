# jtaak

A local-first API request engine and command-line client. It sends and times
HTTP, GraphQL, Server-Sent Events, gRPC (unary and streaming), WebSocket and MCP (Model Context
Protocol) requests, connects to MQTT, Kafka, Socket.IO, AMQP and NATS, runs
pre-request and test scripts in a sandbox, imports Postman, OpenAPI and cURL,
and stores its data in SQLite. No account, no cloud, no telemetry: it only talks
to the APIs you send requests to.

| Package | What it is |
|---|---|
| [`@jtaak/engine`](packages/engine) | The engine, as a library for Node.js. Embed it in your own tools. |
| [`jtaak`](packages/cli) | The command-line client, `jt`. |

```bash
npx jtaak GET https://api.example.com/users
```

```ts
import { executeRequest } from '@jtaak/engine';
```

Both need Node.js 22.22 or later. See each package's README for details.

## Development

The repository is a pnpm workspace. Use the Node.js version in `.nvmrc` and the
pnpm version pinned in `package.json` (`corepack enable` sets that up).

```bash
pnpm install
pnpm test          # builds the engine, then runs every package's tests
pnpm typecheck
pnpm lint
pnpm format        # CI runs pnpm format:check
pnpm build
pnpm check:pack    # publint and arethetypeswrong on the packed packages
pnpm check:install # installs the packed packages with npm and runs `jt` (needs network)
```

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a
security problem, see [SECURITY.md](SECURITY.md).

## License

Apache-2.0. Copyright 2026 Jana Software Lab. See [LICENSE](LICENSE) and
[NOTICE](NOTICE).
