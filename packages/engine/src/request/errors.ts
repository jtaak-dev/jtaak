/**
 * A connection error's full message, including what Node keeps in its
 * `cause` chain. Node's fetch rejects with just "fetch failed" and puts the
 * reason (a DNS failure, a refused connection, an untrusted certificate) in
 * `error.cause`, so its own `message` alone tells a user nothing. This
 * follows the chain and adds each cause's message and code:
 * `fetch failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT)`.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const text = describeOne(current);
    // Some wrappers repeat their cause's message; don't print it twice.
    if (text && !parts.some((part) => part.includes(text))) parts.push(text);
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
  return parts.join(': ') || String(error);
}

function describeOne(value: unknown): string {
  if (typeof value !== 'object') return String(value);
  const { message, code } = value as { message?: unknown; code?: unknown };
  const text = typeof message === 'string' ? message : '';
  if (typeof code !== 'string' || code === '' || text.includes(code)) return text;
  return text ? `${text} (${code})` : code;
}

/** An `Error` whose message is `describeError(error)`, keeping the original as its `cause`. */
export function withErrorDetail(error: unknown): Error {
  return new Error(describeError(error), { cause: error });
}
