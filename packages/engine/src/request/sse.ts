import { describeError } from './errors.js';
import { buildBody, buildRequestHeaders, buildUrl, hasHeader } from './executor.js';
import { fetchFor } from './tls.js';
import type { RequestConfig, SseMessage, StreamEvent, StreamHandle } from '../types.js';

/**
 * Incremental `text/event-stream` parser (per the WHATWG SSE spec): buffers
 * partial lines across chunk boundaries, tracks the current event's
 * `event`/`data`/`id` fields, and dispatches on a blank line. `retry` is
 * intentionally not tracked — reconnection policy is EventSource's job, not
 * this tool's; a test client doesn't auto-reconnect a dropped connection.
 */
// Exported so mcp/httpTransport.ts can reuse it for MCP's Streamable
// HTTP transport, whose SSE-mode responses are the same wire format.
export class SseFrameParser {
  private buffer = '';
  private eventType: string | undefined;
  private dataLines: string[] = [];
  private lastId: string | undefined;

  /** Feeds one decoded chunk, returning every message dispatched by it. */
  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const messages: SseMessage[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        const message = this.dispatch();
        if (message) messages.push(message);
        continue;
      }
      if (line.startsWith(':')) continue; // comment line — ignored per spec

      const colonIndex = line.indexOf(':');
      const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
      let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') this.eventType = value;
      else if (field === 'data') this.dataLines.push(value);
      else if (field === 'id') this.lastId = value;
      // 'retry' and any other field: ignored.
    }

    return messages;
  }

  private dispatch(): SseMessage | undefined {
    if (this.dataLines.length === 0) {
      this.eventType = undefined;
      return undefined;
    }
    const message: SseMessage = { event: this.eventType, data: this.dataLines.join('\n'), id: this.lastId };
    this.eventType = undefined;
    this.dataLines = [];
    return message;
  }
}

/** How much of a failed response's body goes in the error (an API's reason for a 401 or 400, say). */
const ERROR_BODY_LIMIT = 2000;

/**
 * Opens an SSE connection: sends the request (`config.method`, GET for a
 * plain event stream, or POST with its body, as AI APIs stream their
 * answers) with `Accept: text/event-stream`, and feeds the response body's
 * stream through `SseFrameParser`, emitting one `StreamEvent` per
 * dispatched message. A failed response's error includes the start of its
 * body; a response that isn't an event stream (a request that didn't ask to
 * stream) arrives as one message holding its whole body. `close()` aborts
 * the underlying fetch — the read loop's own catch treats that as a clean
 * close, not an error, since it was requested.
 */
export function openSseStream(config: RequestConfig, onEvent: (event: StreamEvent) => void): StreamHandle {
  const controller = new AbortController();
  let closedByCaller = false;

  (async () => {
    try {
      const headers = buildRequestHeaders(config);
      if (!hasHeader(headers, 'accept')) headers.Accept = 'text/event-stream';

      const method = config.method === 'HEAD' ? 'GET' : config.method;
      const body = method === 'GET' ? undefined : await buildBody(config);
      const response = await fetchFor(config)(buildUrl(config), {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = (await response.text().catch(() => '')).trim().slice(0, ERROR_BODY_LIMIT);
        onEvent({
          type: 'error',
          data: {
            message: `SSE connection failed: ${response.status} ${response.statusText}${detail ? `: ${detail}` : ''}`,
            status: response.status,
          },
          timestamp: Date.now(),
        });
        return;
      }
      onEvent({ type: 'open', timestamp: Date.now() });

      if (!/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
        const message: SseMessage = { event: 'message', data: await response.text() };
        onEvent({ type: 'message', data: message, timestamp: Date.now() });
        onEvent({ type: 'close', timestamp: Date.now() });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseFrameParser();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) {
          onEvent({ type: 'message', data: message, timestamp: Date.now() });
        }
      }
      onEvent({ type: 'close', timestamp: Date.now() });
    } catch (error) {
      onEvent({
        type: closedByCaller ? 'close' : 'error',
        data: closedByCaller ? undefined : { message: describeError(error) },
        timestamp: Date.now(),
      });
    }
  })();

  return {
    close: () => {
      closedByCaller = true;
      controller.abort();
    },
  };
}
