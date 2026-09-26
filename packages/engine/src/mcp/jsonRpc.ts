import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from '../types.js';

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

let nextId = 1;

export function createRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: '2.0', id: nextId++, method, params };
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params };
}

/** A notification has a `method` and no `id`. */
export function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

/** A response has an `id` and neither `method` nor `params` — just
 * `result`/`error`. Checked after `isNotification` so a request-shaped
 * message (`method` + `id`, sent server->client, e.g. `sampling/*`) isn't
 * mistaken for one; this client doesn't support handling those (see
 * client.ts) but shouldn't misroute them as responses either. */
export function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return 'id' in message && !('method' in message);
}
