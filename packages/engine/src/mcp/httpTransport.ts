import { withErrorDetail } from '../request/errors.js';
import { SseFrameParser } from '../request/sse.js';
import { fetchFor } from '../request/tls.js';
import type { JsonRpcMessage } from './jsonRpc.js';
import type { McpTransport } from './transport.js';
import type { RequestConfig } from '../types.js';

/** The start of a failed answer's body, when it's text worth showing (a reason, not a web page). */
async function excerpt(response: Response): Promise<string> {
  const type = response.headers.get('content-type') ?? '';
  if (/html/i.test(type)) return '';
  const text = (await response.text().catch(() => '')).trim().replace(/\s+/g, ' ');
  return text ? `: ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}` : '';
}

/** Why an MCP server's HTTP answer failed, in words that say what to check. */
async function failure(response: Response, url: string, hadSession: boolean): Promise<string> {
  const answered = `${response.status} ${response.statusText}`.trim();
  const detail = await excerpt(response);
  if (response.status === 404 && hadSession) {
    return `The MCP session ended (the server answered ${answered}): connect again.`;
  }
  if (response.status === 404 || response.status === 405 || response.status === 410) {
    return (
      `${url} isn't an MCP endpoint: the server answered ${answered}${detail}. Check the URL: an MCP server usually ` +
      "answers at a path such as /mcp. A server that only speaks the older HTTP+SSE transport (an /sse URL) isn't supported."
    );
  }
  if (response.status === 401 || response.status === 403) {
    return `The MCP server refused the request (${answered})${detail}. It needs credentials: set them on the Auth or Headers tab.`;
  }
  return `MCP HTTP request failed: ${answered}${detail}`;
}

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
 *
 * `send` returns the POST's promise, which rejects (with the reason Node
 * keeps in the error's cause, see errors.ts) when the message couldn't be
 * delivered; client.ts turns that into a failed call.
 */
export function connectHttpTransport(
  url: string,
  headers: Record<string, string>,
  options: Pick<RequestConfig, 'verifyTls' | 'network'> = {},
): McpTransport {
  const send = fetchFor(options);
  const messageListeners: Array<(message: JsonRpcMessage) => void> = [];
  const closeListeners: Array<() => void> = [];

  let sessionId: string | undefined;

  async function post(message: JsonRpcMessage): Promise<void> {
    const requestHeaders: Record<string, string> = {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) requestHeaders['Mcp-Session-Id'] = sessionId;

    let response: Response;
    try {
      response = await send(url, { method: 'POST', headers: requestHeaders, body: JSON.stringify(message) });
    } catch (error) {
      throw withErrorDetail(error);
    }

    const returnedSessionId = response.headers.get('mcp-session-id');
    if (returnedSessionId) sessionId = returnedSessionId;

    if (!response.ok) throw new Error(await failure(response, url, Boolean(requestHeaders['Mcp-Session-Id'])));
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

    throw new Error(
      `${url} isn't an MCP endpoint: it answered with ${contentType ? `"${contentType.split(';')[0]}"` : 'no content type'} ` +
        'instead of JSON-RPC (application/json or text/event-stream). Check the URL: an MCP server usually answers at a path such as /mcp.',
    );
  }

  return {
    send: (message) => post(message),
    onMessage: (callback) => messageListeners.push(callback),
    // Delivery failures reject send's promise instead; nothing else fails
    // asynchronously in this transport.
    onError: () => {},
    onClose: (callback) => closeListeners.push(callback),
    close: () => {
      for (const listener of closeListeners) listener();
    },
  };
}
