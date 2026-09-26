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

Requires Node.js 22.12 or later.

## Usage

```
jt <METHOD> <URL>
jt <URL>            (GET)
```

It prints the status line, the time taken and the response size, then the
response body:

```
200 OK — 142ms, 1830B
{"users":[...]}
```

The exit code is non-zero if the request can't be sent.

## What's next

The CLI is at an early stage. The plan is a collection runner for CI: run a
workspace export (`.jt`), with its scripts and tests, and report the results.

## License

Apache-2.0. Copyright 2026 Jana Software Lab.
