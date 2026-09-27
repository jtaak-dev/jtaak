import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Wait } from 'testcontainers';
import { CONTAINER_START_TIMEOUT, containerRuntimeAvailable, startBroker, type Broker } from '../../test/containers';
import { selfSignedCertificate } from '../../test/tls';
import { openStream } from '../streamExecutor';
import type { MessagingMessage, MessagingStreamHandle, RequestConfig, StreamEvent } from '../../types';

const runtime = await containerRuntimeAvailable();
const IMAGE = 'docker.io/library/nats:2.11-alpine';

// Three NATS servers: open, one that needs user "alice" / "secret", and one
// with TLS on the self-signed test certificate.
describe.skipIf(!runtime)('NATS', () => {
  let open: Broker;
  let secured: Broker;
  let tls: Broker;

  beforeAll(async () => {
    const ready = () => Wait.forLogMessage(/Server is ready/);
    const { key, cert } = selfSignedCertificate();
    [open, secured, tls] = await Promise.all([
      startBroker(IMAGE, { ports: [4222], wait: ready() }),
      startBroker(IMAGE, { ports: [4222], wait: ready(), command: ['--user', 'alice', '--pass', 'secret'] }),
      startBroker(IMAGE, {
        ports: [4222],
        wait: ready(),
        files: [
          { content: cert, target: '/certs/cert.pem' },
          { content: key, target: '/certs/key.pem' },
        ],
        command: ['--tls', '--tlscert', '/certs/cert.pem', '--tlskey', '/certs/key.pem'],
      }),
    ]);
  }, CONTAINER_START_TIMEOUT);

  afterAll(async () => {
    await Promise.all([open, secured, tls].filter(Boolean).map((b) => b.stop()));
  });

  function connect(overrides: Partial<RequestConfig> = {}, broker = open) {
    const events: StreamEvent[] = [];
    const handle = openStream(
      {
        id: 'nats',
        name: 'nats',
        protocol: 'nats',
        method: 'GET',
        url: `nats://${broker.host}:${broker.port(4222)}`,
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

  it('connects, subscribes with a wildcard, and receives messages with headers', async () => {
    const { handle, events, received } = connect();
    await handle.subscribe({ channel: 'orders.>' });
    expect(events[0]).toMatchObject({ type: 'open', data: { protocol: 'nats', version: expect.any(String) } });

    await handle.publish({
      channel: 'orders.eu.created',
      payload: '{"id":7}',
      headers: [{ key: 'Trace-Id', value: 'abc', enabled: true }],
    });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({
      channel: 'orders.eu.created',
      payload: '{"id":7}',
      headers: { 'Trace-Id': 'abc' },
      meta: { subscription: 'orders.>' },
    });
    handle.close();
  });

  it('sends a request and reports the reply', async () => {
    const responder = connect();
    await responder.handle.subscribe({ channel: 'time.now' });
    // The responder answers each request on its reply subject.
    const answered = new Set<string>();
    const interval = setInterval(() => {
      for (const m of responder.received()) {
        const reply = m.meta?.reply as string | undefined;
        if (reply && !answered.has(reply)) {
          answered.add(reply);
          void responder.handle.publish({ channel: reply, payload: '12:00' });
        }
      }
    }, 10);

    const requester = connect();
    const result = await requester.handle.publish({ channel: 'time.now', payload: '', options: { request: true } });
    clearInterval(interval);
    expect(result.meta).toEqual({ reply: '12:00', replyIsBinary: false });
    responder.handle.close();
    requester.handle.close();
  });

  it('times out a request nobody answers', async () => {
    const { handle } = connect();
    await expect(
      handle.publish({ channel: 'nobody.home', payload: '', options: { request: true, timeout: 0.5 } }),
    ).rejects.toThrow(/no responders|timeout/i);
    handle.close();
  });

  it('shares messages across a queue group', async () => {
    const a = connect();
    const b = connect();
    await a.handle.subscribe({ channel: 'jobs', options: { queue: 'workers' } });
    await b.handle.subscribe({ channel: 'jobs', options: { queue: 'workers' } });
    const publisher = connect();
    for (let i = 0; i < 20; i++) await publisher.handle.publish({ channel: 'jobs', payload: String(i) });
    await expect.poll(() => a.received().length + b.received().length).toBe(20);
    [a, b, publisher].forEach((c) => c.handle.close());
  });

  it('refuses a key, which NATS messages do not have', async () => {
    const { handle } = connect();
    await expect(handle.publish({ channel: 'x', payload: 'y', key: 'k' })).rejects.toThrow(
      'NATS messages have no key.',
    );
    handle.close();
  });

  it('signs in with a username and password, and reports a wrong one', async () => {
    const good = connect({ auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } } }, secured);
    await good.handle.subscribe({ channel: 'ok' });
    good.handle.close();

    const bad = connect({ auth: { type: 'basic', basic: { username: 'alice', password: 'nope' } } }, secured);
    await expect(bad.handle.subscribe({ channel: 'x' })).rejects.toThrow(/authoriz/i);
  });

  describe('over TLS', () => {
    const url = () => `tls://${tls.host}:${tls.port(4222)}`;

    it('refuses a self-signed certificate, with the reason', async () => {
      const { handle } = connect({ url: url() }, tls);
      await expect(handle.subscribe({ channel: 'x' })).rejects.toThrow(/self-signed certificate/);
    });

    it('connects with verifyTls: false', async () => {
      const { handle, received } = connect({ url: url(), verifyTls: false }, tls);
      await handle.subscribe({ channel: 'secure' });
      await handle.publish({ channel: 'secure', payload: 'hi' });
      await expect.poll(received).toHaveLength(1);
      handle.close();
    });
  });
});
