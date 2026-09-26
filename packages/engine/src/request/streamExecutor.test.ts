import { describe, expect, it } from 'vitest';
import { openStream } from './streamExecutor';
import type { RequestConfig } from '../types';

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'test request',
    method: 'GET',
    url: 'https://example.com',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('openStream', () => {
  it('rejects protocols that are not streaming protocols', () => {
    expect(() => openStream(baseConfig({ protocol: 'http' }), () => {})).toThrow(/only supports streaming protocols/);
    expect(() => openStream(baseConfig(), () => {})).toThrow(/only supports streaming protocols/);
  });

  // 'grpc' gets its own message: unary calls are implemented (via
  // executeGrpcUnaryCall, see grpc.test.ts), just not through openStream —
  // only the streaming call types are unimplemented here.
  it('reports "grpc" streaming as unsupported, pointing at executeGrpcUnaryCall for unary', () => {
    expect(() => openStream(baseConfig({ protocol: 'grpc' }), () => {})).toThrow(/executeGrpcUnaryCall/);
  });

  it('routes "sse" to the SSE implementation instead of "not implemented"', () => {
    const events: unknown[] = [];
    const handle = openStream(baseConfig({ protocol: 'sse', url: 'http://127.0.0.1:0/does-not-matter' }), (e) =>
      events.push(e),
    );
    expect(handle.close).toBeInstanceOf(Function);
    handle.close();
  });

  it('routes "websocket" to the WebSocket implementation instead of "not implemented"', () => {
    const events: unknown[] = [];
    const handle = openStream(baseConfig({ protocol: 'websocket', url: 'ws://127.0.0.1:0/does-not-matter' }), (e) =>
      events.push(e),
    );
    expect(handle.close).toBeInstanceOf(Function);
    handle.close();
  });

  it('routes "mcp" to the MCP implementation instead of "not implemented"', () => {
    const events: unknown[] = [];
    const handle = openStream(
      baseConfig({
        protocol: 'mcp',
        url: 'jtaak-does-not-exist-binary',
        protocolConfig: { transport: 'stdio', args: [] },
      }),
      (e) => events.push(e),
    );
    expect(handle.close).toBeInstanceOf(Function);
    handle.close();
  });
});
