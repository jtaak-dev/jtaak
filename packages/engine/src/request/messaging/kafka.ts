import { randomUUID } from 'node:crypto';
import type { BaseOptions, Consumer, Message, MessagesStream, Producer } from '@platformatic/kafka';
import { verifiesTls } from '../tls.js';
import type { KafkaProtocolConfig, RequestConfig } from '../../types.js';
import { optionOneOf, type AdapterEvents, type MessagingAdapter } from './adapter.js';
import { decodePayload, encodePayload, headerRecord } from './payload.js';

const SASL_MECHANISMS = ['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-512'] as const;

/** `kafka://a:9092,b:9092` (or `kafkas://` for TLS) as the bootstrap brokers. */
function brokers(url: string): { bootstrapBrokers: string[]; tls: boolean } {
  const match = /^(kafkas?):\/\/(.+)$/i.exec(url.trim());
  if (!match) throw new Error('A Kafka URL starts with kafka:// (or kafkas:// for TLS): kafka://host:9092.');
  const bootstrapBrokers = match[2]
    .replace(/\/+$/, '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean);
  return { bootstrapBrokers, tls: match[1].toLowerCase() === 'kafkas' };
}

function received(message: Message, groupId: string | undefined) {
  const headers: Record<string, string> = {};
  for (const [name, value] of message.headers) headers[name.toString('utf-8')] = value.toString('utf-8');
  return {
    channel: message.topic,
    ...decodePayload(message.value ?? Buffer.alloc(0)),
    ...(message.key && message.key.length > 0 && { key: message.key.toString('utf-8') }),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    meta: {
      partition: message.partition,
      offset: message.offset.toString(),
      timestamp: Number(message.timestamp),
      ...(groupId && { groupId }),
    },
  };
}

/**
 * Kafka with `@platformatic/kafka` (pure JavaScript). Publishing produces
 * to a topic with an optional key, headers and partition. Each
 * subscription is a consumer of its own: in the given consumer group
 * (`groupId`, committing its offsets) or in a private one that commits
 * nothing, reading from the start (`fromBeginning`) or only new messages.
 * Retries are kept short, so a broker that can't be reached fails quickly.
 */
export async function connectKafka(config: RequestConfig, events: AdapterEvents): Promise<MessagingAdapter> {
  const settings = (config.protocolConfig ?? {}) as KafkaProtocolConfig;
  const { Producer, Consumer, MessagesStreamModes, MessagesStreamFallbackModes } = await import('@platformatic/kafka');

  const target = brokers(config.url);
  const saslMechanism = optionOneOf(settings as Record<string, unknown>, 'saslMechanism', SASL_MECHANISMS, 'PLAIN');
  const basic = config.auth.type === 'basic' ? config.auth.basic : undefined;
  const base: BaseOptions = {
    clientId: settings.clientId ?? `jtaak-${randomUUID().slice(0, 8)}`,
    bootstrapBrokers: target.bootstrapBrokers,
    connectTimeout: (settings.connectTimeout ?? 20) * 1000,
    retries: 2,
    retryDelay: 250,
    // Like Kafka's own console producer: a new topic is created on first use, if the broker allows it.
    autocreateTopics: true,
    ...((target.tls || !verifiesTls(config)) && { tls: { rejectUnauthorized: verifiesTls(config) } }),
    ...(basic && { sasl: { mechanism: saslMechanism, username: basic.username, password: basic.password } }),
  };

  const producer: Producer = new Producer(base);
  let cluster;
  try {
    // Connects and signs in now, so a bad address or password fails the connection, not a later call.
    cluster = await producer.metadata({ topics: [] });
  } catch (error) {
    await producer.close().catch(() => {});
    throw error;
  }

  const consumers = new Map<string, { consumer: Consumer; stream: MessagesStream<Buffer, Buffer, Buffer, Buffer> }>();
  let closing = false;

  return {
    info: { clusterId: cluster.id, brokers: cluster.brokers.size },
    async subscribe({ channel: topic, options }) {
      if (consumers.has(topic)) return;
      const groupId = options?.groupId;
      if (groupId !== undefined && (typeof groupId !== 'string' || !groupId))
        throw new Error('groupId must be a group name.');
      const fromBeginning = optionOneOf(options, 'fromBeginning', [true, false], false);

      const consumer: Consumer = new Consumer({
        ...base,
        groupId: groupId ?? `jtaak-${randomUUID()}`,
        // The connection is already checked, so joining a group can take its time: on a new
        // cluster the group coordinator isn't ready at first ("not the correct coordinator").
        retries: 20,
        retryDelay: 500,
      });
      try {
        const stream = await consumer.consume({
          topics: [topic],
          // A group resumes where it left off; a private one starts from the chosen end.
          mode: groupId
            ? MessagesStreamModes.COMMITTED
            : fromBeginning
              ? MessagesStreamModes.EARLIEST
              : MessagesStreamModes.LATEST,
          fallbackMode: fromBeginning ? MessagesStreamFallbackModes.EARLIEST : MessagesStreamFallbackModes.LATEST,
          autocommit: Boolean(groupId),
        });
        stream.on('data', (message: Message) => events.message(received(message, groupId)));
        stream.on('error', (error: Error) => {
          if (!closing) events.error(error);
        });
        consumers.set(topic, { consumer, stream });
      } catch (error) {
        await consumer.close(true).catch(() => {});
        throw error;
      }
    },
    async unsubscribe(topic) {
      const entry = consumers.get(topic);
      if (!entry) return;
      consumers.delete(topic);
      await entry.consumer.close(true).catch(() => {});
    },
    async publish(message) {
      const partition = message.options?.partition;
      if (partition !== undefined && (!Number.isInteger(partition) || (partition as number) < 0)) {
        throw new Error('partition must be a partition number.');
      }
      const headers = headerRecord(message.headers);
      const result = await producer.send({
        messages: [
          {
            topic: message.channel,
            value: encodePayload(message),
            ...(message.key && { key: Buffer.from(message.key, 'utf-8') }),
            ...(headers && {
              headers: new Map(Object.entries(headers).map(([k, v]) => [Buffer.from(k), Buffer.from(v)])),
            }),
            ...(partition !== undefined && { partition: partition as number }),
          },
        ],
      });
      const [written] = result.offsets ?? [];
      return { meta: written ? { partition: written.partition, offset: written.offset.toString() } : {} };
    },
    async close() {
      closing = true;
      await Promise.all([...consumers.values()].map(({ consumer }) => consumer.close(true).catch(() => {})));
      consumers.clear();
      await producer.close();
      events.close();
    },
  };
}
