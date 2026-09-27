import type { EnvironmentUpdates } from '../types.js';

/** What changed from `before` to `after`: each new or changed value, and null
 * for each one removed. Empty when nothing changed. */
export function diffEnvironment(before: Record<string, string>, after: Record<string, string>): EnvironmentUpdates {
  const updates: EnvironmentUpdates = {};
  for (const [key, value] of Object.entries(after)) {
    if (before[key] !== value) updates[key] = value;
  }
  for (const key of Object.keys(before)) {
    if (!(key in after)) updates[key] = null;
  }
  return updates;
}

/** `values` with `updates` applied (a new copy): null removes a value. */
export function applyEnvironmentUpdates(
  values: Record<string, string>,
  updates: EnvironmentUpdates,
): Record<string, string> {
  const next = { ...values };
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
