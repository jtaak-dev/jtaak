import type { JsonRpcResponse } from '../types.js';

/** Correlates outgoing JSON-RPC requests with their eventual response by
 * id — shared by both transports (stdio.ts, httpTransport.ts) since the
 * correlation logic itself doesn't depend on how bytes actually move. */
export class PendingCalls {
  private pending = new Map<string | number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  track(id: string | number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  /** Resolves/rejects the matching pending call, if any. Returns `false` for
   * a response with no tracked call (e.g. arrived after `rejectAll`). */
  resolve(response: JsonRpcResponse): boolean {
    const entry = this.pending.get(response.id);
    if (!entry) return false;
    this.pending.delete(response.id);
    if (response.error) entry.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
    else entry.resolve(response.result);
    return true;
  }

  /** Called when the connection closes/errors — every still-outstanding
   * call would otherwise hang forever waiting for a response that can no
   * longer arrive. */
  rejectAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }
}
