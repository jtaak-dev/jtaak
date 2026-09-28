import { describe, expect, it } from 'vitest';
import { openDatabase } from './db';
import { getOrCreateDefaultWorkspace } from './repository';
import { clearCookies, deleteCookie, listCookies, loadCookieJar, saveCookie, saveCookieJar } from './cookies';
import type { StoredCookie } from '../request/cookieJar';

const NOW = Date.UTC(2026, 8, 28);

describe('cookie storage', () => {
  it("keeps a workspace's jar: what a send set, changed or deleted, and nothing else", () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const first = loadCookieJar(db, workspace.id, NOW);
    first.store('https://example.com/app/login', ['session=s1; HttpOnly; Secure', 'theme=dark; Max-Age=60'], NOW);
    // A second send that started before the first was saved keeps the first's cookies.
    const second = loadCookieJar(db, workspace.id, NOW);
    second.store('https://other.com/', ['id=7'], NOW);
    saveCookieJar(db, workspace.id, first);
    saveCookieJar(db, workspace.id, second);

    expect(listCookies(db, workspace.id, NOW)).toEqual([
      {
        name: 'session',
        value: 's1',
        domain: 'example.com',
        hostOnly: true,
        path: '/app',
        secure: true,
        httpOnly: true,
        createdAt: NOW,
      },
      {
        name: 'theme',
        value: 'dark',
        domain: 'example.com',
        hostOnly: true,
        path: '/app',
        expiresAt: NOW + 60_000,
        secure: false,
        httpOnly: false,
        createdAt: NOW,
      },
      {
        name: 'id',
        value: '7',
        domain: 'other.com',
        hostOnly: true,
        path: '/',
        secure: false,
        httpOnly: false,
        createdAt: NOW,
      },
    ]);
    // Expired cookies aren't listed or loaded.
    expect(listCookies(db, workspace.id, NOW + 61_000).map((c) => c.name)).toEqual(['session', 'id']);

    const jar = loadCookieJar(db, workspace.id, NOW);
    jar.store('https://example.com/app/', ['session=; Max-Age=0'], NOW);
    saveCookieJar(db, workspace.id, jar);
    expect(listCookies(db, workspace.id, NOW).map((c) => c.name)).toEqual(['theme', 'id']);
  });

  it('edits and deletes cookies by hand', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const cookie: StoredCookie = {
      name: 'a',
      value: '1',
      domain: 'x.com',
      hostOnly: false,
      path: '/',
      secure: false,
      httpOnly: false,
      createdAt: NOW,
    };
    saveCookie(db, workspace.id, cookie);
    saveCookie(db, workspace.id, { ...cookie, value: '2' });
    saveCookie(db, workspace.id, { ...cookie, domain: 'y.com' });
    expect(listCookies(db, workspace.id).map((c) => `${c.domain} ${c.value}`)).toEqual(['x.com 2', 'y.com 1']);
    expect(deleteCookie(db, workspace.id, { domain: 'x.com', path: '/', name: 'a' })).toBe(true);
    expect(deleteCookie(db, workspace.id, { domain: 'x.com', path: '/', name: 'a' })).toBe(false);
    saveCookie(db, workspace.id, cookie);
    expect(clearCookies(db, workspace.id, 'y.com')).toBe(1);
    expect(clearCookies(db, workspace.id)).toBe(1);
    expect(listCookies(db, workspace.id)).toEqual([]);
  });
});
