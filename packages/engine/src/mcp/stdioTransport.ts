import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import type crossSpawn from 'cross-spawn';
import type { JsonRpcMessage } from './jsonRpc.js';
import type { McpTransport } from './transport.js';

// cross-spawn, loaded when a stdio server is first started, so nothing loads for HTTP or the CLI (a CommonJS
// module, required synchronously: connecting returns the transport at once).
let spawnLoaded: typeof crossSpawn | undefined;
const spawn: typeof crossSpawn = ((...args: Parameters<typeof crossSpawn>) =>
  (spawnLoaded ??= createRequire(import.meta.url)('cross-spawn') as typeof crossSpawn)(...args)) as typeof crossSpawn;

/**
 * Spawns the MCP server as a child process and speaks newline-delimited
 * JSON-RPC over its stdin/stdout — the "stdio" transport most local MCP
 * servers use. Runs only in a Node process (such as the CLI), never browser-side code, for
 * the same reason storage/db.ts's better-sqlite3 does: `node:child_process`
 * isn't available there.
 */
export function connectStdioTransport(command: string, args: string[], env: Record<string, string>): McpTransport {
  // Most real MCP servers are launched via `npx <package>`: on Windows,
  // npx/npm/yarn/pnpm are .cmd shims, not real executables, which spawn()
  // can't start without a shell. cross-spawn finds the command on the PATH
  // (with PATHEXT), starts an .exe directly, and runs a .cmd or .bat through
  // cmd.exe with the command and each argument quoted and escaped for it. A
  // plain `shell: true` doesn't quote: a command or argument with a space
  // (C:\Program Files\nodejs\node.exe) breaks, and cmd.exe's own characters
  // in an argument (&, |, ^) would run as commands. On POSIX it's spawn().
  // A plain ChildProcess by its types; piped, its stdin and stdout are there.
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const messageListeners: Array<(message: JsonRpcMessage) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const closeListeners: Array<() => void> = [];

  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        for (const listener of messageListeners) listener(message);
      } catch (error) {
        for (const listener of errorListeners) {
          listener(new Error(`Malformed JSON-RPC line from MCP server: ${(error as Error).message}`));
        }
      }
    }
  });

  // MCP servers commonly log diagnostics to stderr — that's normal, not an
  // error condition, so it's intentionally not surfaced as one here.
  child.on('error', (error) => {
    for (const listener of errorListeners) listener(error);
  });
  child.on('close', () => {
    for (const listener of closeListeners) listener();
  });

  return {
    send: (message) => {
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    onMessage: (callback) => messageListeners.push(callback),
    onError: (callback) => errorListeners.push(callback),
    onClose: (callback) => closeListeners.push(callback),
    close: () => {
      // A command that never actually started (bad path, ENOENT) leaves the
      // child with no real OS process behind it — kill() on Windows throws
      // EINVAL in that case rather than being a harmless no-op like on
      // POSIX, so this only calls it when there's something to kill.
      if (child.pid !== undefined && !child.killed) {
        try {
          child.kill();
        } catch {
          // Already gone — nothing left to close.
        }
      }
    },
  };
}
