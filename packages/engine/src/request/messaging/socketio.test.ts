import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { selfSignedCertificate } from '../../test/tls';
import { openStream } from '../streamExecutor';
import type { MessagingMessage, MessagingStreamHandle, RequestConfig, StreamEvent } from '../../types';

// An in-process Socket.IO server over HTTP and HTTPS (self-signed). The
// default namespace greets each client and echoes what it's sent; "/admin"
// needs the token "s3cret" in the handshake's auth payload.
let httpServer: http.Server;
let httpsServer: https.Server;
let io: Server;
let base: string;
let secureBase: string;
const lastHandshake: { auth?: unknown; header?: unknown } = {};

function wire(server: Server) {
  server.on('connection', (socket) => {
    lastHandshake.auth = socket.handshake.auth;
    lastHandshake.header = socket.handshake.headers['x-trace'];
    socket.emit('welcome', { id: socket.id });
    socket.on('echo', (...args: unknown[]) => {
      const ack = typeof args.at(-1) === 'function' ? (args.pop() as (reply: unknown) => void) : undefined;
      if (ack) ack({ received: args });
      else socket.emit('echoed', ...args);
    });
    socket.on('shout', (text: string) => socket.emit('shouted', text.toUpperCase()));
    socket.on('bytes', (data: Buffer) => socket.emit('bytes', data));
    socket.on('bye', () => socket.disconnect(true));
    socket.on('ask', () => socket.emit('question', 'ready?', () => {}));
  });
  server.of('/admin').use((socket, next) => {
    if (socket.handshake.auth.token === 's3cret') next();
    else next(new Error('Not allowed'));
  });
  server.of('/admin').on('connection', (socket) => socket.emit('welcome', 'admin'));
}

beforeAll(async () => {
  httpServer = http.createServer();
  io = new Server(httpServer);
  wire(io);
  httpsServer = https.createServer(selfSignedCertificate());
  wire(new Server(httpsServer));
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  secureBase = `https://127.0.0.1:${(httpsServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  io.close();
  httpsServer.closeAllConnections();
  httpsServer.close();
});

function connect(overrides: Partial<RequestConfig> = {}) {
  const events: StreamEvent[] = [];
  const handle = openStream(
    {
      id: 'sio',
      name: 'sio',
      protocol: 'socketio',
      method: 'GET',
      url: base,
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
  const types = () => events.map((e) => e.type);
  return { handle, events, received, types };
}

describe('Socket.IO', () => {
  it('connects, and receives only the events it subscribed to', async () => {
    const { handle, events, received } = connect();
    await handle.subscribe({ channel: 'shouted' });
    expect(events[0]).toMatchObject({ type: 'open', data: { protocol: 'socketio', namespace: '/' } });

    await handle.publish({ channel: 'shout', payload: 'hello' });
    await expect.poll(received).toHaveLength(1);
    // 'welcome' arrived too, but nobody subscribed to it.
    expect(received()[0]).toMatchObject({ channel: 'shouted', payload: 'HELLO', isBinary: false });
    handle.close();
  });

  it('receives every event with "*"', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: '*' });
    await handle.publish({ channel: 'shout', payload: 'a' });
    await expect.poll(() => received().map((m) => m.channel)).toContain('shouted');
    handle.close();
  });

  it('sends JSON payloads as values, and several arguments with spread', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'echoed' });
    await handle.publish({ channel: 'echo', payload: '{"n":1}' });
    await handle.publish({ channel: 'echo', payload: 'not json' });
    await handle.publish({ channel: 'echo', payload: '["a", 2]', options: { spread: true } });
    await expect.poll(received).toHaveLength(3);
    expect(received().map((m) => m.payload)).toEqual(['{"n":1}', 'not json', '["a",2]']);
    expect(received()[2].meta).toMatchObject({ args: 2 });
    handle.close();
  });

  it('waits for an acknowledgement, and reports its reply', async () => {
    const { handle } = connect();
    const result = await handle.publish({ channel: 'echo', payload: '{"q":"?"}', options: { ack: true } });
    expect(result.meta).toEqual({ ack: '{"received":[{"q":"?"}]}' });
    handle.close();
  });

  it('times out an acknowledgement the server never sends', async () => {
    const { handle } = connect();
    await expect(
      handle.publish({ channel: 'nobody-listens', payload: 'x', options: { ack: true, timeout: 0.2 } }),
    ).rejects.toThrow(/timed out/i);
    handle.close();
  });

  it('sends and receives binary data as base64', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'bytes' });
    const bytes = Buffer.from([0xff, 0x00, 0x7f]);
    await handle.publish({ channel: 'bytes', payload: bytes.toString('base64'), encoding: 'base64' });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({ isBinary: true, payload: bytes.toString('base64') });
    handle.close();
  });

  it('marks events the server wants acknowledged', async () => {
    const { handle, received } = connect();
    await handle.subscribe({ channel: 'question' });
    await handle.publish({ channel: 'ask', payload: '' });
    await expect.poll(received).toHaveLength(1);
    expect(received()[0]).toMatchObject({ payload: 'ready?', meta: { ackRequested: true } });
    handle.close();
  });

  it('sends the bearer token, the auth payload and headers in the handshake', async () => {
    const { handle } = connect({
      auth: { type: 'bearer', bearer: { token: 'tok' } },
      headers: [{ key: 'X-Trace', value: 'abc', enabled: true }],
      protocolConfig: { auth: { room: 'lobby' } },
    });
    await handle.subscribe({ channel: 'x' });
    expect(lastHandshake).toEqual({ auth: { room: 'lobby', token: 'tok' }, header: 'abc' });
    handle.close();
  });

  it('joins a namespace that checks the token, and reports a refusal', async () => {
    const allowed = connect({ url: `${base}/admin`, auth: { type: 'bearer', bearer: { token: 's3cret' } } });
    await allowed.handle.subscribe({ channel: 'x' });
    expect(allowed.events[0]).toMatchObject({ type: 'open', data: { namespace: '/admin' } });
    allowed.handle.close();

    const refused = connect({ url: `${base}/admin` });
    await expect(refused.handle.subscribe({ channel: 'x' })).rejects.toThrow('Not allowed');
    await expect.poll(refused.types).toEqual(['error', 'close']);
  });

  it('reports the server disconnecting, with the reason', async () => {
    const { handle, events, types } = connect();
    await handle.publish({ channel: 'bye', payload: '' });
    await expect.poll(types).toContain('close');
    expect(events.at(-1)).toMatchObject({ type: 'close', data: { reason: 'io server disconnect' } });
  });

  it('reports an unreachable server with the reason', async () => {
    const { handle } = connect({ url: 'http://127.0.0.1:1', protocolConfig: { transports: ['websocket'] } });
    await expect(handle.subscribe({ channel: 'x' })).rejects.toThrow(/ECONNREFUSED/);
  });

  describe('over TLS', () => {
    it('refuses a self-signed certificate, with the reason', async () => {
      const { handle } = connect({ url: secureBase, protocolConfig: { transports: ['websocket'] } });
      await expect(handle.subscribe({ channel: 'x' })).rejects.toThrow(/self-signed certificate/);
    });

    it('connects with verifyTls: false', async () => {
      const { handle, received } = connect({ url: secureBase, verifyTls: false });
      await handle.subscribe({ channel: 'shouted' });
      await handle.publish({ channel: 'shout', payload: 'tls' });
      await expect.poll(received).toHaveLength(1);
      handle.close();
    });
  });
});
