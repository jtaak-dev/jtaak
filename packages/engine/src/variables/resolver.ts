import type { VariableScope } from '../types.js';

// Precedence, narrowest to widest — matches the order documented on VariableScope.
const SCOPE_ORDER: (keyof VariableScope)[] = ['local', 'environment', 'collection', 'workspace', 'global'];

const VARIABLE_PATTERN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Resolves {{variable}} tokens in a string against the scope chain.
 * An unresolved variable is left untouched (not blanked) so the author
 * notices it immediately instead of silently sending an empty value.
 */
export function resolveVariables(input: string, scopes: VariableScope): string {
  return input.replace(VARIABLE_PATTERN, (match, name: string) => {
    for (const scope of SCOPE_ORDER) {
      const value = scopes[scope]?.[name];
      if (value !== undefined) return value;
    }
    return match;
  });
}

/** A `{{variable}}` in a string: where it is, and what it resolves to. */
export interface VariableReference {
  name: string;
  /** Where `{{` starts, and just after `}}`. */
  start: number;
  end: number;
  /** Its value, and the scope that gives it; both absent when it's unresolved. */
  value?: string;
  scope?: keyof VariableScope;
}

/** Every `{{variable}}` in a string, in order, with how each resolves (for showing which are defined). */
export function findVariables(input: string, scopes: VariableScope): VariableReference[] {
  const found: VariableReference[] = [];
  for (const match of input.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    const reference: VariableReference = { name, start: match.index, end: match.index + match[0].length };
    for (const scope of SCOPE_ORDER) {
      const value = scopes[scope]?.[name];
      if (value !== undefined) {
        reference.value = value;
        reference.scope = scope;
        break;
      }
    }
    found.push(reference);
  }
  return found;
}

/** Recursively resolves variables in every string field of an object or array. */
export function resolveDeep<T>(value: T, scopes: VariableScope): T {
  if (typeof value === 'string') {
    return resolveVariables(value, scopes) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, scopes)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveDeep(val, scopes);
    }
    return out as T;
  }
  return value;
}
