import { spawn } from 'node:child_process';
import type { JsonRpcMessage } from './jsonRpc.js';
import type { McpTransport } from './transport.js';

/**
 * Spawns the MCP server as a child process and speaks newline-delimited
 * JSON-RPC over its stdin/stdout — the "stdio" transport most local MCP
 * servers use. Runs only in a Node process (such as the CLI), never browser-side code, for
 * the same reason storage/db.ts's better-sqlite3 does: `node:child_process`
 * isn't available there.
 */
export function connectStdioTransport(command: string, args: string[], env: Record<string, string>): McpTransport {
  // Most real MCP servers are launched via `npx <package>` — on Windows,
  // npx/npm/yarn/pnpm are .cmd shims, not real executables, so spawn()
  // without a shell fails with ENOENT even though the command is spelled
  // correctly. `shell: true` on Windows only (POSIX doesn't need it, and
  // shell-quoting args there is unnecessary risk this avoids) is the
  // standard fix Node's own docs recommend for exactly this case.
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

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
