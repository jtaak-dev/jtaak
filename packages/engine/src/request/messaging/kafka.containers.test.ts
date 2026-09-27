import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { Wait } from 'testcontainers';
import { CONTAINER_START_TIMEOUT, containerRuntimeAvailable, startBroker, type Broker } from '../../test/containers';
import { openStream } from '../streamExecutor';
import type { MessagingMessage, MessagingStreamHandle, RequestConfig, StreamEvent } from '../../types';

const runtime = await containerRuntimeAvailable();

/** A free port on this machine: Kafka has to advertise the address clients reach it on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
    server.once('error', reject);
  });
}

// A single-node Kafka 4 (KRaft, no ZooKeeper) that creates topics on first use.
describe.skipIf(!runtime)('Kafka', () => {
  let kafka: Broker;
  let url: string;

  beforeAll(async () => {
    const port = await freePort();
    kafka = await startBroker('docker.io/apache/kafka-native:4.1.0', {
      ports: [{ container: 9092, host: port }],
      env: {
        KAFKA_NODE_ID: '1',
        KAFKA_PROCESS_ROLES: 'broker,controller',
        KAFKA_LISTENERS: 'PLAINTEXT://:9092,CONTROLLER://:9093',
        KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
        KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
        KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
        KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
        KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
        KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
        KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        KAFKA_NUM_PARTITIONS: '1',
      },
      wait: Wait.forLogMessage(/Kafka Server started/),
    });
    url = `kafka://127.0.0.1:${port}`;
  }, CONTAINER_START_TIMEOUT);

  afterAll(async () => {
    await kafka?.stop();
  });

  function connect(overrides: Partial<RequestConfig> = {}) {
    const events: StreamEvent[] = [];
    const handle = openStream(
      {
        id: 'kafka',
        name: 'kafka',
        protocol: 'kafka',
        method: 'GET',
        url,
        params: [],
        headers: [],
        body: { mode: 'none' },
        auth: { type: 'none' },
        ...overrides,
      },
      (event) => events.push(event),
    ) as MessagingStreamHandle;
    const received = () =>
      events
        .filter((e) => e.type === 'message' && (e.data as MessagingMessage).direction === 'received')
        .map((e) => e.data as MessagingMessage);
    return { handle, events, received };
  }

  const within = { timeout: 30_000 };

  it('produces with a key and headers, and reads it back from the beginning', async () => {
    const producer = connect();
    const result = await producer.handle.publish({
      channel: 'orders',
      payload: '{"id":1}',
      key: 'customer-7',
      headers: [{ key: 'trace', value: 't-1', enabled: true }],
    });
    expect(result.meta).toEqual({ partition: 0, offset: expect.any(String) });
    expect(producer.events[0]).toMatchObject({ type: 'open', data: { protocol: 'kafka', brokers: 1 } });

    const consumer = connect();
    await consumer.handle.subscribe({ channel: 'orders', options: { fromBeginning: true } });
    await expect.poll(consumer.received, within).toHaveLength(1);
    expect(consumer.received()[0]).toMatchObject({
      channel: 'orders',
      payload: '{"id":1}',
      key: 'customer-7',
      headers: { trace: 't-1' },
      meta: { partition: 0, offset: result.meta?.offset },
    });
    producer.handle.close();
    consumer.handle.close();
  }, 60_000);

  it('reads only new messages by default', async () => {
    const setup = connect();
    await setup.handle.publish({ channel: 'events', payload: 'old' });

    const consumer = connect();
    await consumer.handle.subscribe({ channel: 'events' });
    // Keeps publishing until the consumer, which may still be joining, starts receiving.
    for (let i = 0; i < 60 && consumer.received().length === 0; i++) {
      await setup.handle.publish({ channel: 'events', payload: 'new' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(consumer.received().length).toBeGreaterThan(0);
    expect(consumer.received().map((m) => m.payload)).not.toContain('old');
    setup.handle.close();
    consumer.handle.close();
  }, 60_000);

  it('consumes in a consumer group, reporting it', async () => {
    const producer = connect();
    await producer.handle.publish({ channel: 'jobs', payload: 'job-1' });
    const consumer = connect();
    await consumer.handle.subscribe({ channel: 'jobs', options: { groupId: 'workers', fromBeginning: true } });
    await expect.poll(consumer.received, within).toHaveLength(1);
    expect(consumer.received()[0].meta).toMatchObject({ groupId: 'workers' });
    producer.handle.close();
    consumer.handle.close();
  }, 60_000);

  it('refuses a URL that is not kafka:// or kafkas://', async () => {
    const { handle } = connect({ url: 'http://127.0.0.1:9092' });
    await expect(handle.publish({ channel: 'x', payload: 'y' })).rejects.toThrow(/starts with kafka:\/\//);
  });

  it('reports an unreachable broker with the reason, quickly', async () => {
    const started = Date.now();
    const { handle } = connect({ url: 'kafka://127.0.0.1:1' });
    await expect(handle.publish({ channel: 'x', payload: 'y' })).rejects.toThrow(/ECONNREFUSED/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
