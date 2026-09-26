import { describe, expect, it } from 'vitest';
import { createNotification, createRequest, isNotification, isResponse } from './jsonRpc';

describe('createRequest / createNotification', () => {
  it('gives each request a unique, incrementing id', () => {
    const a = createRequest('tools/list');
    const b = createRequest('tools/list');
    expect(a.id).not.toBe(b.id);
    expect(a.jsonrpc).toBe('2.0');
  });

  it('gives a notification no id at all', () => {
    const n = createNotification('notifications/initialized');
    expect('id' in n).toBe(false);
    expect(n.method).toBe('notifications/initialized');
  });
});

describe('isNotification / isResponse', () => {
  it('classifies a notification (method, no id)', () => {
    const message = createNotification('notifications/progress', { progress: 1 });
    expect(isNotification(message)).toBe(true);
    expect(isResponse(message)).toBe(false);
  });

  it('classifies a response (id, no method)', () => {
    const message = { jsonrpc: '2.0' as const, id: 1, result: { ok: true } };
    expect(isResponse(message)).toBe(true);
    expect(isNotification(message)).toBe(false);
  });

  it('does not classify a request (method + id) as either', () => {
    const message = createRequest('tools/list');
    expect(isNotification(message)).toBe(false);
    expect(isResponse(message)).toBe(false);
  });
});
