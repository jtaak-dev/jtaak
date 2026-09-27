import type { JsonRpcMessage } from './jsonRpc.js';

/** What both transports (stdio.ts, httpTransport.ts) implement — client.ts
 * drives either one identically, never knowing which is underneath. */
export interface McpTransport {
  /** The HTTP transport returns the POST's promise, which rejects if that
   * message couldn't be delivered, so client.ts can fail the matching call
   * rather than leave it waiting for a response that won't come. stdio
   * writes to a pipe and reports failures through `onError`/`onClose`. */
  send(message: JsonRpcMessage): void | Promise<void>;
  onMessage(callback: (message: JsonRpcMessage) => void): void;
  onError(callback: (error: Error) => void): void;
  onClose(callback: () => void): void;
  close(): void;
}
