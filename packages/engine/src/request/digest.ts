import { createHash, randomBytes } from 'node:crypto';

/** One `Digest` challenge from a `WWW-Authenticate` header (RFC 7616 §3.3). */
export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  /** Upper case, e.g. `MD5`, `SHA-256`, `SHA-256-SESS`. */
  algorithm: string;
  /** The qop values the server offers (`auth`, `auth-int`); empty for an RFC 2069 server. */
  qop: string[];
  userhash: boolean;
  stale: boolean;
}

const SUPPORTED = ['SHA-256', 'SHA-256-SESS', 'MD5', 'MD5-SESS'];

/** A header's challenges, as scheme and parameters. Parameters are `name=token` or `name="quoted"`, separated by commas. */
function parseChallenges(header: string): Array<{ scheme: string; params: Record<string, string> }> {
  const challenges: Array<{ scheme: string; params: Record<string, string> }> = [];
  let at = 0;
  const skip = (pattern: RegExp) => {
    while (at < header.length && pattern.test(header[at])) at++;
  };
  while (at < header.length) {
    skip(/[\s,]/);
    const scheme = /^[!#$%&'*+.^_`|~\w-]+/.exec(header.slice(at))?.[0];
    if (!scheme) break;
    at += scheme.length;
    const params: Record<string, string> = {};
    challenges.push({ scheme: scheme.toLowerCase(), params });
    for (;;) {
      skip(/[\s,]/);
      const name = /^([!#$%&'*+.^_`|~\w-]+)\s*=\s*/.exec(header.slice(at));
      // A token without "=" starts the next challenge.
      if (!name) break;
      at += name[0].length;
      let value = '';
      if (header[at] === '"') {
        at++;
        while (at < header.length && header[at] !== '"') {
          if (header[at] === '\\') at++;
          value += header[at++] ?? '';
        }
        at++;
      } else {
        const token = /^[^\s,]*/.exec(header.slice(at))![0];
        value = token;
        at += token.length;
      }
      params[name[1].toLowerCase()] = value;
    }
  }
  return challenges;
}

/**
 * The Digest challenge to answer in a `WWW-Authenticate` header, or undefined
 * when there's none this supports. With several, SHA-256 is preferred to MD5.
 */
export function parseDigestChallenge(header: string): DigestChallenge | undefined {
  const offered = parseChallenges(header)
    .filter((c) => c.scheme === 'digest' && c.params.nonce !== undefined)
    .map(({ params }) => ({
      realm: params.realm ?? '',
      nonce: params.nonce,
      ...(params.opaque !== undefined && { opaque: params.opaque }),
      algorithm: (params.algorithm ?? 'MD5').toUpperCase(),
      qop: (params.qop ?? '')
        .split(',')
        .map((q) => q.trim().toLowerCase())
        .filter(Boolean),
      userhash: params.userhash?.toLowerCase() === 'true',
      stale: params.stale?.toLowerCase() === 'true',
    }))
    .filter((c) => SUPPORTED.includes(c.algorithm));
  return offered.sort((a, b) => SUPPORTED.indexOf(a.algorithm) - SUPPORTED.indexOf(b.algorithm))[0];
}

export interface DigestInput {
  username: string;
  password: string;
  method: string;
  /** The request target: path and query, as sent. */
  uri: string;
  /** The body, for `qop=auth-int`; only a text body can be hashed. */
  body?: string;
  /** Fixed in tests; random otherwise. */
  cnonce?: string;
  /** How many times this nonce was used, counting this request; default 1. */
  nonceCount?: number;
}

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** The `Authorization` header answering `challenge` (RFC 7616 §3.4). */
export function digestAuthorization(challenge: DigestChallenge, input: DigestInput): string {
  const sha = challenge.algorithm.startsWith('SHA-256');
  const hash = (text: string) =>
    createHash(sha ? 'sha256' : 'md5')
      .update(text, 'utf8')
      .digest('hex');
  const cnonce = input.cnonce ?? randomBytes(16).toString('hex');
  const nc = (input.nonceCount ?? 1).toString(16).padStart(8, '0');
  // auth-int needs the body's hash; take it only when the body is text (or empty).
  const qop = challenge.qop.includes('auth')
    ? 'auth'
    : challenge.qop.includes('auth-int') && input.body !== undefined
      ? 'auth-int'
      : challenge.qop.length === 0
        ? undefined
        : 'auth';

  let ha1 = hash(`${input.username}:${challenge.realm}:${input.password}`);
  if (challenge.algorithm.endsWith('-SESS')) ha1 = hash(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 =
    qop === 'auth-int'
      ? hash(`${input.method}:${input.uri}:${hash(input.body ?? '')}`)
      : hash(`${input.method}:${input.uri}`);
  const response = qop
    ? hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${challenge.nonce}:${ha2}`);

  const username = challenge.userhash ? hash(`${input.username}:${challenge.realm}`) : input.username;
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(challenge.realm)}`,
    `nonce=${quote(challenge.nonce)}`,
    `uri=${quote(input.uri)}`,
    `algorithm=${challenge.algorithm}`,
    `response=${quote(response)}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce=${quote(cnonce)}`);
  if (challenge.opaque !== undefined) parts.push(`opaque=${quote(challenge.opaque)}`);
  if (challenge.userhash) parts.push('userhash=true');
  return `Digest ${parts.join(', ')}`;
}
