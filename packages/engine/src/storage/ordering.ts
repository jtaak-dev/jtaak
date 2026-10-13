/**
 * New sort orders for items wanted in a given order, changing as few as
 * possible: the longest run already in increasing order keeps its values, and
 * each other item gets a value between its new neighbours (a fraction where
 * they're adjacent integers; SQLite keeps a REAL in an INTEGER column). Moving
 * one item then changes one row, which matters to anything that stores each
 * item separately and compares versions, such as a workspace folder in git.
 *
 * `current` is each item's present sort order, in the wanted order. Returns the
 * new value for each position, or undefined where it stays. When the gaps run
 * out of precision, every item is numbered again from 0.
 */
export function reorderPositions(current: number[]): (number | undefined)[] {
  const keep = longestIncreasing(current);
  const result: (number | undefined)[] = current.map(() => undefined);
  let i = 0;
  while (i < current.length) {
    if (keep.has(i)) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < current.length && !keep.has(end)) end += 1;
    const low = i > 0 ? current[i - 1] : undefined;
    const high = end < current.length ? current[end] : undefined;
    const count = end - i;
    for (let k = 0; k < count; k += 1) {
      result[i + k] =
        low === undefined && high === undefined
          ? k
          : low === undefined
            ? high! - (count - k)
            : high === undefined
              ? low + k + 1
              : low + ((high - low) * (k + 1)) / (count + 1);
    }
    i = end;
  }
  const final = current.map((value, index) => result[index] ?? value);
  const distinct = final.every((value, index) => index === 0 || value > final[index - 1]);
  return distinct ? result : current.map((_, index) => index);
}

/** The indexes of a longest strictly increasing subsequence (patience sorting). */
function longestIncreasing(values: number[]): Set<number> {
  const tails: number[] = [];
  const previous: number[] = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const keep = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) keep.add(i);
  return keep;
}
