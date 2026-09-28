import type { ManagerOptions, Socket, SocketOptions } from 'socket.io-client';
import { buildRequestHeaders } from '../executor.js';
import { tlsOptionsForUrl } from '../network.js';
import type { MessagingPublish, RequestConfig, SocketIoProtocolConfig } from '../../types.js';
import { optionOneOf, refuseUnsupported, type AdapterEvents, type MessagingAdapter } from './adapter.js';
import { decodePayload, encodePayload } from './payload.js';

/** Subscribing to this channel receives every event. */
const ALL_EVENTS = '*';

/** One event argument as text: strings as they are, binary as base64, anything else as JSON. */
function argumentPayload(value: unknown): { payload: string; isBinary: boolean } {
  if (typeof value === 'string') return { payload: value, isBinary: false };
  if (value instanceof ArrayBuffer) return decodePayload(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return decodePayload(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return { payload: JSON.stringify(value) ?? 'undefined', isBinary: false };
}

/** An event's arguments as one payload: a single argument as itself, several as a JSON array. */
function eventPayload(args: unknown[]): { payload: string; isBinary: boolean } {
  if (args.length === 1) return argumentPayload(args[0]);
  return { payload: JSON.stringify(args), isBinary: false };
}

/** The reason behind a transport error ("websocket error", "xhr poll error"):
 * Socket.IO puts it in `description`, as an error or as the WebSocket's
 * error event wrapping one. */
function transportCause(description: unknown): Error | undefined {
  if (description instanceof Error) return description;
  const event = description as { error?: unknown; message?: unknown } | undefined;
  if (event?.error instanceof Error) return event.error;
  if (typeof event?.message === 'string' && event.message) return new Error(event.message);
  return undefined;
}

/** What to emit for a payload: binary for base64, a JSON value when it parses as JSON, else the text. */
function emitArguments(message: MessagingPublish): unknown[] {
  if (message.encoding === 'base64') return [encodePayload(message)];
  const spread = optionOneOf(message.options, 'spread', [true, false], false);
  let value: unknown = message.payload;
  try {
    value = JSON.parse(message.payload);
  } catch {
    // Not JSON: sent as a string.
  }
  if (spread) {
    if (!Array.isArray(value)) throw new Error('spread needs the payload to be a JSON array of arguments.');
    return value;
  }
  return [value];
}

/**
 * Socket.IO v4 with `socket.io-client`, over WebSocket (falling back to
 * long-polling). `url`'s path is the namespace. Channels are event names;
 * subscribing to `*` receives every event. Like the other adapters, it
 * doesn't reconnect by itself.
 */
export async function connectSocketIo(config: RequestConfig, events: AdapterEvents): Promise<MessagingAdapter> {
  const settings = (config.protocolConfig ?? {}) as SocketIoProtocolConfig;
  const { io } = await import('socket.io-client');

  const token = config.auth.type === 'bearer' ? config.auth.bearer?.token : undefined;
  const headers = buildRequestHeaders({
    ...config,
    auth: config.auth.type === 'bearer' ? { type: 'none' } : config.auth,
  });
  const options: Partial<ManagerOptions & SocketOptions> = {
    path: settings.path ?? '/socket.io',
    transports: settings.transports ?? ['websocket', 'polling'],
    timeout: (settings.connectTimeout ?? 20) * 1000,
    reconnection: false,
    forceNew: true,
    // Passed to tls.connect, which takes a Buffer for pfx (the types say string).
    ...(tlsOptionsForUrl(config, config.url) as { pfx?: string }),
    auth: { ...settings.auth, ...(token && { token }) },
    ...(Object.keys(headers).length > 0 && { extraHeaders: headers }),
  };

  const socket: Socket = io(config.url, options);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error: Error & { description?: unknown }) => {
      socket.close();
      reject(new Error(error.message, { cause: transportCause(error.description) }));
    });
  });

  const subscribed = new Set<string>();
  socket.onAny((event: string, ...args: unknown[]) => {
    if (!subscribed.has(ALL_EVENTS) && !subscribed.has(event)) return;
    // A server asking for an acknowledgement passes a callback last; it isn't data.
    const ackRequested = typeof args.at(-1) === 'function';
    const data = ackRequested ? args.slice(0, -1) : args;
    events.message({
      channel: event,
      ...eventPayload(data),
      meta: { args: data.length, ...(ackRequested && { ackRequested }) },
    });
  });
  socket.on('disconnect', (reason: string) => events.close(reason));

  return {
    info: { socketId: socket.id, namespace: new URL(config.url).pathname || '/' },
    async subscribe({ channel }) {
      subscribed.add(channel);
    },
    async unsubscribe(channel) {
      subscribed.delete(channel);
    },
    async publish(message) {
      refuseUnsupported('Socket.IO', message, ['key', 'headers']);
      const args = emitArguments(message);
      if (!optionOneOf(message.options, 'ack', [true, false], false)) {
        socket.emit(message.channel, ...args);
        return {};
      }
      const seconds = message.options?.timeout ?? 10;
      if (typeof seconds !== 'number' || seconds <= 0) throw new Error('timeout must be a number of seconds.');
      const reply: unknown = await socket.timeout(seconds * 1000).emitWithAck(message.channel, ...args);
      return { meta: { ack: argumentPayload(reply).payload } };
    },
    async close() {
      socket.close();
    },
  };
}
