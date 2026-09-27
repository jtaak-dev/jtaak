import { describe, expect, it } from 'vitest';
import { describeError, withErrorDetail } from './errors';

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('describeError', () => {
  it("adds the cause's message and code, as Node's fetch hides them there", () => {
    const error = new TypeError('fetch failed', {
      cause: withCode('self-signed certificate', 'DEPTH_ZERO_SELF_SIGNED_CERT'),
    });
    expect(describeError(error)).toBe('fetch failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)');
  });

  it('follows a chain of causes', () => {
    const error = new Error('outer', {
      cause: new Error('middle', { cause: withCode('connect ECONNREFUSED', 'ECONNREFUSED') }),
    });
    expect(describeError(error)).toBe('outer: middle: connect ECONNREFUSED');
  });

  it("doesn't repeat a code or message that's already there", () => {
    expect(describeError(withCode('getaddrinfo ENOTFOUND example.invalid', 'ENOTFOUND'))).toBe(
      'getaddrinfo ENOTFOUND example.invalid',
    );
    expect(describeError(new Error('boom', { cause: new Error('boom') }))).toBe('boom');
  });

  it("handles a cause that points back at itself, and values that aren't errors", () => {
    const error = new Error('loop') as Error & { cause?: unknown };
    error.cause = error;
    expect(describeError(error)).toBe('loop');
    expect(describeError('plain text')).toBe('plain text');
    expect(describeError(undefined)).toBe('undefined');
  });
});

describe('withErrorDetail', () => {
  it('keeps the original error as the cause', () => {
    const original = new TypeError('fetch failed', { cause: withCode('socket hang up', 'ECONNRESET') });
    const wrapped = withErrorDetail(original);
    expect(wrapped.message).toBe('fetch failed: socket hang up (ECONNRESET)');
    expect(wrapped.cause).toBe(original);
  });
});
