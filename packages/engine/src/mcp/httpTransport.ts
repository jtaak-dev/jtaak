import { SseFrameParser } from '../request/sse.js';
import type { JsonRpcMessage } from './jsonRpc.js';
import type { McpTransport } from './transport.js';

/**
 * MCP's "Streamable HTTP" transport: every outgoing message is its own
 * POST, and the server's response is either a single JSON body or a
 * `text/event-stream` — reusing the SSE client's `SseFrameParser` for the latter, since
 * the framing is identical. Only the per-request response is read; this
 * doesn't open a separate long-lived GET/SSE channel for the server to push
 * unsolicited messages on, which the full spec allows but which simple MCP
 * servers (and this transport's scope) don't need.
 *
 * Session tracking follows the spec too: the `Mcp-Session-Id` header the
 * server returns on its first response is echoed back on every request
 * after that.
 */
export function connectHttpTransport(url: string, headers: Record<string, string>): McpTransport {
  const messageListeners: Array<(message: JsonRpcMessage) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const closeListeners: Array<() => void> = [];

  let sessionId: string | undefined;

  async function post(message: JsonRpcMessage): Promise<void> {
    const requestHeaders: Record<string, string> = {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) requestHeaders['Mcp-Session-Id'] = sessionId;

    const response = await fetch(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(message) });

    const returnedSessionId = response.headers.get('mcp-session-id');
    if (returnedSessionId) sessionId = returnedSessionId;

    if (!response.ok) {
      throw new Error(`MCP HTTP request failed: ${response.status} ${response.statusText}`);
    }
    // A notification (no id) gets a bare 202 Accepted with no body.
    if (response.status === 202 || !response.body) return;

    const contentType = response.headers.get('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = (await response.json()) as JsonRpcMessage | JsonRpcMessage[];
      for (const parsed of Array.isArray(body) ? body : [body]) {
        for (const listener of messageListeners) listener(parsed);
      }
      return;
    }

    if (contentType.includes('text/event-stream')) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const sseMessage of parser.push(decoder.decode(value, { stream: true }))) {
          try {
            const parsed = JSON.parse(sseMessage.data) as JsonRpcMessage;
            for (const listener of messageListeners) listener(parsed);
          } catch {
            // Not a JSON-RPC frame — ignore rather than fail the whole stream.
          }
        }
      }
      return;
    }

    throw new Error(`Unexpected MCP response content-type: "${contentType}"`);
  }

  return {
    send: (message) => {
      post(message).catch((error: Error) => {
        for (const listener of errorListeners) listener(error);
      });
    },
    onMessage: (callback) => messageListeners.push(callback),
    onError: (callback) => errorListeners.push(callback),
    onClose: (callback) => closeListeners.push(callback),
    close: () => {
      for (const listener of closeListeners) listener();
    },
  };
}
