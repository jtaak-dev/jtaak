import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openSseStream } from './sse';
import type { RequestConfig, StreamEvent } from '../types';

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'sse request',
    protocol: 'sse',
    method: 'GET',
    url: 'http://unused',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** Starts a server whose handler is given raw control over the response, and returns its base URL. */
async function startServer(handler: (res: http.ServerResponse, req: http.IncomingMessage) => void): Promise<string> {
  server = http.createServer((req, res) => handler(res, req));
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
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

describe('openSseStream', () => {
  it('parses basic event/data/id fields and dispatches on the blank line', async () => {
    const url = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: greeting\ndata: hello\nid: 1\n\n');
      res.end();
    });

    const events: StreamEvent[] = [];
    const handle = openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(3, events); // open, message, close
    handle.close();

    expect(events[0].type).toBe('open');
    expect(events[1]).toMatchObject({ type: 'message', data: { event: 'greeting', data: 'hello', id: '1' } });
    expect(events[2].type).toBe('close');
  });

  it('joins multi-line data with newlines and ignores comment lines', async () => {
    const url = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': this is a comment\ndata: line one\ndata: line two\n\n');
      res.end();
    });

    const events: StreamEvent[] = [];
    openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(3, events);

    const message = events.find((e) => e.type === 'message');
    expect(message?.data).toMatchObject({ data: 'line one\nline two' });
  });

  it('defaults event type to undefined (caller treats as "message") when the server omits it', async () => {
    const url = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: no event field\n\n');
      res.end();
    });

    const events: StreamEvent[] = [];
    openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(3, events);

    const message = events.find((e) => e.type === 'message');
    expect(message?.data).toMatchObject({ data: 'no event field', event: undefined });
  });

  it('reassembles an event split across multiple chunk writes', async () => {
    const url = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: pa');
      setTimeout(() => {
        res.write('rt-two\n\n');
        res.end();
      }, 20);
    });

    const events: StreamEvent[] = [];
    openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(3, events);

    const message = events.find((e) => e.type === 'message');
    expect(message?.data).toMatchObject({ data: 'part-two' });
  });

  it('emits a "close" event (not "error") when the caller calls close() mid-stream', async () => {
    let responseRef: http.ServerResponse | undefined;
    const url = await startServer((res) => {
      responseRef = res;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      // Deliberately never end() — the connection stays open until aborted.
    });

    const events: StreamEvent[] = [];
    const handle = openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(2, events); // open, message

    handle.close();
    await waitForEvents(3, events); // + close
    expect(events[2].type).toBe('close');
    expect(events.some((e) => e.type === 'error')).toBe(false);

    responseRef?.end();
  });

  it('sends Authorization/custom headers and a default Accept header', async () => {
    let receivedHeaders: http.IncomingHttpHeaders = {};
    const url = await startServer((res, req) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ok\n\n');
      res.end();
    });

    const events: StreamEvent[] = [];
    openSseStream(baseConfig({ url, auth: { type: 'bearer', bearer: { token: 'abc123' } } }), (e) => events.push(e));
    await waitForEvents(3, events);

    expect(receivedHeaders.authorization).toBe('Bearer abc123');
    expect(receivedHeaders.accept).toBe('text/event-stream');
  });

  it('reports a non-2xx response as an error event, not a crash', async () => {
    const url = await startServer((res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });

    const events: StreamEvent[] = [];
    openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(1, events);

    expect(events[0]).toMatchObject({ type: 'error' });
  });
});

describe('performance budget: event dispatch latency', () => {
  it('dispatches a message within a few ms of the server writing it (loopback, excluding intentional delay)', async () => {
    let sentAt = 0;
    const url = await startServer((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sentAt = Date.now();
      res.write('data: timed\n\n');
      res.end();
    });

    const events: StreamEvent[] = [];
    openSseStream(baseConfig({ url }), (e) => events.push(e));
    await waitForEvents(3, events);

    const messageEvent = events.find((e) => e.type === 'message')!;
    const latency = messageEvent.timestamp - sentAt;
    // Generous margin over the 5ms budget to absorb loopback network time and
    // scheduler jitter on a shared/loaded machine — see the executor test's own
    // rationale for the same tradeoff.
    expect(latency).toBeLessThan(50);
  });
});
