import { describe, expect, it } from 'vitest';
import { decodePayload, encodePayload, headerRecord } from './payload';

describe('decodePayload', () => {
  it('keeps UTF-8 as text, including non-ASCII', () => {
    expect(decodePayload(Buffer.from('héllo ✓', 'utf-8'))).toEqual({ payload: 'héllo ✓', isBinary: false });
  });

  it('gives bytes that are not valid UTF-8 as base64', () => {
    const bytes = Buffer.from([0xc3, 0x28, 0x00, 0xff]);
    expect(decodePayload(bytes)).toEqual({ payload: bytes.toString('base64'), isBinary: true });
  });

  it('reads only the view it is given, not the whole underlying buffer', () => {
    const whole = Buffer.from('xxHELLOxx');
    expect(decodePayload(whole.subarray(2, 7)).payload).toBe('HELLO');
    const binary = Buffer.from([0x41, 0xff, 0x42]).subarray(1, 2);
    expect(decodePayload(binary)).toEqual({ payload: '/w==', isBinary: true });
  });
});

describe('encodePayload', () => {
  it('encodes text as UTF-8, and decodes base64', () => {
    expect(encodePayload({ payload: 'é' })).toEqual(Buffer.from([0xc3, 0xa9]));
    expect(encodePayload({ payload: '/wA=', encoding: 'base64' })).toEqual(Buffer.from([0xff, 0x00]));
  });
});

describe('headerRecord', () => {
  it('keeps enabled, named headers; a later duplicate wins', () => {
    expect(
      headerRecord([
        { key: 'a', value: '1', enabled: true },
        { key: 'b', value: '2', enabled: false },
        { key: ' ', value: '3', enabled: true },
        { key: 'a', value: '4', enabled: true },
      ]),
    ).toEqual({ a: '4' });
  });

  it('gives undefined when there are none', () => {
    expect(headerRecord(undefined)).toBeUndefined();
    expect(headerRecord([{ key: 'a', value: '1', enabled: false }])).toBeUndefined();
  });
});
