import type { ConnectionOptions, Msg, MsgHdrs, NatsConnection, Subscription } from '@nats-io/transport-node';
import { endpointOf, tlsOptionsFor } from '../network.js';
import { verifiesTls } from '../tls.js';
import type { NatsProtocolConfig, RequestConfig } from '../../types.js';
import { optionOneOf, refuseUnsupported, type AdapterEvents, type MessagingAdapter } from './adapter.js';
import { decodePayload, encodePayload, headerRecord } from './payload.js';

function headersToRecord(headers: MsgHdrs | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string> = {};
  for (const name of headers.keys()) record[name] = headers.values(name).join(', ');
  return Object.keys(record).length > 0 ? record : undefined;
}

/** `nats://a:4222,nats://b:4222` or `tls://…` as the client's server list; `tls://` requires TLS. */
function servers(url: string): { servers: string[]; tls: boolean } {
  const list = url
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { servers: list, tls: list.some((s) => s.startsWith('tls://')) };
}

/**
 * NATS with `@nats-io/transport-node`. Channels are subjects (`*` and `>`
 * wildcards); a subscription can join a queue group (`queue`), and a
 * publish with `request: true` waits for a reply. Like the other adapters,
 * it doesn't reconnect by itself.
 */
export async function connectNats(config: RequestConfig, events: AdapterEvents): Promise<MessagingAdapter> {
  const settings = (config.protocolConfig ?? {}) as NatsProtocolConfig;
  const { connect, headers: newHeaders } = await import('@nats-io/transport-node');

  const target = servers(config.url);
  const first = endpointOf(target.servers[0].includes('://') ? target.servers[0] : `nats://${target.servers[0]}`);
  const options: ConnectionOptions = {
    servers: target.servers,
    timeout: (settings.connectTimeout ?? 20) * 1000,
    reconnect: false,
    ...(settings.name && { name: settings.name }),
    ...(config.auth.type === 'basic' &&
      config.auth.basic && { user: config.auth.basic.username, pass: config.auth.basic.password }),
    ...(config.auth.type === 'bearer' && config.auth.bearer?.token && { token: config.auth.bearer.token }),
    // rejectUnauthorized and pfx aren't in the TlsOptions type, but the Node transport passes them to tls.connect.
    ...((target.tls || !verifiesTls(config)) && {
      tls: tlsOptionsFor(config, first.host, first.port) as ConnectionOptions['tls'],
    }),
  };

  const nc: NatsConnection = await connect(options);
  void nc.closed().then((error) => {
    if (error) events.error(error);
    events.close(error ? error.message : undefined);
  });
  void (async () => {
    // Asynchronous server errors, such as a permission violation on a publish.
    for await (const status of nc.status()) {
      if (status.type === 'error') events.error((status as { error?: unknown }).error ?? status);
    }
  })();

  const subscriptions = new Map<string, Subscription>();
  const toHeaders = (record: Record<string, string> | undefined) => {
    if (!record) return undefined;
    const h = newHeaders();
    for (const [name, value] of Object.entries(record)) h.set(name, value);
    return h;
  };

  return {
    info: { server: nc.info?.server_name, version: nc.info?.version },
    async subscribe({ channel, options: subscribeOptions }) {
      if (subscriptions.has(channel)) return;
      const queue = subscribeOptions?.queue;
      if (queue !== undefined && typeof queue !== 'string') throw new Error('queue must be a queue group name.');
      const subscription = nc.subscribe(channel, {
        ...(queue && { queue }),
        callback: (error: Error | null, msg: Msg) => {
          if (error) {
            events.error(error);
            return;
          }
          events.message({
            channel: msg.subject,
            ...decodePayload(msg.data),
            headers: headersToRecord(msg.headers),
            meta: { ...(msg.reply && { reply: msg.reply }), ...(queue && { queue }), subscription: channel },
          });
        },
      });
      subscriptions.set(channel, subscription);
      // Surfaces a refused subject (permissions) before reporting success.
      await nc.flush();
    },
    async unsubscribe(channel) {
      subscriptions.get(channel)?.unsubscribe();
      subscriptions.delete(channel);
    },
    async publish(message) {
      refuseUnsupported('NATS', message, ['key']);
      const payload = encodePayload(message);
      const msgHeaders = toHeaders(headerRecord(message.headers));
      if (optionOneOf(message.options, 'request', [true, false], false)) {
        const seconds = message.options?.timeout ?? 5;
        if (typeof seconds !== 'number' || seconds <= 0) throw new Error('timeout must be a number of seconds.');
        const reply = await nc.request(message.channel, payload, {
          timeout: seconds * 1000,
          ...(msgHeaders && { headers: msgHeaders }),
        });
        const decoded = decodePayload(reply.data);
        return { meta: { reply: decoded.payload, replyIsBinary: decoded.isBinary } };
      }
      nc.publish(message.channel, payload, { ...(msgHeaders && { headers: msgHeaders }) });
      await nc.flush();
      return {};
    },
    async close() {
      await nc.close();
    },
  };
}
