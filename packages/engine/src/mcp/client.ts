import { buildRequestHeaders } from '../request/executor.js';
import { createNotification, createRequest, isNotification, isResponse } from './jsonRpc.js';
import { PendingCalls } from './pendingCalls.js';
import { connectStdioTransport } from './stdioTransport.js';
import { connectHttpTransport } from './httpTransport.js';
import { DEFAULT_ENGINE_PROFILE } from '../types.js';
import type { JsonRpcNotification, McpInitializeResult, McpProtocolConfig, RequestConfig } from '../types.js';

// The MCP spec version this client speaks — sent in `initialize` and not
// negotiated further; every server tested against so far accepts it.
const PROTOCOL_VERSION = '2025-06-18';

export interface McpClient {
  /** Resolves once `initialize` completes and `notifications/initialized`
   * has been sent — the point at which capability calls are safe to make. */
  ready: Promise<McpInitializeResult>;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

/**
 * Connects to an MCP server (stdio or HTTP, per `protocolConfig.transport`)
 * and drives the `initialize`/`initialized` handshake automatically.
 * `onNotification` receives every server-sent notification for as long as
 * the connection is open (progress updates, log messages, etc.) —
 * request/mcp.ts forwards these as `StreamEvent`s the same way SSE/WebSocket
 * forward theirs.
 */
export function connectMcpClient(
  config: RequestConfig,
  onNotification: (notification: JsonRpcNotification) => void,
  onError: (error: Error) => void,
  onClose: () => void,
  clientName: string = DEFAULT_ENGINE_PROFILE.mcpClientName,
): McpClient {
  const protocolConfig = config.protocolConfig as McpProtocolConfig | undefined;
  if (!protocolConfig) {
    throw new Error('MCP connections need protocolConfig: { transport, args?, env? }.');
  }

  const pending = new PendingCalls();
  const transport =
    protocolConfig.transport === 'stdio'
      ? connectStdioTransport(config.url, protocolConfig.args ?? [], protocolConfig.env ?? {})
      : connectHttpTransport(config.url, buildRequestHeaders(config), config);

  transport.onMessage((message) => {
    if (isResponse(message)) {
      pending.resolve(message);
      return;
    }
    if (isNotification(message)) {
      onNotification(message);
      return;
    }
    // A request FROM the server (e.g. sampling/createMessage) — this client
    // doesn't implement the server-initiated-request side of MCP, so there's
    // nothing correct to do with it beyond ignoring it.
  });
  transport.onError(onError);
  transport.onClose(() => {
    pending.rejectAll(new Error('MCP connection closed'));
    onClose();
  });

  function request(method: string, params?: unknown): Promise<unknown> {
    const message = createRequest(method, params);
    const result = pending.track(message.id);
    // A request that couldn't be delivered fails its own call (and so
    // `ready`, for initialize) instead of waiting forever for a response.
    Promise.resolve(transport.send(message)).catch((error: Error) => pending.reject(message.id, error));
    return result;
  }

  function notify(method: string, params?: unknown): void {
    // A notification has no call to fail, so report it on the connection.
    Promise.resolve(transport.send(createNotification(method, params))).catch(onError);
  }

  const ready = request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: clientName, version: '0.1.0' },
  }).then((result) => {
    notify('notifications/initialized');
    return result as McpInitializeResult;
  });

  return { ready, request, close: () => transport.close() };
}
