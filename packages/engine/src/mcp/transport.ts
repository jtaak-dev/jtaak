import type { JsonRpcMessage } from './jsonRpc.js';

/** What both transports (stdio.ts, httpTransport.ts) implement — client.ts
 * drives either one identically, never knowing which is underneath. */
export interface McpTransport {
  send(message: JsonRpcMessage): void;
  onMessage(callback: (message: JsonRpcMessage) => void): void;
  onError(callback: (error: Error) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}
