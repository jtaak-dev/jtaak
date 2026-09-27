import type { IClientOptions, IClientPublishOptions, IPublishPacket, MqttClient } from 'mqtt';
import { buildRequestHeaders } from '../executor.js';
import { verifiesTls } from '../tls.js';
import type { MqttProtocolConfig, RequestConfig } from '../../types.js';
import { optionOneOf, refuseUnsupported, type AdapterEvents, type MessagingAdapter } from './adapter.js';
import { decodePayload, encodePayload, headerRecord } from './payload.js';

const QOS_LEVELS = [0, 1, 2] as const;

type UserProperties = Record<string, string | string[]>;

/** MQTT 5 user properties as headers; a repeated property's values are joined. */
function userPropertiesToHeaders(properties: UserProperties | undefined): Record<string, string> | undefined {
  if (!properties) return undefined;
  return Object.fromEntries(
    Object.entries(properties).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value]),
  );
}

/**
 * MQTT 3.1.1 and 5 over TCP, TLS or WebSocket (`mqtt://`, `mqtts://`,
 * `ws://`, `wss://`), with the `mqtt` client. It doesn't reconnect by
 * itself: a lost connection is reported as `'close'`, so a test tool shows
 * what happened instead of hiding it behind retries.
 */
export async function connectMqtt(config: RequestConfig, events: AdapterEvents): Promise<MessagingAdapter> {
  const settings = (config.protocolConfig ?? {}) as MqttProtocolConfig;
  const protocolVersion = settings.protocolVersion ?? 4;
  if (protocolVersion !== 4 && protocolVersion !== 5) {
    throw new Error(`protocolVersion must be 4 (MQTT 3.1.1) or 5 (MQTT 5); got ${String(protocolVersion)}.`);
  }
  const isV5 = protocolVersion === 5;

  // `mqtt` is CommonJS: under Node's ESM its exports may arrive on `default`.
  const mqtt = (await import('mqtt')) as unknown as {
    connectAsync?: (url: string, options: IClientOptions) => Promise<MqttClient>;
    default?: { connectAsync: (url: string, options: IClientOptions) => Promise<MqttClient> };
  };
  const connectAsync = mqtt.connectAsync ?? mqtt.default!.connectAsync;

  const basic = config.auth.type === 'basic' ? config.auth.basic : undefined;
  const headers = buildRequestHeaders({ ...config, auth: { type: 'none' } });
  const options: IClientOptions = {
    protocolVersion,
    clean: settings.clean ?? true,
    keepalive: settings.keepalive ?? 60,
    connectTimeout: (settings.connectTimeout ?? 30) * 1000,
    reconnectPeriod: 0,
    rejectUnauthorized: verifiesTls(config),
    ...(settings.clientId && { clientId: settings.clientId }),
    ...(basic && { username: basic.username, password: basic.password }),
    // Only used for ws:// and wss://: the headers of the WebSocket handshake.
    ...(Object.keys(headers).length > 0 && { wsOptions: { headers } }),
  };

  const client = await connectAsync(config.url, options);
  client.on('message', (topic: string, payload: Buffer, packet: IPublishPacket) => {
    events.message({
      channel: topic,
      ...decodePayload(payload),
      headers: userPropertiesToHeaders(packet.properties?.userProperties as UserProperties | undefined),
      meta: {
        qos: packet.qos,
        retain: packet.retain,
        dup: packet.dup,
        ...(packet.properties?.contentType && { contentType: packet.properties.contentType }),
      },
    });
  });
  client.on('error', (error: Error) => events.error(error));
  client.on('close', () => events.close());

  return {
    info: { protocolVersion, clientId: client.options.clientId },
    async subscribe({ channel, options: subscribeOptions }) {
      const qos = optionOneOf(subscribeOptions, 'qos', QOS_LEVELS, 0);
      const [grant] = await client.subscribeAsync(channel, { qos });
      // 128 is how the broker says no (MQTT 5 uses the same range for its reason codes).
      if (!grant || grant.qos >= 128) throw new Error(`The broker refused the subscription to "${channel}".`);
    },
    async unsubscribe(channel) {
      await client.unsubscribeAsync(channel);
    },
    async publish(message) {
      refuseUnsupported('MQTT', message, ['key']);
      const qos = optionOneOf(message.options, 'qos', QOS_LEVELS, 0);
      const retain = optionOneOf(message.options, 'retain', [true, false], false);
      const userProperties = headerRecord(message.headers);
      if (userProperties && !isV5) {
        throw new Error('MQTT 3.1.1 messages have no headers; use protocolVersion 5 for user properties.');
      }
      const publishOptions: IClientPublishOptions = {
        qos,
        retain,
        ...(userProperties && { properties: { userProperties } }),
      };
      const packet = await client.publishAsync(message.channel, encodePayload(message), publishOptions);
      const messageId = (packet as { messageId?: number } | undefined)?.messageId;
      return { meta: messageId === undefined ? {} : { messageId } };
    },
    close: () => client.endAsync(),
  };
}
