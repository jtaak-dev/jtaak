import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { CookieJar, defaultPath, domainMatches, pathMatches } from './cookieJar';
import { executeRequest } from './executor';
import type { RequestConfig } from '../types';

const NOW = Date.UTC(2026, 8, 28);

describe('matching (RFC 6265 §5.1)', () => {
  it('matches a domain and its subdomains, never an IP address as a subdomain', () => {
    expect(domainMatches('example.com', 'example.com')).toBe(true);
    expect(domainMatches('api.example.com', 'example.com')).toBe(true);
    expect(domainMatches('badexample.com', 'example.com')).toBe(false);
    expect(domainMatches('1.2.3.4', '2.3.4')).toBe(false);
  });

  it('matches a path and what is under it, at a slash', () => {
    expect(pathMatches('/app', '/app')).toBe(true);
    expect(pathMatches('/app/users', '/app')).toBe(true);
    expect(pathMatches('/app/users', '/app/')).toBe(true);
    expect(pathMatches('/application', '/app')).toBe(false);
  });

  it("defaults the path to the request path's directory", () => {
    expect(defaultPath('/a/b/c')).toBe('/a/b');
    expect(defaultPath('/a')).toBe('/');
    expect(defaultPath('')).toBe('/');
  });
});

describe('CookieJar', () => {
  it('stores a cookie for the host only, unless it names a domain', () => {
    const jar = new CookieJar();
    jar.store('https://api.example.com/login', ['host=1', 'wide=2; Domain=example.com'], NOW);
    expect(jar.cookieHeader('https://api.example.com/', NOW)).toBe('host=1; wide=2');
    expect(jar.cookieHeader('https://www.example.com/', NOW)).toBe('wide=2');
    expect(jar.cookieHeader('https://example.org/', NOW)).toBeUndefined();
  });

  it('refuses a domain the host is not under, and a top-level one', () => {
    const jar = new CookieJar();
    jar.store('https://api.example.com/', ['a=1; Domain=other.com', 'b=2; Domain=com'], NOW);
    jar.store('http://127.0.0.1/', ['c=3; Domain=0.0.1'], NOW);
    expect(jar.list(NOW)).toEqual([]);
  });

  it("sends a path's cookies under it, longest path first", () => {
    const jar = new CookieJar();
    jar.store('http://localhost/', ['root=1; Path=/'], NOW);
    jar.store('http://localhost/', ['app=2; Path=/app'], NOW + 1);
    expect(jar.cookieHeader('http://localhost/app/users', NOW)).toBe('app=2; root=1');
    expect(jar.cookieHeader('http://localhost/other', NOW)).toBe('root=1');
  });

  it('keeps Secure cookies to HTTPS and the local machine', () => {
    const jar = new CookieJar();
    jar.store('http://example.com/', ['refused=1; Secure'], NOW);
    jar.store('https://example.com/', ['kept=1; Secure'], NOW);
    jar.store('http://localhost/', ['local=1; Secure'], NOW);
    expect(jar.cookieHeader('https://example.com/', NOW)).toBe('kept=1');
    expect(jar.cookieHeader('http://example.com/', NOW)).toBeUndefined();
    expect(jar.cookieHeader('http://localhost/', NOW)).toBe('local=1');
  });

  it('expires cookies, Max-Age winning over Expires, and deletes one given a past expiry', () => {
    const jar = new CookieJar();
    jar.store(
      'http://localhost/',
      ['short=1; Max-Age=60; Expires=Wed, 21 Oct 2099 07:28:00 GMT', 'dated=2; Expires=Wed, 21 Oct 2099 07:28:00 GMT'],
      NOW,
    );
    expect(jar.list(NOW).map((c) => [c.name, c.expiresAt])).toEqual([
      ['dated', Date.UTC(2099, 9, 21, 7, 28)],
      ['short', NOW + 60_000],
    ]);
    expect(jar.cookieHeader('http://localhost/', NOW + 61_000)).toBe('dated=2');
    jar.store('http://localhost/', ['dated=; Max-Age=0'], NOW);
    expect(jar.list(NOW).map((c) => c.name)).toEqual(['short']);
  });

  it('replaces a cookie with the same name, domain and path, keeping when it was first set', () => {
    const jar = new CookieJar();
    jar.store('http://localhost/', ['a=1'], NOW);
    jar.store('http://localhost/', ['a=2; HttpOnly'], NOW + 5);
    expect(jar.list(NOW)).toEqual([
      {
        name: 'a',
        value: '2',
        domain: 'localhost',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: true,
        createdAt: NOW,
      },
    ]);
  });

  it('reports what changed, for saving, and edits by hand', () => {
    const jar = new CookieJar();
    jar.store('http://localhost/', ['a=1', 'b=2'], NOW);
    jar.delete({ domain: 'localhost', path: '/', name: 'b' });
    expect(jar.changed).toBe(true);
    const { saved, deleted } = jar.takeChanges();
    expect(saved.map((c) => c.name)).toEqual(['a']);
    expect(deleted).toEqual([{ domain: 'localhost', path: '/', name: 'b' }]);
    expect(jar.changed).toBe(false);

    jar.set({
      name: 'c',
      value: '3',
      domain: '.Example.com',
      hostOnly: false,
      path: '/',
      secure: false,
      httpOnly: false,
      createdAt: NOW,
    });
    expect(jar.cookieHeader('http://www.example.com/', NOW)).toBe('c=3');
    jar.takeChanges();
    jar.clear('localhost');
    expect(jar.list(NOW).map((c) => c.name)).toEqual(['c']);
    expect(jar.takeChanges().deleted).toEqual([{ domain: 'localhost', path: '/', name: 'a' }]);
  });
});

describe('executeRequest with a cookie jar', () => {
  let server: http.Server;
  let base: string;
  const seen: Array<{ url: string; method: string; cookie?: string }> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url ?? '', method: req.method ?? '', cookie: req.headers.cookie });
      if (req.url === '/login') {
        // A login that sets the session on its redirect, as most do.
        res.writeHead(303, { Location: '/home', 'Set-Cookie': 'session=s1; Path=/; HttpOnly' });
        res.end();
      } else if (req.url === '/logout') {
        res.writeHead(200, { 'Set-Cookie': 'session=; Max-Age=0; Path=/' });
        res.end('bye');
      } else {
        res.end(`cookie: ${req.headers.cookie ?? ''}`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const request = (url: string, overrides: Partial<RequestConfig> = {}): RequestConfig => ({
    id: 'r',
    name: 'r',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  });

  it('keeps a cookie a redirect set, sends it on, and turns a POST into a GET after a 303', async () => {
    const jar = new CookieJar();
    seen.length = 0;
    const response = await executeRequest(
      request(`${base}/login`, { method: 'POST', body: { mode: 'raw', raw: 'user=a' } }),
      { cookieJar: jar },
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe('cookie: session=s1');
    expect(response.setCookies).toEqual(['session=s1; Path=/; HttpOnly']);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /login', 'GET /home']);

    const next = await executeRequest(request(`${base}/profile`), { cookieJar: jar });
    expect(next.body).toBe('cookie: session=s1');
  });

  it('merges with a Cookie header the request sets, which wins for a shared name', async () => {
    const jar = new CookieJar();
    jar.store(`${base}/`, ['session=jar', 'theme=dark']);
    const response = await executeRequest(
      request(`${base}/x`, { headers: [{ key: 'cookie', value: 'session=mine', enabled: true }] }),
      { cookieJar: jar },
    );
    expect(response.body).toBe('cookie: session=mine; theme=dark');
  });

  it('forgets a cookie the server clears, and leaves the jar alone with useCookies: false', async () => {
    const jar = new CookieJar();
    jar.store(`${base}/`, ['session=s1; Path=/']);
    await executeRequest(request(`${base}/logout`, { useCookies: false }), { cookieJar: jar });
    expect(jar.list().map((c) => c.name)).toEqual(['session']);
    const off = await executeRequest(request(`${base}/x`, { useCookies: false }), { cookieJar: jar });
    expect(off.body).toBe('cookie: ');
    await executeRequest(request(`${base}/logout`), { cookieJar: jar });
    expect(jar.list()).toEqual([]);
  });
});
