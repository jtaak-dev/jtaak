import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../types';
import { sseExampleBlocks, sseExampleBody } from './sseExample';

const events: StreamEvent[] = [
  { type: 'open', timestamp: 1000 },
  { type: 'message', data: { data: 'hello' }, timestamp: 1100 },
  { type: 'message', data: { event: 'update', id: '7', data: 'line 1\nline 2' }, timestamp: 1350 },
  { type: 'error', data: { message: 'x' }, timestamp: 1400 },
  { type: 'message', data: { event: 'message', data: '' }, timestamp: 1400 },
  { type: 'close', timestamp: 1500 },
];

describe('SSE examples', () => {
  it('keep the messages received with the delay before each', () => {
    expect(sseExampleBody(events)).toBe(
      ':delay 100\ndata: hello\n\n:delay 250\nevent: update\nid: 7\ndata: line 1\ndata: line 2\n\n:delay 50\ndata: \n\n',
    );
    expect(sseExampleBody([])).toBe('');
  });

  it('read back as the blocks to send and their delays', () => {
    expect(sseExampleBlocks(sseExampleBody(events))).toEqual([
      { delayMs: 100, text: 'data: hello\n\n' },
      { delayMs: 250, text: 'event: update\nid: 7\ndata: line 1\ndata: line 2\n\n' },
      { delayMs: 50, text: 'data: \n\n' },
    ]);
    // A stream written by hand, without delays.
    expect(sseExampleBlocks('data: a\r\n\r\n: a comment\ndata: b\n\n\n')).toEqual([
      { delayMs: 0, text: 'data: a\n\n' },
      { delayMs: 0, text: ': a comment\ndata: b\n\n' },
    ]);
  });
});
