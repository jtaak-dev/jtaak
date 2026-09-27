import { describeError, withErrorDetail } from '../errors.js';
import type {
  MessagingProtocol,
  MessagingPublish,
  MessagingStreamHandle,
  RequestConfig,
  StreamEvent,
} from '../../types.js';
import type { ConnectAdapter, MessagingAdapter } from './adapter.js';
import { headerRecord } from './payload.js';

/** Each adapter, and so its client library, loads only when a connection of
 * that protocol opens: nothing here runs for HTTP requests or the CLI. */
const ADAPTERS: Partial<Record<MessagingProtocol, () => Promise<ConnectAdapter>>> = {
  mqtt: async () => (await import('./mqtt.js')).connectMqtt,
  socketio: async () => (await import('./socketio.js')).connectSocketIo,
  nats: async () => (await import('./nats.js')).connectNats,
  amqp: async () => (await import('./amqp.js')).connectAmqp,
  kafka: async () => (await import('./kafka.js')).connectKafka,
};

export const MESSAGING_PROTOCOLS: readonly MessagingProtocol[] = ['mqtt', 'kafka', 'socketio', 'amqp', 'nats'];

export function isMessagingProtocol(protocol: string): protocol is MessagingProtocol {
  return (MESSAGING_PROTOCOLS as readonly string[]).includes(protocol);
}

/**
 * Opens a connection to a broker (or event server) and returns at once;
 * `'open'` follows when the broker accepts it, or `'error'` then `'close'`
 * when it doesn't. Calls made before that wait for the connection, and
 * reject with its error if it fails. Received messages, and each message
 * this client publishes, arrive as `'message'` events (`MessagingMessage`).
 * Nothing is reported after `close()`.
 */
export function openMessagingStream(
  config: RequestConfig,
  onEvent: (event: StreamEvent) => void,
): MessagingStreamHandle {
  const protocol = config.protocol as MessagingProtocol;
  let closedByCaller = false;
  let closeReported = false;
  const emit = (event: Omit<StreamEvent, 'timestamp'>) => {
    if (!closedByCaller) onEvent({ ...event, timestamp: Date.now() });
  };
  const reportClose = (reason?: string) => {
    if (closeReported) return;
    closeReported = true;
    emit({ type: 'close', ...(reason && { data: { reason } }) });
  };

  const connecting: Promise<MessagingAdapter> = (async () => {
    const load = ADAPTERS[protocol];
    if (!load) throw new Error(`${protocol} connections aren't supported yet.`);
    const connect = await load();
    return connect(config, {
      message: (message) => emit({ type: 'message', data: { direction: 'received', ...message } }),
      error: (error) => emit({ type: 'error', data: { message: describeError(error) } }),
      close: reportClose,
    });
  })().catch((error: unknown) => {
    throw withErrorDetail(error);
  });

  connecting.then(
    // A caller who closed before this resolved has close() end the adapter.
    (adapter) => emit({ type: 'open', data: { protocol, ...adapter.info } }),
    (error: Error) => {
      emit({ type: 'error', data: { message: error.message } });
      reportClose();
    },
  );

  /** Runs `call` once connected, giving any failure the reason (errors.ts). */
  async function whenOpen<T>(call: (adapter: MessagingAdapter) => Promise<T>): Promise<T> {
    if (closedByCaller) throw new Error('The connection is closed.');
    const adapter = await connecting;
    try {
      return await call(adapter);
    } catch (error) {
      throw withErrorDetail(error);
    }
  }

  return {
    subscribe: (subscription) => whenOpen((adapter) => adapter.subscribe(subscription)),
    unsubscribe: (channel) => whenOpen((adapter) => adapter.unsubscribe(channel)),
    publish: (message: MessagingPublish) =>
      whenOpen(async (adapter) => {
        const result = await adapter.publish(message);
        emit({
          type: 'message',
          data: {
            direction: 'sent',
            channel: message.channel,
            payload: message.payload,
            isBinary: message.encoding === 'base64',
            key: message.key,
            headers: headerRecord(message.headers),
            meta: { ...message.options, ...result.meta },
          },
        });
        return result;
      }),
    close: () => {
      if (closedByCaller) return;
      closedByCaller = true;
      connecting.then((adapter) => adapter.close()).catch(() => {});
    },
  };
}
