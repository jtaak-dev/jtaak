import { describe, expect, it } from 'vitest';
import { applyEnvironmentUpdates, diffEnvironment } from './environmentUpdates';

describe('environment updates', () => {
  it('lists new, changed and removed values', () => {
    expect(diffEnvironment({ a: '1', b: '2', c: '3' }, { a: '1', b: 'two', d: '4' })).toEqual({
      b: 'two',
      d: '4',
      c: null,
    });
    expect(diffEnvironment({ a: '1' }, { a: '1' })).toEqual({});
  });

  it('applies updates to a copy', () => {
    const values = { a: '1', c: '3' };
    expect(applyEnvironmentUpdates(values, { b: '2', c: null })).toEqual({ a: '1', b: '2' });
    expect(values).toEqual({ a: '1', c: '3' });
  });

  it('round-trips: applying the diff gives the new values', () => {
    const before = { a: '1', b: '2' };
    const after = { b: '20', c: '3' };
    expect(applyEnvironmentUpdates(before, diffEnvironment(before, after))).toEqual(after);
  });
});
