# Contributing to jtaak

Thanks for helping. Bug reports, fixes and new features are all welcome. For
anything large, open an issue first so we can agree on the approach.

## Sign off your commits (DCO)

jtaak uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) instead of a contributor licence agreement. By signing off a commit, you
certify that you wrote it, or otherwise have the right to submit it under the
project's licence (Apache-2.0).

Sign off every commit with `-s`:

```bash
git commit -s -m "Fix header parsing for repeated keys"
```

That adds a line with your name and email to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

CI rejects a pull request with an unsigned commit. To sign off commits you've
already made, run `git rebase --signoff main` and force-push the branch.

## Setting up

1. Use the Node.js version in `.nvmrc` (for example with `nvm use`).
2. Run `corepack enable`, so `pnpm` is the version pinned in `package.json`.
3. Run `pnpm install`.

## Before opening a pull request

Run the same checks CI runs:

```bash
pnpm format:check   # or pnpm format to fix
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:pack
```

Add or update tests with your change. Tests never use the network: HTTP tests
run against a local server.

## Things to know about the code

- **The engine has no UI.** It must not import a UI framework or DOM APIs, so
  that any Node.js application (and the CLI) can use it.
- **Offline first.** The engine only ever talks to the APIs a user sends
  requests to. No telemetry or other network calls.
- **Scripts stay sandboxed.** Scripts run in QuickJS; data crosses into and out
  of the sandbox only as JSON. Don't expose host functions to scripts.
- **Database migrations are append-only.** To change the schema, add a new
  numbered migration in `packages/engine/src/storage/migrations.ts`; never edit
  one that has been released.
- **ESM everywhere.** Relative imports need their `.js` extension. The engine
  must not use top-level `await`, so CommonJS applications can still
  `require()` it. When changing a CommonJS dependency, check the built `dist/`
  loads in plain Node, not only in the tests (Vitest resolves modules
  differently).
- **User-facing names are settings.** Product name, script namespace (`jt`),
  export format and extension (`.jt`) come from `EngineProfile`, so embedding
  applications can use their own. Don't hardcode them.
- Code is formatted with Prettier (single quotes, 120 columns).
