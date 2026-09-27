import { performance } from 'node:perf_hooks';
import type { ExecutedResponse, GraphQlProtocolConfig, KeyValue, RequestConfig } from '../types.js';
import { withErrorDetail } from './errors.js';
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
  return url.toString();
}

function buildBody(config: RequestConfig): BodyInit | undefined {
  switch (config.body.mode) {
    case 'none':
      return undefined;
    case 'raw':
    case 'json':
      return config.body.raw ?? '';
    case 'urlencoded': {
      const params = new URLSearchParams();
      for (const kv of config.body.formData ?? []) {
        if (kv.enabled) params.append(kv.key, kv.value);
      }
      return params.toString();
    }
    case 'form-data': {
      const form = new FormData();
      for (const kv of config.body.formData ?? []) {
        if (kv.enabled) form.append(kv.key, kv.value);
      }
      return form;
    }
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

/**
 * Sends a request and returns a fully-resolved response.
 *
 * Performance is the product's stated wedge (the budget is <5ms of engine
 * overhead per request, excluding actual network time) —
 * keep this function free of anything that isn't strictly necessary to
 * build the request, send it, and time it accurately.
 */
export async function executeRequest(config: RequestConfig): Promise<ExecutedResponse> {
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

  const {
    result: { response, bodyText },
    marks,
  } = await withTiming(async () => {
    try {
      const response = await fetchFor(config)(buildUrl(config), {
        method,
        headers,
        body: hasBody ? (protocol === 'graphql' ? buildGraphQlBody(config) : buildBody(config)) : undefined,
      });
      return { response, bodyText: await response.text() };
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
  };
}
