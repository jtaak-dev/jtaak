import WebSocket from 'ws';
import { describeError } from './errors.js';
import { buildRequestHeaders, buildUrl } from './executor.js';
import { verifiesTls } from './tls.js';
import type { RequestConfig, StreamEvent, StreamHandle, WebSocketProtocolConfig } from '../types.js';

/**
 * Opens a full-duplex WebSocket connection. Uses the `ws` package rather
 * than the platform/undici `WebSocket` global specifically because the
 * WHATWG spec's constructor has no way to set request headers (a browser
 * security restriction that doesn't apply to a Node-side test client) —
 * `ws`'s Node-specific `headers` option is what lets auth/custom headers
 * reach the handshake at all.
 */
export function openWebSocketStream(config: RequestConfig, onEvent: (event: StreamEvent) => void): StreamHandle {
  const headers = buildRequestHeaders(config);
  const subprotocols = (config.protocolConfig as WebSocketProtocolConfig | undefined)?.subprotocols ?? [];

  const ws = new WebSocket(buildUrl(config), subprotocols, { headers, rejectUnauthorized: verifiesTls(config) });

  ws.on('open', () => onEvent({ type: 'open', timestamp: Date.now() }));

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    onEvent({
      type: 'message',
      data: { data: isBinary ? data.toString('base64') : data.toString('utf-8'), isBinary, direction: 'received' },
      timestamp: Date.now(),
    });
  });

  // The server rejected the handshake itself (wrong path, auth failure,
  // etc.) — 'error' alone would report this as an opaque socket error, so
  // this surfaces the actual HTTP status instead.
  ws.on('unexpected-response', (_req, res) => {
    onEvent({
      type: 'error',
      data: { message: `WebSocket handshake failed: ${res.statusCode} ${res.statusMessage}` },
      timestamp: Date.now(),
    });
    ws.terminate();
  });

  ws.on('error', (error: Error) => {
    onEvent({ type: 'error', data: { message: describeError(error) }, timestamp: Date.now() });
  });

  ws.on('close', (code: number, reason: Buffer) => {
    onEvent({ type: 'close', data: { code, reason: reason.toString('utf-8') }, timestamp: Date.now() });
  });

  return {
    send: (data: unknown) => {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      ws.send(text);
      onEvent({ type: 'message', data: { data: text, isBinary: false, direction: 'sent' }, timestamp: Date.now() });
    },
    close: () => {
      // WebSocket.CONNECTING: close() during the handshake is a no-op per
      // the spec that `ws` follows — terminate() is what actually aborts it.
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    },
  };
}
