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
});
