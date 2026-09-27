import type { KeyValue, MessagingPublish } from '../../types.js';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** A received payload as text, or as base64 with `isBinary` when it isn't valid UTF-8. */
export function decodePayload(bytes: Uint8Array): { payload: string; isBinary: boolean } {
  try {
    return { payload: strictUtf8.decode(bytes), isBinary: false };
  } catch {
    return {
      payload: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'),
      isBinary: true,
    };
  }
}

/** The bytes to publish: `payload` as UTF-8 text, or decoded from base64 for `encoding: 'base64'`. */
export function encodePayload(message: Pick<MessagingPublish, 'payload' | 'encoding'>): Buffer {
  return message.encoding === 'base64' ? Buffer.from(message.payload, 'base64') : Buffer.from(message.payload, 'utf-8');
}

/** The enabled headers with a name, as a record (a later row with the same name wins). */
export function headerRecord(headers: KeyValue[] | undefined): Record<string, string> | undefined {
  const enabled = (headers ?? []).filter((h) => h.enabled && h.key.trim().length > 0);
  if (enabled.length === 0) return undefined;
  return Object.fromEntries(enabled.map((h) => [h.key, h.value]));
}
