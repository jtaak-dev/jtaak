import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wait } from 'testcontainers';
import { CONTAINER_START_TIMEOUT, containerRuntimeAvailable, startBroker, type Broker } from '../../test/containers';
import { openStream } from '../streamExecutor';
import type { MessagingMessage, MessagingStreamHandle, RequestConfig, StreamEvent } from '../../types';

const runtime = await containerRuntimeAvailable();

// RabbitMQ with user "alice" / "secret" (its "guest" user only works from
// the broker's own machine, which a container port isn't).
describe.skipIf(!runtime)('AMQP (RabbitMQ)', () => {
  let rabbit: Broker;

  beforeAll(async () => {
    rabbit = await startBroker('docker.io/library/rabbitmq:4-alpine', {
      ports: [5672],
      env: { RABBITMQ_DEFAULT_USER: 'alice', RABBITMQ_DEFAULT_PASS: 'secret' },
      wait: Wait.forLogMessage(/Server startup complete/),
    });
  }, CONTAINER_START_TIMEOUT);

  afterAll(async () => {
    await rabbit?.stop();
  });

  const signIn = { type: 'basic' as const, basic: { username: 'alice', password: 'secret' } };

  function connect(overrides: Partial<RequestConfig> = {}) {
    const events: StreamEvent[] = [];
    const handle = openStream(
      {
        id: 'amqp',
        name: 'amqp',
        protocol: 'amqp',
        method: 'GET',
        url: `amqp://${rabbit.host}:${rabbit.port(5672)}/`,
        params: [],
        headers: [],
        body: { mode: 'none' },
        auth: signIn,
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

  it('declares a queue, consumes from it, and receives what the default exchange routes there', async () => {
    const { handle, events, received } = connect();
    await handle.subscribe({ channel: 'orders', options: { declare: true } });
    expect(events[0]).toMatchObject({ type: 'open', data: { protocol: 'amqp', product: 'RabbitMQ' } });

    const result = await handle.publish({
      channel: 'orders',
      payload: '{"id":1}',
      headers: [{ key: 'trace', value: 't-1', enabled: true }],
      options: { contentType: 'application/json', messageId: 'm-1' },
    });
    expect(result.meta).toEqual({ exchange: '', routingKey: 'orders' });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({
      channel: 'orders',
      payload: '{"id":1}',
      headers: { trace: 't-1' },
      meta: { exchange: '', routingKey: 'orders', contentType: 'application/json', messageId: 'm-1' },
    });
    handle.close();
  });

  it('binds a private queue to an exchange with a routing key pattern', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: '', options: { exchange: 'amq.topic', routingKey: 'sensors.*.temp' } });
    await handle.publish({ channel: 'sensors.kitchen.temp', payload: '21', options: { exchange: 'amq.topic' } });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0].meta).toMatchObject({ exchange: 'amq.topic', routingKey: 'sensors.kitchen.temp' });
    handle.close();
  });

  it('fails a publish no queue receives, with the broker reason', async () => {
    const { handle } = connect();
    await expect(handle.publish({ channel: 'nowhere', payload: 'x' })).rejects.toThrow(
      'No queue received the message: NO_ROUTE (312).',
    );
    handle.close();
  });

  it('fails a publish to an unknown exchange with the reason, and keeps publishing after it', async () => {
    const { handle, received } = connect();
    await expect(
      handle.publish({ channel: 'x', payload: 'y', options: { exchange: 'no-such-exchange' } }),
    ).rejects.toThrow(/NOT_FOUND - no exchange 'no-such-exchange'/);
    await handle.subscribe({ channel: 'after-error', options: { declare: true } });
    await handle.publish({ channel: 'after-error', payload: 'still works' });
    await expect.poll(received).toHaveLength(1);
    handle.close();
  });

  it('fails to consume a queue that does not exist, with the reason, and keeps the connection', async () => {
    const { handle, events } = connect();
    await expect(handle.subscribe({ channel: 'no-such-queue' })).rejects.toThrow(
      /NOT_FOUND - no queue 'no-such-queue'/,
    );
    await handle.subscribe({ channel: 'exists', options: { declare: true } });
    expect(events.map((e) => e.type)).not.toContain('close');
    handle.close();
  });

  it('stops receiving after unsubscribing', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'news', options: { declare: true } });
    await handle.publish({ channel: 'news', payload: 'one' });
    await expect.poll(received).toHaveLength(1);
    await handle.unsubscribe('news');
    // Still queued for a later consumer, so not an unroutable publish.
    await handle.publish({ channel: 'news', payload: 'two' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received().map((m) => m.payload)).toEqual(['one']);
    handle.close();
  });

  it('refuses a key, which AMQP messages do not have', async () => {
    const { handle } = connect();
    await expect(handle.publish({ channel: 'x', payload: 'y', key: 'k' })).rejects.toThrow(
      'AMQP messages have no key.',
    );
    handle.close();
  });

  it('reports a wrong password with the reason', async () => {
    const { handle } = connect({ auth: { type: 'basic', basic: { username: 'alice', password: 'wrong' } } });
    await expect(handle.subscribe({ channel: 'x' })).rejects.toThrow(/ACCESS_REFUSED|403/);
  });
});
