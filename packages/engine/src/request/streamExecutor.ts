import { openSseStream } from './sse.js';
import { openWebSocketStream } from './websocket.js';
import { openMcpStream } from './mcp.js';
import { isMessagingProtocol, openMessagingStream } from './messaging/index.js';
import { openGrpcStream } from './grpcStream.js';
import { DEFAULT_ENGINE_PROFILE, MESSAGING_PROTOCOLS, type EngineProfile } from '../types.js';
import type { RequestConfig, StreamEvent, StreamHandle, StreamingProtocol } from '../types.js';

const STREAMING_PROTOCOLS: ReadonlySet<StreamingProtocol> = new Set([
  'websocket',
  'sse',
  'grpc',
  'mcp',
  ...MESSAGING_PROTOCOLS,
]);

function isStreamingProtocol(protocol: string): protocol is StreamingProtocol {
  return STREAMING_PROTOCOLS.has(protocol as StreamingProtocol);
}

/**
 * Contract for protocols that don't fit a single awaited request/response —
 * WebSocket, SSE, gRPC streams, and MCP all need an open connection that
 * pushes events over time instead of resolving once (`executeRequest` in
 * executor.ts stays the right call for one-shot protocols: http, graphql,
 * soap). Each streaming protocol fills in its own branch here; unary gRPC
 * calls go through executeGrpcUnaryCall instead, and streaming ones here.
 */
export function openStream(
  config: RequestConfig,
  onEvent: (event: StreamEvent) => void,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): StreamHandle {
  const protocol = config.protocol ?? 'http';
  if (!isStreamingProtocol(protocol)) {
    throw new Error(
      `openStream only supports streaming protocols (${[...STREAMING_PROTOCOLS].join(', ')}) — got "${protocol}". Use executeRequest instead.`,
    );
  }

  if (protocol === 'sse') return openSseStream(config, onEvent);
  if (protocol === 'websocket') return openWebSocketStream(config, onEvent);
  if (protocol === 'mcp') return openMcpStream(config, onEvent, profile);
  // Returns a MessagingStreamHandle (subscribe, unsubscribe, publish).
  if (isMessagingProtocol(protocol)) return openMessagingStream(config, onEvent);
  // Returns a GrpcStreamHandle (send, end) for a streaming method; unary calls use executeGrpcUnaryCall.
  if (protocol === 'grpc') return openGrpcStream(config, onEvent);

  throw new Error(`"${protocol}" streaming is not supported yet.`);
}
