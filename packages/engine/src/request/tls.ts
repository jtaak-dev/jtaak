import { Agent, fetch as undiciFetch } from 'undici';
import type { RequestConfig } from '../types.js';

/**
 * Whether to check the server's TLS certificate (`RequestConfig.verifyTls`,
 * on unless set to `false`). Turning it off accepts expired, self-signed and
 * wrong-host certificates, which is for testing servers you control; the
 * connection is still encrypted, but not authenticated.
 */
export function verifiesTls(config: Pick<RequestConfig, 'verifyTls'>): boolean {
  return config.verifyTls !== false;
}

let unverifiedAgent: Agent | undefined;

/**
 * The `fetch` to send `config` with. Node's built-in fetch can't skip
 * certificate checks without a custom dispatcher, and passing one from the
 * `undici` package to Node's bundled copy is only safe when their versions
 * line up. So a request with `verifyTls: false` goes through the `undici`
 * package's own fetch and agent together; every other request uses the
 * built-in fetch as before. Both publish the same diagnostics-channel
 * events, so timing (timing.ts) works either way.
 */
export function fetchFor(config: Pick<RequestConfig, 'verifyTls'>): typeof fetch {
  if (verifiesTls(config)) return fetch;
  unverifiedAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  const agent = unverifiedAgent;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher: agent,
    })) as unknown as typeof fetch;
}
