import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  authorizeInBrowser,
  buildAuthorizationUrl,
  createPkce,
  getOAuth2Token,
  isOAuth2TokenValid,
  MemoryOAuth2TokenStore,
  oauth2TokenKey,
} from './oauth2';
import { runRequestWithScripts } from '../scripting/runRequest';
import { emptyScopes } from '../types';
import type { OAuth2Config, RequestConfig } from '../types';

// A fake provider: an authorization page that sends the browser straight
// back with a code, a token endpoint for every grant, and an API that echoes
// the Authorization header it got.
let server: http.Server;
let base: string;
let tokenRequests: Array<{ params: URLSearchParams; authorization?: string }> = [];
let issued = 0;
let pendingChallenge: string | undefined;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/authorize') {
      pendingChallenge = url.searchParams.get('code_challenge') ?? undefined;
      const back = new URL(url.searchParams.get('redirect_uri')!);
      if (url.searchParams.get('scope') === 'deny') back.searchParams.set('error', 'access_denied');
      else back.searchParams.set('code', 'the-code');
      back.searchParams.set('state', url.searchParams.get('state')!);
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const params = new URLSearchParams(body);
        tokenRequests.push({ params, authorization: req.headers.authorization });
        const grant = params.get('grant_type');
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        if (grant === 'authorization_code') {
          const verifier = params.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (params.get('code') !== 'the-code' || challenge !== pendingChallenge) {
            return json(400, { error: 'invalid_grant', error_description: 'bad code or verifier' });
          }
        }
        if (grant === 'refresh_token' && params.get('refresh_token') !== 'refresh-1') {
          return json(400, { error: 'invalid_grant' });
        }
        if (grant === 'password' && params.get('password') !== 'pw') return json(400, { error: 'invalid_grant' });
        issued++;
        json(200, {
          access_token: `token-${issued}`,
          token_type: 'Bearer',
          expires_in: 3600,
          ...(grant !== 'client_credentials' && grant !== 'refresh_token' && { refresh_token: 'refresh-1' }),
          scope: params.get('scope') ?? undefined,
        });
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authorization: req.headers.authorization ?? null, url: req.url }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  tokenRequests = [];
});

const config = (overrides: Partial<OAuth2Config> = {}): OAuth2Config => ({
  grantType: 'client_credentials',
  tokenUrl: `${base}/token`,
  clientId: 'app',
  clientSecret: 'shh',
  scope: 'read write',
  ...overrides,
});

/** Stands in for the browser: loads the page and follows its redirect to the loopback server. */
const browser = async (url: string) => {
  await fetch(url);
};

describe('OAuth 2.0 grants', () => {
  it('gets a client credentials token, with the client in a Basic header by default', async () => {
    const { token, obtained } = await getOAuth2Token(config(), { store: new MemoryOAuth2TokenStore() });
    expect(obtained).toBe(true);
    expect(token).toMatchObject({
      accessToken: expect.stringMatching(/^token-/),
      tokenType: 'Bearer',
      scope: 'read write',
    });
    expect(token.expiresAt! - token.obtainedAt).toBe(3_600_000);
    const [sent] = tokenRequests;
    expect(sent.authorization).toBe(`Basic ${Buffer.from('app:shh').toString('base64')}`);
    expect(Object.fromEntries(sent.params)).toEqual({ grant_type: 'client_credentials', scope: 'read write' });
  });

  it('puts the client in the body when asked, and always for a public client', async () => {
    await getOAuth2Token(config({ clientAuth: 'body' }), { store: new MemoryOAuth2TokenStore() });
    await getOAuth2Token(config({ clientSecret: undefined }), { store: new MemoryOAuth2TokenStore() });
    expect(
      tokenRequests.map((r) => [r.authorization, r.params.get('client_id'), r.params.get('client_secret')]),
    ).toEqual([
      [undefined, 'app', 'shh'],
      [undefined, 'app', null],
    ]);
  });

  it('gets a password grant token, and says why a token URL refused', async () => {
    const good = config({ grantType: 'password', username: 'ann', password: 'pw' });
    await expect(getOAuth2Token(good, { store: new MemoryOAuth2TokenStore() })).resolves.toBeTruthy();
    await expect(
      getOAuth2Token({ ...good, password: 'nope' }, { store: new MemoryOAuth2TokenStore() }),
    ).rejects.toThrow('OAuth 2.0: the token URL refused the request (invalid_grant).');
  });

  it('signs in in the browser with PKCE, through a loopback redirect', async () => {
    const code = config({ grantType: 'authorization_code', authUrl: `${base}/authorize` });
    const token = await authorizeInBrowser(code, { openBrowser: browser });
    expect(token.refreshToken).toBe('refresh-1');
    const exchange = tokenRequests[0].params;
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(exchange.get('code_verifier')).toBeTruthy();
  });

  it('reports a sign-in the provider refused', async () => {
    const denied = config({ grantType: 'authorization_code', authUrl: `${base}/authorize`, scope: 'deny' });
    await expect(authorizeInBrowser(denied, { openBrowser: browser })).rejects.toThrow(
      'sign-in failed (access_denied)',
    );
  });

  it('refuses a redirect URI that is not on this machine', async () => {
    const remote = config({
      grantType: 'authorization_code',
      authUrl: `${base}/authorize`,
      redirectUri: 'https://example.com/cb',
    });
    await expect(authorizeInBrowser(remote, { openBrowser: browser })).rejects.toThrow('redirect URI must be');
  });
});

describe('getOAuth2Token and the store', () => {
  it('reuses a valid token, refreshes an expired one, and gets a new one when asked', async () => {
    const store = new MemoryOAuth2TokenStore();
    const code = config({ grantType: 'authorization_code', authUrl: `${base}/authorize` });
    const first = await getOAuth2Token(code, { store, openBrowser: browser });
    expect(first.obtained).toBe(true);
    expect((await getOAuth2Token(code, { store })).token.accessToken).toBe(first.token.accessToken);

    // An hour later: the refresh token gets a new one, and is kept.
    const later = await getOAuth2Token(code, { store, now: Date.now() + 3_600_000 });
    expect(later.token.accessToken).not.toBe(first.token.accessToken);
    expect(later.token.refreshToken).toBe('refresh-1');
    expect(tokenRequests.at(-1)!.params.get('grant_type')).toBe('refresh_token');

    const forced = await getOAuth2Token(code, { store, openBrowser: browser, forceNew: true });
    expect(tokenRequests.at(-1)!.params.get('grant_type')).toBe('authorization_code');
    expect(store.get(oauth2TokenKey(code))).toEqual(forced.token);
  });

  it('asks to sign in when an authorization code grant has no token and no browser', async () => {
    const code = config({ grantType: 'authorization_code', authUrl: `${base}/authorize` });
    await expect(getOAuth2Token(code, { store: new MemoryOAuth2TokenStore() })).rejects.toThrow('Sign in first');
  });

  it('keys tokens by client and provider, not by secret', () => {
    expect(oauth2TokenKey(config())).toBe(oauth2TokenKey(config({ clientSecret: 'rotated' })));
    expect(oauth2TokenKey(config())).not.toBe(oauth2TokenKey(config({ scope: 'read' })));
  });

  it('counts a token as expired a little early', () => {
    const now = 1_000_000;
    expect(isOAuth2TokenValid({ accessToken: 'a', obtainedAt: 0 }, now)).toBe(true);
    expect(isOAuth2TokenValid({ accessToken: 'a', expiresAt: now + 60_000, obtainedAt: 0 }, now)).toBe(true);
    expect(isOAuth2TokenValid({ accessToken: 'a', expiresAt: now + 10_000, obtainedAt: 0 }, now)).toBe(false);
  });
});

describe('PKCE and the authorization URL', () => {
  it('makes an S256 challenge from a random verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('builds the authorization URL', () => {
    const url = new URL(
      buildAuthorizationUrl(
        config({ grantType: 'authorization_code', authUrl: 'https://id.example.com/auth?tenant=1', audience: 'api' }),
        {
          redirectUri: 'http://127.0.0.1:5000/callback',
          state: 's',
          codeChallenge: 'c',
        },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: '1',
      response_type: 'code',
      client_id: 'app',
      redirect_uri: 'http://127.0.0.1:5000/callback',
      state: 's',
      scope: 'read write',
      audience: 'api',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
  });
});

describe('runRequestWithScripts with OAuth 2.0', () => {
  const request = (oauth2: Partial<OAuth2Config> = {}): RequestConfig => ({
    id: 'r',
    name: 'r',
    method: 'GET',
    url: `${base}/api`,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'oauth2', oauth2: config({ clientSecret: '{{secret}}', ...oauth2 }) },
  });
  const scopes = { ...emptyScopes(), environment: { secret: 'shh' } };

  it('gets a token (with its settings’ variables resolved), sends it, and keeps it for the next send', async () => {
    const oauth2Tokens = new MemoryOAuth2TokenStore();
    const first = await runRequestWithScripts(request(), scopes, undefined, { oauth2Tokens });
    const sent = JSON.parse(first.response!.body).authorization as string;
    expect(sent).toMatch(/^Bearer token-\d+$/);
    expect(tokenRequests[0].authorization).toBe(`Basic ${Buffer.from('app:shh').toString('base64')}`);
    const second = await runRequestWithScripts(request(), scopes, undefined, { oauth2Tokens });
    expect(JSON.parse(second.response!.body).authorization).toBe(sent);
    expect(tokenRequests).toHaveLength(1);
  });

  it('sends the token in the query, or with another prefix, when set', async () => {
    const query = await runRequestWithScripts(request({ addTo: 'query' }), scopes);
    expect(JSON.parse(query.response!.body)).toMatchObject({
      authorization: null,
      url: expect.stringMatching(/access_token=token-/),
    });
    const prefixed = await runRequestWithScripts(request({ headerPrefix: 'Token' }), scopes);
    expect(JSON.parse(prefixed.response!.body).authorization).toMatch(/^Token token-/);
  });

  it('reports a token failure as a send error', async () => {
    const result = await runRequestWithScripts(request({ grantType: 'password', password: 'nope' }), scopes);
    expect(result.response).toBeUndefined();
    expect(result.sendError).toContain('OAuth 2.0: the token URL refused the request');
  });
});
