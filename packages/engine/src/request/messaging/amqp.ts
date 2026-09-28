import type { Channel, ChannelModel, ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { tlsOptionsForUrl } from '../network.js';
import type { AmqpProtocolConfig, MessagingPublish, RequestConfig } from '../../types.js';
import { optionOneOf, refuseUnsupported, type AdapterEvents, type MessagingAdapter } from './adapter.js';
import { decodePayload, encodePayload, headerRecord } from './payload.js';

/** Publish options passed straight to the broker as message properties. */
const PROPERTY_OPTIONS = [
  'contentType',
  'contentEncoding',
  'correlationId',
  'replyTo',
  'messageId',
  'type',
  'appId',
  'expiration',
  'priority',
] as const;

function headerValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf-8');
  return JSON.stringify(value) ?? String(value);
}

function received(queue: string, msg: ConsumeMessage) {
  const { properties, fields } = msg;
  const headers = properties.headers
    ? Object.fromEntries(Object.entries(properties.headers).map(([k, v]) => [k, headerValue(v)]))
    : undefined;
  const meta: Record<string, unknown> = {
    queue,
    exchange: fields.exchange,
    routingKey: fields.routingKey,
    deliveryTag: fields.deliveryTag,
    redelivered: fields.redelivered,
  };
  for (const name of [...PROPERTY_OPTIONS, 'deliveryMode', 'timestamp'] as const) {
    const value = (properties as unknown as Record<string, unknown>)[name];
    if (value !== undefined && value !== null) meta[name] = value;
  }
  return {
    channel: queue,
    ...decodePayload(msg.content),
    headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
    meta,
  };
}

/** `url` with the username and password from basic auth, and the heartbeat, filled in. */
function connectionUrl(config: RequestConfig, settings: AmqpProtocolConfig): string {
  const url = new URL(config.url);
  if (config.auth.type === 'basic' && config.auth.basic) {
    url.username = encodeURIComponent(config.auth.basic.username);
    url.password = encodeURIComponent(config.auth.basic.password);
  }
  if (!url.searchParams.has('heartbeat')) url.searchParams.set('heartbeat', String(settings.heartbeat ?? 60));
  return url.toString();
}

/**
 * AMQP 0-9-1 (RabbitMQ) with `amqplib`. Subscribing consumes from a queue,
 * optionally declaring it and binding it to an exchange; publishing sends
 * to an exchange with the channel as the routing key (the default exchange
 * delivers straight to the queue of that name). Publishes are confirmed by
 * the broker and marked mandatory, so a message no queue receives fails
 * with the broker's reason instead of vanishing.
 */
export async function connectAmqp(config: RequestConfig, events: AdapterEvents): Promise<MessagingAdapter> {
  const settings = (config.protocolConfig ?? {}) as AmqpProtocolConfig;
  // amqplib is CommonJS: under Node's ESM its exports may arrive on `default`.
  const amqplib = (await import('amqplib')) as unknown as {
    connect?: typeof import('amqplib').connect;
    default?: { connect: typeof import('amqplib').connect };
  };
  const connect = amqplib.connect ?? amqplib.default!.connect;

  const connection: ChannelModel = await connect(connectionUrl(config, settings), {
    timeout: (settings.connectTimeout ?? 20) * 1000,
    // amqps:// (tls.connect's options).
    ...tlsOptionsForUrl(config, config.url),
  });
  connection.on('error', (error: Error) => events.error(error));
  connection.on('close', (error?: Error) => events.close(error?.message));

  /** When a call fails because the broker closed the channel, its reason arrives as the channel's
   * error just after the call's own "Channel ended"; this waits briefly for it. */
  function channelClosed(channel: Channel): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      channel.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** A channel whose errors (the broker closes a channel over a missing queue, say) are reported, not thrown. */
  async function newChannel<C extends Channel>(create: () => Promise<C>, onError: (error: Error) => void): Promise<C> {
    const channel = await create();
    channel.on('error', onError);
    return channel;
  }

  // One channel per subscription, so a failing one doesn't take the others down.
  const consumers = new Map<string, { channel: Channel; consumerTag: string }>();

  // The publishing channel, opened on first use and again after the broker closes it.
  let publishChannel: Promise<ConfirmChannel> | undefined;
  let lastPublishError: Error | undefined;
  const publishing = () =>
    (publishChannel ??= newChannel(
      () => connection.createConfirmChannel(),
      (error) => {
        lastPublishError = error;
        publishChannel = undefined;
      },
    ));
  // Publishes run one at a time, so a returned message is matched to its publish.
  let publishQueue: Promise<unknown> = Promise.resolve();

  async function publishOne(message: MessagingPublish) {
    refuseUnsupported('AMQP', message, ['key']);
    const exchange = message.options?.exchange ?? '';
    if (typeof exchange !== 'string') throw new Error('exchange must be an exchange name.');
    const properties: Options.Publish = {
      mandatory: true,
      persistent: optionOneOf(message.options, 'persistent', [true, false], false),
      headers: headerRecord(message.headers),
    };
    for (const name of PROPERTY_OPTIONS) {
      const value = message.options?.[name];
      if (value !== undefined) (properties as Record<string, unknown>)[name] = value;
    }

    const channel = await publishing();
    let returned: { replyCode: number; replyText: string } | undefined;
    const onReturn = (msg: { fields: { replyCode: number; replyText: string } }) => {
      returned = msg.fields;
    };
    channel.once('return', onReturn);
    try {
      lastPublishError = undefined;
      await new Promise<void>((resolve, reject) => {
        channel.publish(exchange, message.channel, encodePayload(message), properties, (error: unknown) =>
          error ? reject(lastPublishError ?? error) : resolve(),
        );
      });
    } catch (error) {
      // The broker closed the channel (an unknown exchange, say): its error says why.
      if (!lastPublishError) await channelClosed(channel);
      throw lastPublishError ?? error;
    } finally {
      channel.removeListener('return', onReturn);
    }
    if (returned) {
      throw new Error(`No queue received the message: ${returned.replyText} (${returned.replyCode}).`);
    }
    return { meta: { exchange, routingKey: message.channel } };
  }

  const server = connection.connection.serverProperties;
  return {
    info: { product: server.product, version: server.version },
    async subscribe({ channel: queueName, options }) {
      if (consumers.has(queueName)) return;
      const declare = optionOneOf(options, 'declare', [true, false], false);
      // Durable by default: RabbitMQ 4 refuses transient queues that aren't exclusive.
      const durable = optionOneOf(options, 'durable', [true, false], true);
      const exchange = options?.exchange;
      const routingKey = options?.routingKey ?? '';
      if (exchange !== undefined && typeof exchange !== 'string') throw new Error('exchange must be an exchange name.');
      if (typeof routingKey !== 'string') throw new Error('routingKey must be text.');

      let channelError: Error | undefined;
      const channel = await newChannel(
        () => connection.createChannel(),
        (error) => {
          channelError = error;
          if (consumers.get(queueName)?.channel === channel) {
            consumers.delete(queueName);
            events.error(error);
          }
        },
      );
      try {
        let queue = queueName;
        if (declare || queue === '') {
          // An empty name asks the broker for a private queue of its own naming.
          const declared = await channel.assertQueue(queue, queue === '' ? { exclusive: true } : { durable });
          queue = declared.queue;
        }
        if (exchange) await channel.bindQueue(queue, exchange, routingKey);
        const { consumerTag } = await channel.consume(queue, (msg) => msg && events.message(received(queue, msg)), {
          noAck: true,
        });
        consumers.set(queueName, { channel, consumerTag });
      } catch (error) {
        // The broker's reason (no such queue or exchange) arrives as the channel's error.
        if (!channelError) await channelClosed(channel);
        throw channelError ?? error;
      }
    },
    async unsubscribe(queueName) {
      const consumer = consumers.get(queueName);
      if (!consumer) return;
      consumers.delete(queueName);
      await consumer.channel.close().catch(() => {});
    },
    publish(message) {
      const result = publishQueue.then(() => publishOne(message));
      publishQueue = result.catch(() => {});
      return result;
    },
    async close() {
      await connection.close();
    },
  };
}
