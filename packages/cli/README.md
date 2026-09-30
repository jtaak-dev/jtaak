# jtaak

A command-line API client, built on [`@jtaak/engine`](https://www.npmjs.com/package/@jtaak/engine).
It's local-first: no account and no telemetry, and it only talks to the APIs you
send requests to.

```bash
npm install -g jtaak
jt GET https://api.example.com/users
```

Or without installing:

```bash
npx jtaak GET https://api.example.com/users
```

Requires Node.js 22.22 or later.

## Usage

```
jt <METHOD> <URL>
jt <URL>            (GET)
```

Add `-k` (or `--insecure`), as in curl, to skip checking the server's TLS
certificate: for testing a server with a self-signed or expired certificate.
The connection is still encrypted, but not authenticated.

Requests go through the proxy in `HTTPS_PROXY` (or `HTTP_PROXY`) when it's
set, except to the hosts in `NO_PROXY`, as with curl.

It prints the status line, the time taken and the response size, then the
response body:

```
200 OK — 142ms, 1830B
{"users":[...]}
```

The exit code is non-zero if the request can't be sent.

## Running a collection: `jt run`

`jt run` runs the requests in an export file (`.jt`), in order, with their
pre-request and test scripts, and reports each one as it finishes:

```bash
jt run shop.jt --env Staging --junit results.xml
```

```
jt run shop.jt, environment "Staging": 3 requests

Shop
  ✓ Log in POST {{base}}/login → 200 OK, 88 ms
      ✓ status is 200
  ✓ Profile GET {{base}}/me → 200 OK, 12 ms
      ✓ has the session

Shop / Admin
  ✗ Delete user DELETE {{base}}/users/7 → 403 Forbidden, 9 ms
      ✗ status is 204: expected 403 to be 204

3 requests, 3 tests (1 failed), 0.2 s
```

It exits with 0 when every request was sent and every test passed, 1 when
not, and 2 when the run couldn't start (a bad option or file), so it can gate
a CI job. Cookies are kept from one request to the next, and what a script
sets in `jt.environment` reaches the requests after it, as in a run from an
app. OAuth 2.0 client credentials and password tokens are got as needed;
the authorization code grant needs a browser, so give such requests a token
another way (a `{{variable}}` in a Bearer token, say).

| Option                | What it does                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| `-e, --env <name>`    | Use one of the file's environments                                          |
| `--env-file <file>`   | Variables from JSON: `{ "name": "value" }`, or an exported environment (native or Postman) |
| `--var <name=value>`  | Set a variable; repeatable, and wins over the environment                   |
| `--folder <name>`     | Only one collection or folder: its name, or a path such as `Shop/Admin`    |
| `--junit <file>`      | Also write the results as JUnit XML, which CI systems show as test results  |
| `--bail`              | Stop after the first request that fails                                     |
| `-k, --insecure`      | Don't check servers' TLS certificates (for testing only)                    |
| `--proxy <url>`       | Send through this HTTP(S) proxy (`user:password@` in it is its login); default `$HTTPS_PROXY` or `$HTTP_PROXY` |
| `--noproxy <hosts>`   | Comma-separated hosts reached directly; default `$NO_PROXY`                 |
| `--cacert <file>`     | Also trust this certificate authority (PEM); repeatable                     |
| `--cert <file>`, `--key <file>`, `--pass <phrase>` | A client certificate for servers that ask for one: PEM with its key, or a `.pfx`/`.p12`, and its passphrase |
| `--format <id>`, `--namespace <name>` | For an export from another app built on jtaak: its format id and its scripts' namespace |

gRPC, SSE, WebSocket and other streaming requests are listed as skipped.

In a CI job, for example GitHub Actions:

```yaml
- run: npx jtaak run api-tests.jt --env CI --junit results.xml
```

then hand `results.xml` to your CI's JUnit test reporter to see each test in
the job's results.

## Shipping the CLI under your own name

An application built on jtaak can ship this CLI as its own command, reading
its own export format and running scripts under its own namespace, the same
way it passes an `EngineProfile` to the engine. Depend on `jtaak` and call
`runCli` from your bin:

```js
#!/usr/bin/env node
import { runCli } from 'jtaak/cli';
import { DEFAULT_ENGINE_PROFILE } from '@jtaak/engine';

const profile = { ...DEFAULT_ENGINE_PROFILE, productName: 'Acme', scriptNamespace: 'acme', exportFormat: 'acme-export', exportExtension: '.acme' };
process.exitCode = await runCli(process.argv.slice(2), { command: 'acme', profile });
```

`runCli(argv, { command, profile })` takes the arguments after the command
name and resolves to the exit code; it never exits the process. The usage
text and messages show `command` (default `jt`). `acme run` reads exports in
the profile's `exportFormat` and runs their scripts under its
`scriptNamespace` (default `DEFAULT_ENGINE_PROFILE`); `--format` and
`--namespace` still override them. `jtaak/cli` is a plain ES module, so a
CommonJS bin can `require('jtaak/cli')` on Node 22 and later.

## License

Apache-2.0. Copyright 2026 Jana Software Lab.
