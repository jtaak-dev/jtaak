import { parseSetCookie } from './cookies.js';

/** A cookie as a jar keeps it (RFC 6265 §5.3). */
export interface StoredCookie {
  name: string;
  value: string;
  /** Lower case, without a leading dot. */
  domain: string;
  /** Sent only to `domain` itself, not its subdomains (the cookie had no `Domain` attribute). */
  hostOnly: boolean;
  path: string;
  /** When it expires, in milliseconds since the epoch; absent for a cookie with no expiry, which a jar keeps until it's deleted. */
  expiresAt?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  createdAt: number;
}

/** What identifies a cookie in a jar: a later cookie with the same three replaces it. */
export interface CookieKey {
  domain: string;
  path: string;
  name: string;
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/** Whether cookies marked Secure may be set and sent: HTTPS, or the local machine (as browsers treat it). */
function isSecureOrigin(url: URL): boolean {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const host = url.hostname;
  return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';
}

/** RFC 6265 §5.1.3. */
export function domainMatches(host: string, domain: string): boolean {
  return host === domain || (host.endsWith(`.${domain}`) && !isIpAddress(host));
}

/** RFC 6265 §5.1.4: the directory of the request's path. */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

/** RFC 6265 §5.1.4. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

const sameKey = (a: CookieKey, b: CookieKey) => a.domain === b.domain && a.path === b.path && a.name === b.name;

/**
 * Cookies kept between requests, following RFC 6265: what responses set is
 * stored for its domain and path, and sent with later requests those match.
 * Secure cookies go only over HTTPS (or to the local machine). A jar has no
 * public-suffix list, so a response may set a cookie for any domain its host
 * is under except a bare top-level one (`Domain=com`).
 *
 * In memory; `storage/cookies.ts` loads a workspace's jar from SQLite and
 * saves what changed back (`takeChanges`), so two sends at once don't undo
 * each other's cookies.
 */
export class CookieJar {
  private cookies: StoredCookie[];
  /** What changed since the last `takeChanges`, by key: the cookie as it is now, or null for deleted. */
  private dirty = new Map<string, { key: CookieKey; cookie: StoredCookie | null }>();

  constructor(cookies: StoredCookie[] = []) {
    this.cookies = cookies.map((cookie) => ({ ...cookie }));
  }

  /** Whether anything changed since the last `takeChanges`. */
  get changed(): boolean {
    return this.dirty.size > 0;
  }

  /** The cookies set and deleted since the last call, and forgets them. */
  takeChanges(): { saved: StoredCookie[]; deleted: CookieKey[] } {
    const saved: StoredCookie[] = [];
    const deleted: CookieKey[] = [];
    for (const { key, cookie } of this.dirty.values()) {
      if (cookie) saved.push({ ...cookie });
      else deleted.push(key);
    }
    this.dirty.clear();
    return { saved, deleted };
  }

  private mark(key: CookieKey, cookie: StoredCookie | null): void {
    const { domain, path, name } = key;
    this.dirty.set(JSON.stringify([domain, path, name]), { key: { domain, path, name }, cookie });
  }

  /** Every cookie that hasn't expired, by domain, then path, then name. */
  list(now = Date.now()): StoredCookie[] {
    return this.cookies
      .filter((cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now)
      .map((cookie) => ({ ...cookie }))
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
  }

  /** Stores the cookies a response from `requestUrl` set (its `Set-Cookie` headers). */
  store(requestUrl: string, setCookieHeaders: readonly string[], now = Date.now()): void {
    if (setCookieHeaders.length === 0) return;
    const url = new URL(requestUrl);
    const host = url.hostname.toLowerCase();
    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header);
      if (!parsed) continue;
      let domain = host;
      let hostOnly = true;
      if (parsed.domain && parsed.domain !== host) {
        // A cookie for a domain the host isn't under, for an IP address's
        // "parent", or for a whole top-level domain is refused.
        if (isIpAddress(host) || !domainMatches(host, parsed.domain) || !parsed.domain.includes('.')) continue;
        domain = parsed.domain;
        hostOnly = false;
      } else if (parsed.domain) {
        hostOnly = false;
      }
      if (parsed.secure && !isSecureOrigin(url)) continue;

      let expiresAt: number | undefined;
      if (parsed.maxAge !== undefined) expiresAt = parsed.maxAge <= 0 ? 0 : now + parsed.maxAge * 1000;
      else if (parsed.expires !== undefined) {
        const at = Date.parse(parsed.expires);
        if (!Number.isNaN(at)) expiresAt = at;
      }

      const cookie: StoredCookie = {
        name: parsed.name,
        value: parsed.value,
        domain,
        hostOnly,
        path: parsed.path ?? defaultPath(url.pathname),
        ...(expiresAt !== undefined && { expiresAt }),
        secure: parsed.secure,
        httpOnly: parsed.httpOnly,
        ...(parsed.sameSite && { sameSite: parsed.sameSite }),
        createdAt: now,
      };
      const at = this.cookies.findIndex((existing) => sameKey(existing, cookie));
      // An expiry in the past deletes the cookie.
      if (expiresAt !== undefined && expiresAt <= now) {
        if (at !== -1) {
          this.cookies.splice(at, 1);
          this.mark(cookie, null);
        }
        continue;
      }
      if (at !== -1) {
        // A replaced cookie keeps its creation time, which orders cookies sent together.
        cookie.createdAt = this.cookies[at].createdAt;
        this.cookies[at] = cookie;
      } else {
        this.cookies.push(cookie);
      }
      this.mark(cookie, cookie);
    }
  }

  /** The cookies a request to `requestUrl` sends, in the order they're sent: longer paths first, then older first. */
  cookiesFor(requestUrl: string, now = Date.now()): StoredCookie[] {
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return [];
    }
    const host = url.hostname.toLowerCase();
    const secure = isSecureOrigin(url);
    return this.cookies
      .filter(
        (cookie) =>
          (cookie.expiresAt === undefined || cookie.expiresAt > now) &&
          (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
          pathMatches(url.pathname || '/', cookie.path) &&
          (!cookie.secure || secure),
      )
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
      .map((cookie) => ({ ...cookie }));
  }

  /** The `Cookie` header for a request to `requestUrl`, or undefined when no cookie matches. */
  cookieHeader(requestUrl: string, now = Date.now()): string | undefined {
    const cookies = this.cookiesFor(requestUrl, now);
    return cookies.length > 0 ? cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') : undefined;
  }

  /** Adds a cookie, or replaces the one with its domain, path and name (editing a cookie by hand). */
  set(cookie: StoredCookie): void {
    const stored = { ...cookie, domain: cookie.domain.replace(/^\./, '').toLowerCase() };
    const at = this.cookies.findIndex((existing) => sameKey(existing, stored));
    if (at !== -1) this.cookies[at] = stored;
    else this.cookies.push(stored);
    this.mark(stored, stored);
  }

  /** Deletes one cookie; says whether it was there. */
  delete(key: CookieKey): boolean {
    const at = this.cookies.findIndex((existing) => sameKey(existing, key));
    if (at === -1) return false;
    const [removed] = this.cookies.splice(at, 1);
    this.mark(removed, null);
    return true;
  }

  /** Deletes every cookie, or only those of one domain. */
  clear(domain?: string): void {
    const kept: StoredCookie[] = [];
    for (const cookie of this.cookies) {
      if (domain === undefined || cookie.domain === domain) this.mark(cookie, null);
      else kept.push(cookie);
    }
    this.cookies = kept;
  }
}
