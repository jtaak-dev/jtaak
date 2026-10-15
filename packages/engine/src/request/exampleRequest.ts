import type { ExampleMatch, ExampleRequest, GraphQlProtocolConfig, KeyValue, RequestConfig } from '../types.js';
import { soapAsHttp } from './soap.js';

// The request a response example answers (ResponseExample.request): the
// request as written, variables unresolved, in the HTTP form it's sent in.
// No auth: credentials don't decide which example answers, and a resolved one
// must never be stored. Pure, so a UI can build it (it's in browser.ts).

/** A query component, encoded, with any `{{variable}}` kept as written. */
function encodeQueryPart(text: string): string {
  return encodeURIComponent(text).replace(
    /%7B%7B(.*?)%7D%7D/g,
    (_, inner: string) => `{{${decodeURIComponent(inner)}}}`,
  );
}

function enabled<T extends KeyValue>(list: T[] | undefined): T[] {
  return (list ?? []).filter((kv) => kv.enabled && kv.key.trim().length > 0);
}

/** The URL with the enabled query parameters appended, as `buildUrl` does, without parsing it (it may hold variables). */
function urlWithParams(url: string, params: KeyValue[]): string {
  const query = enabled(params)
    .map((p) => `${encodeQueryPart(p.key)}=${encodeQueryPart(p.value)}`)
    .join('&');
  if (!query) return url;
  const hash = url.indexOf('#');
  const [base, fragment] = hash >= 0 ? [url.slice(0, hash), url.slice(hash)] : [url, ''];
  const joiner = base.includes('?') ? (base.endsWith('?') || base.endsWith('&') ? '' : '&') : '?';
  return `${base}${joiner}${query}${fragment}`;
}

function textBody(config: RequestConfig): string | undefined {
  switch (config.body.mode) {
    case 'raw':
    case 'json':
      return config.body.raw ?? '';
    case 'urlencoded':
      return enabled(config.body.formData)
        .filter((f) => f.type !== 'file')
        .map((f) => `${encodeQueryPart(f.key)}=${encodeQueryPart(f.value)}`)
        .join('&');
    default:
      return undefined;
  }
}

/** The names of the query parameters in a URL that may hold variables. */
export function exampleQueryNames(url: string): string[] {
  const query = url.split('#')[0].split('?').slice(1).join('?');
  const names = query
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const name = part.split('=')[0];
      try {
        return decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        return name;
      }
    });
  return [...new Set(names)];
}

/** What a newly saved example matches on: its query parameters and its body, not its headers. */
export function defaultExampleMatch(request: Omit<ExampleRequest, 'match'>): ExampleMatch {
  const query = exampleQueryNames(request.url);
  return {
    ...(query.length > 0 && { query }),
    ...(request.body !== undefined && request.body.trim().length > 0 && { body: true }),
  };
}

/**
 * The request a response example of `config` answers, in its HTTP form, with
 * `match` (by default `defaultExampleMatch`). For HTTP, GraphQL and SOAP
 * requests; other protocols have no examples.
 */
export function exampleRequestFrom(config: RequestConfig, match?: ExampleMatch): ExampleRequest {
  const protocol = config.protocol ?? 'http';
  const http = protocol === 'soap' ? soapAsHttp(config) : config;
  const headers = Object.fromEntries(enabled(http.headers).map((h) => [h.key, h.value]));
  let method: string = http.method;
  let body: string | undefined;
  if (protocol === 'graphql') {
    const graphql = config.protocolConfig as GraphQlProtocolConfig | undefined;
    method = 'POST';
    body = JSON.stringify({
      query: graphql?.query ?? '',
      variables: graphql?.variables ?? {},
      ...(graphql?.operationName && { operationName: graphql.operationName }),
    });
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  } else if (method !== 'GET' && method !== 'HEAD') {
    body = textBody(http);
  }
  const request: Omit<ExampleRequest, 'match'> = {
    method,
    url: urlWithParams(http.url, http.params),
    headers,
    ...(body !== undefined && { body }),
  };
  const chosen = match ?? defaultExampleMatch(request);
  return { ...request, ...(Object.keys(chosen).length > 0 && { match: chosen }) };
}
