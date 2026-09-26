import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { openWebSocketStream } from './websocket';
import type { RequestConfig, StreamEvent, WebSocketMessage } from '../types';

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'ws request',
    protocol: 'websocket',
    method: 'GET',
    url: 'ws://unused',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

let httpServer: http.Server | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  wss?.close();
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  httpServer = undefined;
  wss = undefined;
});

/** Starts a plain WS server (echoes every message back) and returns its ws:// base URL. */
async function startEchoServer(configure?: (server: WebSocketServer) => void): Promise<string> {
  httpServer = http.createServer();
  wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (socket) => {
    socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
  });
  configure?.(wss);
  await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
  const { port } = httpServer!.address() as AddressInfo;
  return `ws://127.0.0.1:${port}`;
}

function waitForEvents(count: number, events: StreamEvent[], timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (events.length >= count) return resolve();
      if (Date.now() - start > timeoutMs)
        return reject(new Error(`timed out waiting for ${count} events, got ${events.length}`));
      setTimeout(check, 5);
    };
    check();
  });
}

describe('openWebSocketStream', () => {
  it('connects, echoes a sent message back, and closes cleanly', async () => {
    const url = await startEchoServer();
    const events: StreamEvent[] = [];
    const handle = openWebSocketStream(baseConfig({ url }), (e) => events.push(e));

    await waitForEvents(1, events); // open
    expect(events[0].type).toBe('open');

    handle.send!('hello');
    await waitForEvents(3, events); // open, sent, received

    const sent = events.find((e) => (e.data as WebSocketMessage | undefined)?.direction === 'sent');
    const received = events.find((e) => (e.data as WebSocketMessage | undefined)?.direction === 'received');
    expect(sent?.data).toMatchObject({ data: 'hello', isBinary: false, direction: 'sent' });
    expect(received?.data).toMatchObject({ data: 'hello', isBinary: false, direction: 'received' });

    handle.close();
    await waitForEvents(4, events); // + close
    expect(events[3].type).toBe('close');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('sends Authorization/custom headers on the handshake', async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const url = await startEchoServer((server) => {
      server.on('connection', (_socket, req) => {
        receivedHeaders = req.headers;
      });
    });

    const events: StreamEvent[] = [];
    const handle = openWebSocketStream(
      baseConfig({ url, auth: { type: 'bearer', bearer: { token: 'abc123' } } }),
      (e) => events.push(e),
    );
    await waitForEvents(1, events);
    handle.close();

    expect(receivedHeaders.authorization).toBe('Bearer abc123');
  });

  it('negotiates a subprotocol from protocolConfig.subprotocols', async () => {
    const url = await startEchoServer((server) => {
      server.on('connection', (socket) => {
        // ws auto-selects the first shared subprotocol; report it back so the
        // test can see what the client actually offered.
        socket.send(`protocol:${socket.protocol}`);
      });
    });

    const events: StreamEvent[] = [];
    const handle = openWebSocketStream(
      baseConfig({ url, protocolConfig: { subprotocols: ['chat.v2', 'chat.v1'] } }),
      (e) => events.push(e),
    );
    await waitForEvents(2, events); // open, message

    const message = events.find((e) => e.type === 'message');
    expect((message?.data as WebSocketMessage).data).toBe('protocol:chat.v2');
    handle.close();
  });

  it('reports a rejected handshake (non-101 response) as an error, not a crash', async () => {
    httpServer = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => httpServer!.listen(0, resolve));
    const { port } = httpServer!.address() as AddressInfo;

    const events: StreamEvent[] = [];
    openWebSocketStream(baseConfig({ url: `ws://127.0.0.1:${port}` }), (e) => events.push(e));
    await waitForEvents(1, events);

    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0].data as { message: string }).message).toContain('404');
  });

  it('emits "close" (not "error") when the caller closes an already-open connection', async () => {
    const url = await startEchoServer();
    const events: StreamEvent[] = [];
    const handle = openWebSocketStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(1, events);

    handle.close();
    await waitForEvents(2, events);
    expect(events[1].type).toBe('close');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('performance budget: local echo round-trip', () => {
  it('completes a send-to-echo round trip in under 20ms on loopback', async () => {
    const url = await startEchoServer();
    const events: StreamEvent[] = [];
    const handle = openWebSocketStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(1, events);

    const sentAt = Date.now();
    handle.send!('ping');
    await waitForEvents(3, events); // open, sent, received

    const received = events.find((e) => (e.data as WebSocketMessage | undefined)?.direction === 'received')!;
    expect(received.timestamp - sentAt).toBeLessThan(20);

    handle.close();
  });
});
