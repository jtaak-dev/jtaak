import type {
  MessagingMessage,
  MessagingPublish,
  MessagingPublishResult,
  MessagingSubscription,
  RequestConfig,
} from '../../types.js';

/** What an adapter reports while its connection is open. */
export interface AdapterEvents {
  message(message: Omit<MessagingMessage, 'direction'>): void;
  error(error: unknown): void;
  /** The connection ended, whether the broker closed it or it was lost; `reason` says which when known. */
  close(reason?: string): void;
}

/** One protocol's connection, once open. messaging/index.ts wraps it in the
 * public `MessagingStreamHandle`, so adapters only deal with their client. */
export interface MessagingAdapter {
  /** Details for the stream's `'open'` event (protocol version, client id…). */
  info: Record<string, unknown>;
  subscribe(subscription: MessagingSubscription): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  publish(message: MessagingPublish): Promise<MessagingPublishResult>;
  close(): Promise<void>;
}

/** Connects, resolving once the broker has accepted the connection, or rejecting with why it didn't. */
export type ConnectAdapter = (config: RequestConfig, events: AdapterEvents) => Promise<MessagingAdapter>;

/** A named option, checked to be one of `allowed`; absent gives `fallback`. */
export function optionOneOf<T>(
  options: Record<string, unknown> | undefined,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = options?.[name];
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T))
    throw new Error(`${name} must be one of ${allowed.join(', ')}; got ${String(value)}.`);
  return value as T;
}

/** Refuses message fields the protocol has no place for, rather than dropping them unseen. */
export function refuseUnsupported(
  protocolName: string,
  message: MessagingPublish,
  unsupported: readonly ('key' | 'headers')[],
): void {
  if (unsupported.includes('key') && message.key) throw new Error(`${protocolName} messages have no key.`);
  if (unsupported.includes('headers') && (message.headers ?? []).some((h) => h.enabled && h.key.trim())) {
    throw new Error(`${protocolName} messages have no headers.`);
  }
}
