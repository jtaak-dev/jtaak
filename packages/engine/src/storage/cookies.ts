import type Database from 'better-sqlite3';
import { CookieJar, type CookieKey, type StoredCookie } from '../request/cookieJar.js';

interface CookieRow {
  domain: string;
  path: string;
  name: string;
  value: string;
  host_only: number;
  expires_at: number | null;
  secure: number;
  http_only: number;
  same_site: string | null;
  created_at: number;
}

function toCookie(row: CookieRow): StoredCookie {
  return {
    name: row.name,
    value: row.value,
    domain: row.domain,
    hostOnly: row.host_only === 1,
    path: row.path,
    ...(row.expires_at !== null && { expiresAt: row.expires_at }),
    secure: row.secure === 1,
    httpOnly: row.http_only === 1,
    ...(row.same_site !== null && { sameSite: row.same_site as StoredCookie['sameSite'] }),
    createdAt: row.created_at,
  };
}

const INSERT = `INSERT OR REPLACE INTO cookies
  (workspace_id, domain, path, name, value, host_only, expires_at, secure, http_only, same_site, created_at)
  VALUES (@workspaceId, @domain, @path, @name, @value, @hostOnly, @expiresAt, @secure, @httpOnly, @sameSite, @createdAt)`;

function insertParams(workspaceId: string, cookie: StoredCookie) {
  return {
    workspaceId,
    domain: cookie.domain.replace(/^\./, '').toLowerCase(),
    path: cookie.path || '/',
    name: cookie.name,
    value: cookie.value,
    hostOnly: cookie.hostOnly ? 1 : 0,
    expiresAt: cookie.expiresAt ?? null,
    secure: cookie.secure ? 1 : 0,
    httpOnly: cookie.httpOnly ? 1 : 0,
    sameSite: cookie.sameSite ?? null,
    createdAt: cookie.createdAt,
  };
}

/** A workspace's cookies that haven't expired, by domain, then path, then name. */
export function listCookies(db: Database.Database, workspaceId: string, now = Date.now()): StoredCookie[] {
  const rows = db
    .prepare(
      `SELECT * FROM cookies WHERE workspace_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY domain, path, name`,
    )
    .all(workspaceId, now) as CookieRow[];
  return rows.map(toCookie);
}

/** Adds a cookie to a workspace, or replaces the one with its domain, path and name. */
export function saveCookie(db: Database.Database, workspaceId: string, cookie: StoredCookie): void {
  db.prepare(INSERT).run(insertParams(workspaceId, cookie));
}

/** Deletes one cookie; says whether it was there. */
export function deleteCookie(db: Database.Database, workspaceId: string, key: CookieKey): boolean {
  return (
    db
      .prepare('DELETE FROM cookies WHERE workspace_id = ? AND domain = ? AND path = ? AND name = ?')
      .run(workspaceId, key.domain, key.path, key.name).changes > 0
  );
}

/** Deletes a workspace's cookies, or only one domain's; returns how many went. */
export function clearCookies(db: Database.Database, workspaceId: string, domain?: string): number {
  return domain === undefined
    ? db.prepare('DELETE FROM cookies WHERE workspace_id = ?').run(workspaceId).changes
    : db.prepare('DELETE FROM cookies WHERE workspace_id = ? AND domain = ?').run(workspaceId, domain).changes;
}

/** A jar with a workspace's cookies, for a send or a run; `saveCookieJar` keeps what it changed. */
export function loadCookieJar(db: Database.Database, workspaceId: string, now = Date.now()): CookieJar {
  return new CookieJar(listCookies(db, workspaceId, now));
}

/**
 * Writes what a jar changed since it was loaded (or last saved) to the
 * workspace's cookies, in one transaction: cookies it set replace the stored
 * ones, cookies it deleted go. Cookies it didn't touch stay as stored, so a
 * cookie another send set meanwhile isn't lost.
 */
export function saveCookieJar(db: Database.Database, workspaceId: string, jar: CookieJar): void {
  if (!jar.changed) return;
  const { saved, deleted } = jar.takeChanges();
  const insert = db.prepare(INSERT);
  db.transaction(() => {
    for (const key of deleted) deleteCookie(db, workspaceId, key);
    for (const cookie of saved) insert.run(insertParams(workspaceId, cookie));
  })();
}
