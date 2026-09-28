import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openMcpStream } from './mcp';
import type { RequestConfig, StreamEvent } from '../types';

let server: http.Server | undefined;
let receivedHeaders: http.IncomingHttpHeaders[] = [];
const SESSION_ID = 'session-abc-123';

/** A minimal MCP "Streamable HTTP" server: initialize responds as plain
 * JSON (with the session-id header the spec requires), tools/list responds
 * as an SSE stream (exercising the SseFrameParser reuse), and anything else
 * unknown gets a JSON-RPC "method not found" error. */
async function startHttpMcpServer(): Promise<string> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      receivedHeaders.push(req.headers);
      const message = JSON.parse(body);

      if (message.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': SESSION_ID });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
              capabilities: {},
            },
          }),
        );
      } else if (message.method === 'notifications/initialized') {
        res.writeHead(202);
        res.end();
      } else if (message.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', inputSchema: {} }] } })}\n\n`,
        );
        res.end();
      } else if (message.id !== undefined) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }),
        );
      } else {
        res.writeHead(202);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  receivedHeaders = [];
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function baseConfig(url: string, overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'mcp http connection',
    protocol: 'mcp',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    protocolConfig: { transport: 'http' },
    ...overrides,
  };
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

describe('openMcpStream (HTTP transport)', () => {
  it('emits "open" with the initialize result once the handshake completes', async () => {
    const url = await startHttpMcpServer();
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url), (e) => events.push(e));
    await waitForEvents(1, events);

    expect(events[0].type).toBe('open');
    expect(events[0].data).toMatchObject({ serverInfo: { name: 'fake-http-mcp' } });
    handle.close();
  });

  it('makes a capability call over the handle after connecting, handling an SSE-mode response', async () => {
    const url = await startHttpMcpServer();
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url), (e) => events.push(e));
    await waitForEvents(1, events);

    const result = (await handle.request('tools/list')) as { tools: Array<{ name: string }> };
    expect(result.tools).toEqual([{ name: 'echo', inputSchema: {} }]);
    handle.close();
  });

  it('echoes the Mcp-Session-Id back on subsequent requests and sends auth as a header', async () => {
    const url = await startHttpMcpServer();
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url, { auth: { type: 'bearer', bearer: { token: 'xyz' } } }), (e) =>
      events.push(e),
    );
    await waitForEvents(1, events);
    await handle.request('tools/list');

    // [0] initialize, [1] notifications/initialized, [2] tools/list
    expect(receivedHeaders[0].authorization).toBe('Bearer xyz');
    expect(receivedHeaders[2]['mcp-session-id']).toBe(SESSION_ID);
    handle.close();
  });

  it('rejects a request for an unknown method with the server-reported error', async () => {
    const url = await startHttpMcpServer();
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url), (e) => events.push(e));
    await waitForEvents(1, events);

    await expect(handle.request('does/not-exist')).rejects.toThrow(/Method not found/);
    handle.close();
  });

  it("fails a call whose request can't be delivered, saying why, instead of waiting forever", async () => {
    const url = await startHttpMcpServer();
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url), (e) => events.push(e));
    await waitForEvents(1, events);

    // The server goes away after the handshake.
    server!.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;

    await expect(handle.request('tools/list')).rejects.toThrow(/fetch failed: .*ECONNREFUSED/);
    handle.close();
  });
});

describe("openMcpStream: a URL that isn't an MCP endpoint", () => {
  /** A server that answers every request the same way. */
  async function answering(status: number, headers: Record<string, string>, body: string): Promise<string> {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(status, headers).end(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/mcp`;
  }

  async function errorFor(url: string): Promise<string> {
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url), (e) => events.push(e));
    await waitForEvents(1, events);
    handle.close();
    expect(events[0].type).toBe('error');
    return (events[0].data as { message: string }).message;
  }

  it('says so for a 404, with what the server said and what to check', async () => {
    // What a reverse proxy with no route for the host answers.
    const url = await answering(404, { 'content-type': 'text/plain; charset=utf-8' }, '404 page not found');
    const message = await errorFor(url);
    expect(message).toContain(`${url} isn't an MCP endpoint: the server answered 404 Not Found: 404 page not found.`);
    expect(message).toContain('an MCP server usually answers at a path such as /mcp');
  });

  it('says a web page is no MCP endpoint either', async () => {
    const url = await answering(200, { 'content-type': 'text/html' }, '<html><body>Welcome</body></html>');
    expect(await errorFor(url)).toContain(
      `${url} isn't an MCP endpoint: it answered with "text/html" instead of JSON-RPC`,
    );
  });

  it('says a 401 needs credentials, with the reason the server gave', async () => {
    const url = await answering(401, { 'content-type': 'application/json' }, '{"error":"invalid_token"}');
    expect(await errorFor(url)).toContain(
      'The MCP server refused the request (401 Unauthorized): {"error":"invalid_token"}. It needs credentials',
    );
  });

  it('leaves out a web page as the reason, and keeps other failures as they were', async () => {
    const url = await answering(502, { 'content-type': 'text/html' }, '<html>Bad gateway</html>');
    expect(await errorFor(url)).toContain('MCP HTTP request failed: 502 Bad Gateway');
    expect(await errorFor(url)).not.toContain('<html>');
  });

  it('says the session ended when a 404 comes after the session started', async () => {
    const url = await startHttpMcpServer();
    const events: StreamEvent[] = [];
    const handle = openMcpStream(baseConfig(url), (e) => events.push(e));
    await waitForEvents(1, events);
    // The server forgets the session: from now on it answers 404.
    server!.removeAllListeners('request');
    server!.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      req.resume();
      req.on('end', () => res.writeHead(404).end());
    });
    await expect(handle.request('tools/list')).rejects.toThrow(
      'The MCP session ended (the server answered 404 Not Found): connect again.',
    );
    handle.close();
  });
});
