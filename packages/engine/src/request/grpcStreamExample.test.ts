import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../types.js';
import {
  GRPC_STREAM_CONTENT_TYPE,
  grpcStreamExampleBody,
  isGrpcStreamExample,
  readGrpcStreamExample,
  withGrpcStreamRules,
} from './grpcStreamExample.js';

const events: StreamEvent[] = [
  { type: 'open', data: { method: '/chat.Chat/Talk', kind: 'bidi' }, timestamp: 1000 },
  { type: 'message', data: { direction: 'sent', message: { text: 'hi' } }, timestamp: 1010 },
  { type: 'message', data: { direction: 'received', message: { text: 'hello' } }, timestamp: 1250 },
  { type: 'error', data: 'ignored', timestamp: 1260 },
  { type: 'message', data: { direction: 'received', message: { text: 'how are you?' } }, timestamp: 1300 },
  { type: 'message', data: { direction: 'sideways', message: {} }, timestamp: 1400 },
  { type: 'close', data: { status: { code: 0, details: 'OK' }, headers: {}, metadata: {} }, timestamp: 1500 },
];

describe('gRPC stream examples', () => {
  it('keep the messages both ways with the delays between them', () => {
    const body = grpcStreamExampleBody('bidi', events);
    expect(readGrpcStreamExample(body)).toEqual({
      kind: 'bidi',
      messages: [
        { direction: 'sent', delayMs: 10, message: { text: 'hi' } },
        { direction: 'received', delayMs: 240, message: { text: 'hello' } },
        { direction: 'received', delayMs: 50, message: { text: 'how are you?' } },
      ],
    });
  });

  it('are told apart by their Content-Type, and other JSON is not one', () => {
    expect(isGrpcStreamExample({ 'Content-Type': GRPC_STREAM_CONTENT_TYPE })).toBe(true);
    expect(isGrpcStreamExample({ 'content-type': 'application/json' })).toBe(false);
    expect(readGrpcStreamExample('{"messages": []}')).toBeUndefined();
    expect(readGrpcStreamExample('not json')).toBeUndefined();
  });

  it('carry reply rules, replaced as a whole and cleaned up', () => {
    const body = grpcStreamExampleBody('bidi', events);
    const ruled = withGrpcStreamRules(body, [
      { match: 'ping', reply: '{"text": "pong"}', delayMs: 5.4 },
      { match: 7, reply: null, delayMs: -1 } as never,
    ]);
    expect(readGrpcStreamExample(ruled)!.rules).toEqual([
      { match: 'ping', reply: '{"text": "pong"}', delayMs: 5 },
      { match: '', reply: '', delayMs: 0 },
    ]);
    expect(readGrpcStreamExample(withGrpcStreamRules(ruled, []))).not.toHaveProperty('rules');
    expect(() => withGrpcStreamRules('{}', [])).toThrow("isn't a gRPC stream");
  });
});
