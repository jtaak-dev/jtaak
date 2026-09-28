import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkSettings, OAuth2Config, OAuth2Token } from '../types.js';
import { describeError } from './errors.js';
import { fetchFor } from './tls.js';

/**
 * Where OAuth 2.0 tokens are kept between requests, keyed by
 * `oauth2TokenKey`: requests with the same client and provider share one
 * token. `storage/oauth2Tokens.ts` keeps a workspace's in SQLite.
 */
export interface OAuth2TokenStore {
  get(key: string): OAuth2Token | undefined;
  set(key: string, token: OAuth2Token): void;
  delete(key: string): void;
}

export class MemoryOAuth2TokenStore implements OAuth2TokenStore {
  private tokens = new Map<string, OAuth2Token>();
  get(key: string) {
    return this.tokens.get(key);
  }
  set(key: string, token: OAuth2Token) {
    this.tokens.set(key, token);
  }
  delete(key: string) {
    this.tokens.delete(key);
  }
}

/** What identifies a token: the grant, the provider, the client, and what was asked for. Secrets aren't part of it. */
export function oauth2TokenKey(config: OAuth2Config): string {
  return JSON.stringify([
    config.grantType,
    config.tokenUrl.trim(),
    config.grantType === 'authorization_code' ? (config.authUrl ?? '').trim() : '',
    config.clientId.trim(),
    (config.scope ?? '').trim(),
    (config.audience ?? '').trim(),
    config.grantType === 'password' ? (config.username ?? '') : '',
  ]);
}

/** Whether a token can still be sent: it has no expiry, or expires more than `marginMs` from now. */
export function isOAuth2TokenValid(token: OAuth2Token | undefined, now = Date.now(), marginMs = 30_000): boolean {
  return !!token?.accessToken && (token.expiresAt === undefined || token.expiresAt - marginMs > now);
}

const base64Url = (bytes: Buffer) =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its S256 challenge (RFC 7636). */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  return { verifier, challenge: base64Url(createHash('sha256').update(verifier).digest()) };
}

/** The provider's authorization page, for the authorization code grant. */
export function buildAuthorizationUrl(
  config: OAuth2Config,
  options: { redirectUri: string; state: string; codeChallenge?: string },
): string {
  if (!config.authUrl) throw new Error('OAuth 2.0: the authorization code grant needs an authorization URL.');
  const url = new URL(config.authUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OAuth 2.0: the authorization URL must be http or https.');
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', options.redirectUri);
  url.searchParams.set('state', options.state);
  if (config.scope) url.searchParams.set('scope', config.scope);
  if (config.audience) url.searchParams.set('audience', config.audience);
  if (options.codeChallenge) {
    url.searchParams.set('code_challenge', options.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

export interface OAuth2RequestOptions {
  /** See `RequestConfig.verifyTls` and `RequestConfig.network`; they apply to the token endpoint. */
  verifyTls?: boolean;
  network?: NetworkSettings;
  now?: number;
}

/** RFC 6749 §2.3.1: the id and secret are form-encoded before going in the Basic header. */
const formEncode = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');

/** POSTs a token request (RFC 6749 §4.1.3, §4.3.2, §4.4.2, §6) and reads the token from the answer. */
async function requestToken(
  config: OAuth2Config,
  params: Record<string, string>,
  options: OAuth2RequestOptions,
): Promise<OAuth2Token> {
  if (!config.tokenUrl) throw new Error('OAuth 2.0: a token URL is needed.');
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (config.clientSecret && config.clientAuth !== 'body') {
    headers.Authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(config.clientSecret)}`).toString('base64')}`;
  } else {
    // A public client (no secret) always names itself in the body.
    body.set('client_id', config.clientId);
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
  }
  if (config.audience && params.grant_type !== 'authorization_code') body.set('audience', config.audience);

  let response: Response;
  try {
    response = await fetchFor(options)(config.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
  } catch (error) {
    throw new Error(`OAuth 2.0: couldn't reach the token URL: ${describeError(error)}`, { cause: error });
  }
  const text = await response.text();
  let answer: Record<string, unknown>;
  try {
    answer = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Some providers (GitHub, without Accept) answer form-encoded.
    answer = Object.fromEntries(new URLSearchParams(text));
  }
  if (!response.ok || typeof answer.error === 'string' || typeof answer.access_token !== 'string') {
    const error = typeof answer.error === 'string' ? answer.error : `HTTP ${response.status}`;
    const description = typeof answer.error_description === 'string' ? `: ${answer.error_description}` : '';
    throw new Error(`OAuth 2.0: the token URL refused the request (${error}${description}).`);
  }
  const now = options.now ?? Date.now();
  const expiresIn = Number(answer.expires_in);
  return {
    accessToken: answer.access_token,
    ...(typeof answer.token_type === 'string' && { tokenType: answer.token_type }),
    ...(typeof answer.refresh_token === 'string' && { refreshToken: answer.refresh_token }),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 && { expiresAt: now + expiresIn * 1000 }),
    ...(typeof answer.scope === 'string' && { scope: answer.scope }),
    ...(typeof answer.id_token === 'string' && { idToken: answer.id_token }),
    obtainedAt: now,
  };
}

const withScope = (config: OAuth2Config): Record<string, string> => (config.scope ? { scope: config.scope } : {});

/** Client credentials grant (RFC 6749 §4.4). */
export function fetchClientCredentialsToken(config: OAuth2Config, options: OAuth2RequestOptions = {}) {
  return requestToken(config, { grant_type: 'client_credentials', ...withScope(config) }, options);
}

/** Resource owner password grant (RFC 6749 §4.3), for APIs that still use it. */
export function fetchPasswordToken(config: OAuth2Config, options: OAuth2RequestOptions = {}) {
  return requestToken(
    config,
    { grant_type: 'password', username: config.username ?? '', password: config.password ?? '', ...withScope(config) },
    options,
  );
}

/** Swaps a refresh token for a new access token (RFC 6749 §6); keeps the refresh token if no new one comes. */
export async function refreshOAuth2Token(
  config: OAuth2Config,
  refreshToken: string,
  options: OAuth2RequestOptions = {},
): Promise<OAuth2Token> {
  const token = await requestToken(
    config,
    { grant_type: 'refresh_token', refresh_token: refreshToken, ...withScope(config) },
    options,
  );
  return token.refreshToken ? token : { ...token, refreshToken };
}

export interface BrowserAuthorizationOptions extends OAuth2RequestOptions {
  /** Opens the provider's page in the user's browser. */
  openBrowser: (url: string) => void | Promise<void>;
  /** How long to wait for the user to sign in; default 5 minutes. */
  timeoutMs?: number;
  /** Named on the page the browser lands on ("go back to …"). */
  productName?: string;
  signal?: AbortSignal;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function callbackPage(title: string, message: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head><body style="font-family:system-ui,sans-serif;margin:3em"><h1>${escape(title)}</h1><p>${escape(message)}</p></body></html>`;
}

/**
 * The authorization code grant (RFC 6749 §4.1, with PKCE unless turned off,
 * and RFC 8252's loopback redirect): listens on the redirect URI's port on
 * this machine, opens the provider's page in the browser, waits for it to
 * send the browser back with a code, and exchanges the code for a token.
 */
export async function authorizeInBrowser(
  config: OAuth2Config,
  options: BrowserAuthorizationOptions,
): Promise<OAuth2Token> {
  const redirect = new URL(config.redirectUri || 'http://127.0.0.1/callback');
  if (redirect.protocol !== 'http:' || !LOOPBACK_HOSTS.has(redirect.hostname)) {
    throw new Error('OAuth 2.0: the redirect URI must be http://127.0.0.1, http://localhost or http://[::1].');
  }
  const path = redirect.pathname || '/';
  const state = base64Url(randomBytes(16));
  const pkce = config.usePkce === false ? undefined : createPkce();
  const productName = options.productName ?? 'the app';

  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) =>
      reject(new Error(`OAuth 2.0: couldn't listen for the redirect on ${redirect.host}: ${describeError(error)}`)),
    );
    server.listen(Number(redirect.port) || 0, redirect.hostname.replace(/^\[|\]$/g, ''), resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://${redirect.hostname}:${port}${path}`;

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('OAuth 2.0: no sign-in arrived in time; try again.')),
        options.timeoutMs ?? 5 * 60_000,
      );
      const abort = () => reject(new Error('OAuth 2.0: sign-in was cancelled.'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== path) {
          res.writeHead(404).end();
          return;
        }
        const answer = (status: number, title: string, message: string) => {
          res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
          res.end(callbackPage(title, message));
        };
        if (url.searchParams.get('state') !== state) {
          answer(400, 'Sign-in not recognised', `This sign-in wasn't started by ${productName}.`);
          return;
        }
        done();
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        if (error || !code) {
          const description = url.searchParams.get('error_description');
          answer(400, 'Sign-in failed', `${description ?? error ?? 'No code came back.'} You can close this tab.`);
          reject(
            new Error(`OAuth 2.0: sign-in failed (${error ?? 'no code'}${description ? `: ${description}` : ''}).`),
          );
          return;
        }
        answer(200, 'Signed in', `You can close this tab and go back to ${productName}.`);
        resolve(code);
      });
      Promise.resolve(
        options.openBrowser(
          buildAuthorizationUrl(config, { redirectUri, state, ...(pkce && { codeChallenge: pkce.challenge }) }),
        ),
      ).catch((error: unknown) => {
        done();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return await requestToken(
      config,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        ...(pkce && { code_verifier: pkce.verifier }),
      },
      options,
    );
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

export interface GetOAuth2TokenOptions extends OAuth2RequestOptions {
  store: OAuth2TokenStore;
  /** For the authorization code grant; without it, a request with no valid token fails and says to sign in. */
  openBrowser?: (url: string) => void | Promise<void>;
  productName?: string;
  /** Get a new token even if the stored one is valid ("Get new access token"). */
  forceNew?: boolean;
}

/**
 * A token to send for `config`: the stored one while it's valid, else one
 * got with its refresh token, else a new one from the grant (which, for
 * authorization code, means signing in in the browser). A new token is
 * stored. `obtained` says whether it's new.
 */
export async function getOAuth2Token(
  config: OAuth2Config,
  options: GetOAuth2TokenOptions,
): Promise<{ token: OAuth2Token; obtained: boolean }> {
  const now = options.now ?? Date.now();
  const key = oauth2TokenKey(config);
  const stored = options.store.get(key);
  if (!options.forceNew && isOAuth2TokenValid(stored, now)) return { token: stored!, obtained: false };

  let token: OAuth2Token | undefined;
  if (!options.forceNew && stored?.refreshToken) {
    try {
      token = await refreshOAuth2Token(config, stored.refreshToken, options);
    } catch {
      // A refresh token that's expired or revoked: get a new token instead.
      options.store.delete(key);
    }
  }
  if (!token) {
    if (config.grantType === 'client_credentials') token = await fetchClientCredentialsToken(config, options);
    else if (config.grantType === 'password') token = await fetchPasswordToken(config, options);
    else if (options.openBrowser) {
      token = await authorizeInBrowser(config, {
        ...options,
        openBrowser: options.openBrowser,
        productName: options.productName,
      });
    } else {
      throw new Error('OAuth 2.0: no access token yet. Sign in first (get a new access token).');
    }
  }
  options.store.set(key, token);
  return { token, obtained: true };
}
