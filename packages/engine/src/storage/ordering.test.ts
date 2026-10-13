import { describe, expect, it } from 'vitest';
import { reorderPositions } from './ordering';

/** The values after a reorder, in the wanted order. */
function after(current: number[]): number[] {
  return reorderPositions(current).map((value, index) => value ?? current[index]);
}

function increasing(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value > values[index - 1]);
}

describe('reorderPositions', () => {
  it('changes nothing already in order', () => {
    expect(reorderPositions([0, 1, 5])).toEqual([undefined, undefined, undefined]);
  });

  it('moves one item to the front, the back or between two others, changing only it', () => {
    expect(reorderPositions([3, 0, 1, 2])).toEqual([-1, undefined, undefined, undefined]);
    expect(reorderPositions([1, 2, 3, 0])).toEqual([undefined, undefined, undefined, 4]);
    expect(reorderPositions([0, 2, 1, 3])).toEqual([undefined, 0.5, undefined, undefined]);
  });

  it('spreads several moved items evenly between their neighbours', () => {
    expect(after([0, 9, 8, 1])).toEqual([0, 1 / 3, 2 / 3, 1]);
  });

  it('numbers everything again when the gap runs out of precision', () => {
    expect(reorderPositions([1, 1 + 2 ** -51, 1 + 2 ** -52])).toEqual([0, 1, 2]);
  });

  it('always gives a strictly increasing order', () => {
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 200; round += 1) {
      const values = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, i) => i);
      values.sort(() => random() - 0.5);
      expect(increasing(after(values))).toBe(true);
    }
  });
});
