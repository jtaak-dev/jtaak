/**
 * A cookie as a `Set-Cookie` response header describes it (RFC 6265 §5.2).
 * Browser-safe: no Node built-ins, so a UI can parse the headers a response
 * carries (`ExecutedResponse.setCookies`) itself.
 */
export interface SetCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** From `Expires`, as given. */
  expires?: string;
  /** From `Max-Age`, in seconds. */
  maxAge?: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Parses one `Set-Cookie` header, or returns undefined when it has no name=value pair. */
export function parseSetCookie(header: string): SetCookie | undefined {
  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq <= 0) return undefined;
  const cookie: SetCookie = {
    name: pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
    secure: false,
    httpOnly: false,
  };
  if (!cookie.name) return undefined;
  for (const attribute of attributes) {
    const at = attribute.indexOf('=');
    const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at === -1 ? '' : attribute.slice(at + 1).trim();
    if (key === 'domain' && value) cookie.domain = value.replace(/^\./, '').toLowerCase();
    else if (key === 'path' && value.startsWith('/')) cookie.path = value;
    else if (key === 'expires' && value) cookie.expires = value;
    else if (key === 'max-age' && /^-?\d+$/.test(value)) cookie.maxAge = Number(value);
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') {
      const same = value.toLowerCase();
      if (same === 'strict') cookie.sameSite = 'Strict';
      else if (same === 'lax') cookie.sameSite = 'Lax';
      else if (same === 'none') cookie.sameSite = 'None';
    }
  }
  return cookie;
}
