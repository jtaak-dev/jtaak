import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Aedes } from 'aedes';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { selfSignedCertificate } from '../../test/tls';
import { openStream } from '../streamExecutor';
import type { MessagingMessage, MessagingStreamHandle, RequestConfig, StreamEvent } from '../../types';

// An in-process aedes broker (MQTT 3.1.1), over TCP and over TLS with the
// self-signed test certificate. It accepts user "alice" with password
// "secret", and anyone without a username.
let broker: Aedes;
let tcpServer: net.Server;
let tlsServer: tls.Server;
let tcpUrl: string;
let tlsUrl: string;

beforeAll(async () => {
  broker = await Aedes.createBroker({
    authenticate: (_client, username, password, done) => {
      const ok = username === undefined || (username === 'alice' && password?.toString() === 'secret');
      if (ok) done(null, true);
      else done(Object.assign(new Error('Bad username or password'), { returnCode: 4 }), false);
    },
  });
  tcpServer = net.createServer(broker.handle);
  tlsServer = tls.createServer(selfSignedCertificate(), broker.handle);
  await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve));
  tcpUrl = `mqtt://127.0.0.1:${(tcpServer.address() as AddressInfo).port}`;
  tlsUrl = `mqtts://127.0.0.1:${(tlsServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  tcpServer.close();
  tlsServer.close();
  await new Promise<void>((resolve) => broker.close(() => resolve()));
});

function config(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'mqtt',
    name: 'mqtt',
    protocol: 'mqtt',
    method: 'GET',
    url: tcpUrl,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

/** Opens a connection and collects its events. */
function connect(overrides: Partial<RequestConfig> = {}) {
  const events: StreamEvent[] = [];
  const handle = openStream(config(overrides), (event) => events.push(event)) as MessagingStreamHandle;
  const received = () =>
    events
      .filter((e) => e.type === 'message' && (e.data as MessagingMessage).direction === 'received')
      .map((e) => e.data as MessagingMessage);
  // The first connection also loads the mqtt library (adapters load on demand).
  const opened = () => expect.poll(() => events.map((e) => e.type), { timeout: 10_000 }).toContain('open');
  return { handle, events, received, opened };
}

describe('MQTT', () => {
  it('connects, subscribes, and receives what it publishes, with both in the timeline', async () => {
    const { handle, events, received, opened } = connect();
    await opened();
    expect(events[0].data).toMatchObject({ protocol: 'mqtt', protocolVersion: 4 });

    await handle.subscribe({ channel: 'sensors/+/temp' });
    await handle.publish({ channel: 'sensors/kitchen/temp', payload: '21.5' });

    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({
      channel: 'sensors/kitchen/temp',
      payload: '21.5',
      isBinary: false,
      meta: { qos: 0, retain: false },
    });
    const sent = events.find((e) => e.type === 'message' && (e.data as MessagingMessage).direction === 'sent');
    expect(sent?.data).toMatchObject({ channel: 'sensors/kitchen/temp', payload: '21.5' });
    handle.close();
  });

  it('delivers a retained message to a later subscriber', async () => {
    const publisher = connect();
    await publisher.handle.publish({ channel: 'status/door', payload: 'open', options: { retain: true } });
    publisher.handle.close();

    const subscriber = connect();
    await subscriber.handle.subscribe({ channel: 'status/door' });
    await expect.poll(subscriber.received).toHaveLength(1);
    expect(subscriber.received()[0]).toMatchObject({ payload: 'open', meta: { retain: true } });
    subscriber.handle.close();
  });

  it('publishes with QoS 1, reporting the acknowledged packet id', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'orders', options: { qos: 1 } });
    const result = await handle.publish({ channel: 'orders', payload: '{"id":1}', options: { qos: 1 } });
    expect(result.meta?.messageId).toEqual(expect.any(Number));
    await expect.poll(received).toHaveLength(1);
    expect(received()[0].meta).toMatchObject({ qos: 1 });
    handle.close();
  });

  it('sends and receives binary payloads as base64', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'blobs' });
    const bytes = Buffer.from([0xff, 0x00, 0xfe, 0x80]);
    await handle.publish({ channel: 'blobs', payload: bytes.toString('base64'), encoding: 'base64' });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({ isBinary: true, payload: bytes.toString('base64') });
    handle.close();
  });

  it('stops receiving after unsubscribing', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'news' });
    await handle.publish({ channel: 'news', payload: 'one' });
    await expect.poll(received).toHaveLength(1);
    await handle.unsubscribe('news');
    await handle.publish({ channel: 'news', payload: 'two' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received().map((m) => m.payload)).toEqual(['one']);
    handle.close();
  });

  it('lets calls made before the connection opens wait for it', async () => {
    const { handle, received } = connect();
    await Promise.all([handle.subscribe({ channel: 'early' }), handle.publish({ channel: 'unrelated', payload: 'x' })]);
    await handle.publish({ channel: 'early', payload: 'bird' });
    await expect.poll(received).toHaveLength(1);
    handle.close();
  });

  it('signs in with a username and password', async () => {
    const { handle, opened } = connect({ auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } } });
    await opened();
    handle.close();
  });

  it('reports a refused sign-in, then closes, and fails calls with the reason', async () => {
    const { handle, events } = connect({ auth: { type: 'basic', basic: { username: 'alice', password: 'wrong' } } });
    await expect(handle.subscribe({ channel: 'x' })).rejects.toThrow(/Bad username or password|Not authorized/i);
    await expect.poll(() => events.map((e) => e.type)).toEqual(['error', 'close']);
  });

  it('reports an unreachable broker with the reason', async () => {
    const { handle, events } = connect({ url: 'mqtt://127.0.0.1:1' });
    await expect(handle.publish({ channel: 'x', payload: 'y' })).rejects.toThrow(/ECONNREFUSED/);
    await expect.poll(() => events[0]?.type).toBe('error');
    expect((events[0].data as { message: string }).message).toMatch(/ECONNREFUSED/);
  });

  it('refuses options it does not know, and headers on MQTT 3.1.1', async () => {
    const { handle } = connect();
    await expect(handle.subscribe({ channel: 'x', options: { qos: 3 } })).rejects.toThrow(/qos must be one of 0, 1, 2/);
    await expect(
      handle.publish({ channel: 'x', payload: 'y', headers: [{ key: 'trace', value: '1', enabled: true }] }),
    ).rejects.toThrow(/protocolVersion 5/);
    handle.close();
  });

  it('reports nothing after close()', async () => {
    const { handle, events, opened } = connect();
    await opened();
    const count = events.length;
    handle.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toHaveLength(count);
    await expect(handle.publish({ channel: 'x', payload: 'y' })).rejects.toThrow(/closed/);
  });

  describe('over TLS', () => {
    it('refuses a self-signed certificate, with the reason', async () => {
      const { handle, events } = connect({ url: tlsUrl });
      await expect(handle.subscribe({ channel: 'x' })).rejects.toThrow(/self-signed certificate/);
      expect(events[0].type).toBe('error');
    });

    it('connects with verifyTls: false', async () => {
      const { handle, received } = connect({ url: tlsUrl, verifyTls: false });
      await handle.subscribe({ channel: 'secure' });
      await handle.publish({ channel: 'secure', payload: 'hello' });
      await expect.poll(received).toHaveLength(1);
      handle.close();
    });
  });
});
