import { connectMcpClient } from '../mcp/client.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { RequestConfig, StreamEvent, StreamHandle } from '../types.js';

/** `openStream`'s generic `StreamHandle` has no notion of a correlated
 * request/response — `send` is fire-and-forget, which fits WebSocket/SSE
 * but not MCP, where every call needs its own matched result. `request`
 * is the escape hatch: a host application calls it directly for
 * `tools/list`, `tools/call`, `resources/read`, etc. */
export interface McpStreamHandle extends StreamHandle {
  request(method: string, params?: unknown): Promise<unknown>;
}

/**
 * Opens an MCP connection: connects (stdio or HTTP, per `protocolConfig`),
 * runs the `initialize`/`initialized` handshake, and emits `'open'` with
 * the handshake result once it completes. Server notifications arrive as
 * `'message'` events; the handle's `request()` is how a caller actually
 * drives the session (list/call tools, read resources, get prompts).
 */
export function openMcpStream(
  config: RequestConfig,
  onEvent: (event: StreamEvent) => void,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): McpStreamHandle {
  const client = connectMcpClient(
    config,
    (notification) => onEvent({ type: 'message', data: notification, timestamp: Date.now() }),
    (error) => onEvent({ type: 'error', data: { message: error.message }, timestamp: Date.now() }),
    () => onEvent({ type: 'close', timestamp: Date.now() }),
    profile.mcpClientName,
  );

  client.ready
    .then((result) => onEvent({ type: 'open', data: result, timestamp: Date.now() }))
    .catch((error: Error) => onEvent({ type: 'error', data: { message: error.message }, timestamp: Date.now() }));

  return {
    request: (method, params) => client.request(method, params),
    close: () => client.close(),
  };
}
