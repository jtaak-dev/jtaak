import { performance } from 'node:perf_hooks';
import type { ExecutedResponse, GraphQlProtocolConfig, KeyValue, RequestConfig } from '../types.js';
import type { CookieJar } from './cookieJar.js';
import { digestAuthorization, parseDigestChallenge } from './digest.js';
import { soapAsHttp } from './soap.js';
import { withErrorDetail } from './errors.js';
import { fileBody, fileNameOf } from './files.js';
import { timingPhases, withTiming } from './timing.js';
import { fetchFor } from './tls.js';

function toHeaderRecord(headers: KeyValue[]): Record<string, string> {
  return headers
    .filter((h) => h.enabled && h.key.trim().length > 0)
    .reduce<Record<string, string>>((acc, h) => {
      acc[h.key] = h.value;
      return acc;
    }, {});
}

export function buildUrl(config: RequestConfig): string {
  const url = new URL(config.url);
  for (const param of config.params) {
    if (param.enabled && param.key.trim().length > 0) {
      url.searchParams.append(param.key, param.value);
    }
  }
  if (config.auth.type === 'apiKey' && config.auth.apiKey?.addTo === 'query') {
    url.searchParams.append(config.auth.apiKey.key, config.auth.apiKey.value);
  }
  const oauth2 = config.auth.type === 'oauth2' ? config.auth.oauth2 : undefined;
  if (oauth2?.addTo === 'query' && oauth2.token?.accessToken) {
    url.searchParams.append('access_token', oauth2.token.accessToken);
  }
  return url.toString();
}

/** A request's body as `fetch` sends it (files are read now). */
export async function buildBody(config: RequestConfig): Promise<BodyInit | undefined> {
  switch (config.body.mode) {
    case 'none':
      return undefined;
    case 'raw':
    case 'json':
      return config.body.raw ?? '';
    case 'urlencoded': {
      const params = new URLSearchParams();
      for (const field of config.body.formData ?? []) {
        if (field.enabled && field.type !== 'file') params.append(field.key, field.value);
      }
      return params.toString();
    }
    case 'form-data': {
      const form = new FormData();
      for (const field of config.body.formData ?? []) {
        if (!field.enabled) continue;
        if (field.type !== 'file') form.append(field.key, field.value);
        else if (field.src) form.append(field.key, await fileBody(field.src), fileNameOf(field.src));
      }
      return form;
    }
    case 'binary':
      // Its Content-Type comes from the file's extension unless a header sets one.
      return config.body.binaryPath ? fileBody(config.body.binaryPath) : undefined;
    default:
      return undefined;
  }
}

// GraphQL always rides a POST with a JSON { query, variables, operationName }
// body, regardless of what config.method/config.body hold — those fields
// describe the http protocol's own request shape, not graphql's.
function buildGraphQlBody(config: RequestConfig): string {
  const graphql = config.protocolConfig as GraphQlProtocolConfig | undefined;
  return JSON.stringify({
    query: graphql?.query ?? '',
    variables: graphql?.variables ?? {},
    operationName: graphql?.operationName,
  });
}

export function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function applyAuthHeaders(config: RequestConfig, headers: Record<string, string>): void {
  if (config.auth.type === 'bearer' && config.auth.bearer?.token) {
    headers.Authorization = `Bearer ${config.auth.bearer.token}`;
  }
  if (config.auth.type === 'basic' && config.auth.basic) {
    const encoded = Buffer.from(`${config.auth.basic.username}:${config.auth.basic.password}`).toString('base64');
    headers.Authorization = `Basic ${encoded}`;
  }
  if (config.auth.type === 'apiKey' && config.auth.apiKey?.addTo === 'header') {
    headers[config.auth.apiKey.key] = config.auth.apiKey.value;
  }
  const oauth2 = config.auth.type === 'oauth2' ? config.auth.oauth2 : undefined;
  if (oauth2 && oauth2.addTo !== 'query' && oauth2.token?.accessToken) {
    const prefix = oauth2.headerPrefix ?? 'Bearer';
    headers.Authorization = prefix ? `${prefix} ${oauth2.token.accessToken}` : oauth2.token.accessToken;
  }
  // Digest's Authorization answers the server's challenge; executeRequest adds it.
}

/**
 * The headers a request would actually send — enabled custom headers plus
 * whatever `auth` contributes. Exposed separately from `executeRequest` so
 * other one-shot calls that hit the same endpoint (e.g. GraphQL schema
 * introspection) can reuse the exact same auth handling instead of
 * duplicating it.
 */
export function buildRequestHeaders(config: RequestConfig): Record<string, string> {
  const headers = toHeaderRecord(config.headers);
  applyAuthHeaders(config, headers);
  return headers;
}

export interface ExecuteOptions {
  /**
   * Cookies kept between requests: the jar's cookies for the URL are sent
   * (after any `Cookie` header the request sets itself, which wins for a
   * name both have), and what the response sets is stored. Redirects are
   * then followed here rather than by `fetch`, so cookies set along the way
   * are kept and sent to where they lead. Not used for a request with
   * `useCookies: false`.
   */
  cookieJar?: CookieJar;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

function withJarCookies(headers: Record<string, string>, jar: CookieJar, url: string): Record<string, string> {
  const fromJar = jar.cookiesFor(url);
  if (fromJar.length === 0) return headers;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'cookie');
  const own = key ? headers[key] : '';
  const ownNames = new Set(
    own
      .split(';')
      .map((pair) => pair.split('=')[0].trim())
      .filter(Boolean),
  );
  const added = fromJar.filter((cookie) => !ownNames.has(cookie.name)).map((c) => `${c.name}=${c.value}`);
  if (added.length === 0) return headers;
  const next = { ...headers };
  if (key) delete next[key];
  next.Cookie = [own.trim(), ...added].filter(Boolean).join('; ');
  return next;
}

/**
 * fetch with redirects followed by hand, as `redirect: 'follow'` would
 * (303, and 301/302 after a POST, turn into a GET without a body;
 * Authorization isn't sent to another origin), but with the jar's cookies
 * sent on each hop and what each hop sets stored. Returns the last response
 * and every Set-Cookie header along the way.
 */
async function fetchWithJar(
  config: RequestConfig,
  jar: CookieJar,
  first: { url: string; method: string; headers: Record<string, string>; body: BodyInit | undefined },
): Promise<{ response: Response; setCookies: string[] }> {
  const send = fetchFor(config);
  let { url, method, headers, body } = first;
  const setCookies: string[] = [];
  for (let hop = 0; ; hop++) {
    const response = await send(url, { method, headers: withJarCookies(headers, jar, url), body, redirect: 'manual' });
    const cookies = response.headers.getSetCookie();
    jar.store(url, cookies);
    setCookies.push(...cookies);
    const location = response.headers.get('location');
    if (!REDIRECTS.has(response.status) || !location || hop >= MAX_REDIRECTS) return { response, setCookies };
    await response.body?.cancel();
    const next = new URL(location, url);
    if (next.origin !== new URL(url).origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
    }
    if (response.status === 303 ? method !== 'HEAD' : response.status <= 302 && method === 'POST') {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !['content-type', 'content-length'].includes(name.toLowerCase())),
      );
    }
    url = next.toString();
  }
}

/**
 * Sends a request and returns a fully-resolved response.
 *
 * Performance is the product's stated wedge (the budget is <5ms of engine
 * overhead per request, excluding actual network time) —
 * keep this function free of anything that isn't strictly necessary to
 * build the request, send it, and time it accurately.
 */
export async function executeRequest(config: RequestConfig, options: ExecuteOptions = {}): Promise<ExecutedResponse> {
  // SOAP is an HTTP POST of its envelope.
  if (config.protocol === 'soap') return executeRequest(soapAsHttp(config), options);
  const protocol = config.protocol ?? 'http';
  if (protocol !== 'http' && protocol !== 'graphql') {
    throw new Error(
      `executeRequest does not support the "${protocol}" protocol yet; ` +
        `streaming protocols go through openStream instead.`,
    );
  }

  const start = performance.now();
  const headers = buildRequestHeaders(config);

  const method = protocol === 'graphql' ? 'POST' : config.method;
  const hasBody = protocol === 'graphql' || (config.method !== 'GET' && config.method !== 'HEAD');
  if (protocol === 'graphql' && !hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const jar = config.useCookies === false ? undefined : options.cookieJar;
  const {
    result: { response, bodyText, setCookies },
    marks,
  } = await withTiming(async () => {
    try {
      const url = buildUrl(config);
      const body = hasBody ? (protocol === 'graphql' ? buildGraphQlBody(config) : await buildBody(config)) : undefined;
      const send = async (sent: Record<string, string>): Promise<{ response: Response; setCookies: string[] }> => {
        if (jar) return fetchWithJar(config, jar, { url, method, headers: sent, body });
        const response = await fetchFor(config)(url, { method, headers: sent, body });
        return { response, setCookies: response.headers.getSetCookie() };
      };
      let sent = await send(headers);
      // Digest: the first answer is a 401 with the challenge; answer it and send again.
      const digest = config.auth.type === 'digest' ? config.auth.digest : undefined;
      const challenge =
        digest && sent.response.status === 401
          ? parseDigestChallenge(sent.response.headers.get('www-authenticate') ?? '')
          : undefined;
      if (digest && challenge) {
        await sent.response.body?.cancel();
        const target = new URL(url);
        const authorization = digestAuthorization(challenge, {
          username: digest.username,
          password: digest.password,
          method,
          uri: `${target.pathname}${target.search}`,
          body: typeof body === 'string' ? body : body === undefined ? '' : undefined,
        });
        const retried = await send({ ...headers, Authorization: authorization });
        sent = { response: retried.response, setCookies: [...sent.setCookies, ...retried.setCookies] };
      }
      return { ...sent, bodyText: await sent.response.text() };
    } catch (error) {
      throw withErrorDetail(error);
    }
  });
  const end = performance.now();

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body: bodyText,
    timings: { start, end, durationMs: end - start, phases: timingPhases(marks, end) },
    sizeBytes: Buffer.byteLength(bodyText, 'utf-8'),
    setCookies,
  };
}
