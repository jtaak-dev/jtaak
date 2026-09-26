import { openSseStream } from './sse.js';
import { openWebSocketStream } from './websocket.js';
import { openMcpStream } from './mcp.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { RequestConfig, StreamEvent, StreamHandle, StreamingProtocol } from '../types.js';

const STREAMING_PROTOCOLS: ReadonlySet<StreamingProtocol> = new Set(['websocket', 'sse', 'grpc', 'mcp']);

function isStreamingProtocol(protocol: string): protocol is StreamingProtocol {
  return STREAMING_PROTOCOLS.has(protocol as StreamingProtocol);
}

/**
 * Contract for protocols that don't fit a single awaited request/response —
 * WebSocket, SSE, gRPC streams, and MCP all need an open connection that
 * pushes events over time instead of resolving once (`executeRequest` in
 * executor.ts stays the right call for one-shot protocols: http, graphql,
 * soap). Each streaming protocol fills in its own branch here; unary gRPC
 * calls go through executeGrpcUnaryCall instead.
 */
export function openStream(
  config: RequestConfig,
  onEvent: (event: StreamEvent) => void,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): StreamHandle {
  const protocol = config.protocol ?? 'http';
  if (!isStreamingProtocol(protocol)) {
    throw new Error(
      `openStream only supports streaming protocols (websocket, sse, grpc, mcp) — got "${protocol}". Use executeRequest instead.`,
    );
  }

  if (protocol === 'sse') return openSseStream(config, onEvent);
  if (protocol === 'websocket') return openWebSocketStream(config, onEvent);
  if (protocol === 'mcp') return openMcpStream(config, onEvent, profile);
  if (protocol === 'grpc') {
    throw new Error(
      "openStream doesn't support gRPC streaming methods yet (server/client/bidi); " +
        'unary gRPC calls are supported via executeGrpcUnaryCall instead.',
    );
  }

  throw new Error(`"${protocol}" streaming is not supported yet.`);
}
