import { Agent, FormData as UndiciFormData, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { RequestConfig } from '../types.js';
import { endpointOf, hasCustomTls, proxyAuthorization, proxyFor, tlsOptionsFor, trustOptionsFor } from './network.js';

/**
 * Whether to check the server's TLS certificate (`RequestConfig.verifyTls`,
 * on unless set to `false`). Turning it off accepts expired, self-signed and
 * wrong-host certificates, which is for testing servers you control; the
 * connection is still encrypted, but not authenticated.
 */
export function verifiesTls(config: Pick<RequestConfig, 'verifyTls'>): boolean {
  return config.verifyTls !== false;
}

// Dispatchers by what they do (proxy, TLS files and settings), so
// connections are reused across requests with the same settings.
const dispatchers = new Map<string, Dispatcher>();
const MAX_DISPATCHERS = 32;

function dispatcherFor(config: Pick<RequestConfig, 'verifyTls' | 'network'>, url: string): Dispatcher | undefined {
  const { host, port } = endpointOf(url);
  const proxy = proxyFor(config.network, url);
  if (!proxy && !hasCustomTls(config, host, port)) return undefined;
  const tlsOptions = tlsOptionsFor(config, host, port);
  const key = JSON.stringify([proxy ?? null, tlsOptions]);
  let dispatcher = dispatchers.get(key);
  if (!dispatcher) {
    if (dispatchers.size >= MAX_DISPATCHERS) {
      const [oldestKey, oldest] = dispatchers.entries().next().value!;
      dispatchers.delete(oldestKey);
      void oldest.close().catch(() => {});
    }
    const authorization = proxy && proxyAuthorization(proxy);
    dispatcher = proxy
      ? new ProxyAgent({
          uri: proxy.url,
          ...(authorization && { token: authorization }),
          requestTls: tlsOptions,
          // A plain-HTTP request is sent to the proxy as it is, as curl does; HTTPS goes through a CONNECT tunnel.
          proxyTunnel: false,
          proxyTls: trustOptionsFor(config),
        })
      : new Agent({ connect: tlsOptions });
    dispatchers.set(key, dispatcher);
  }
  return dispatcher;
}

/** The `undici` package's fetch only sends its own FormData class, not Node's built-in one. */
function asUndiciBody(body: RequestInit['body']): RequestInit['body'] {
  if (!(body instanceof FormData)) return body;
  const form = new UndiciFormData();
  for (const [name, value] of body) {
    if (typeof value === 'string') form.append(name, value);
    else form.append(name, value, value.name);
  }
  return form as unknown as RequestInit['body'];
}

/**
 * The `fetch` to send `config` with. Node's built-in fetch can't use a proxy,
 * client certificates or skip certificate checks without a custom
 * dispatcher, and passing one from the `undici` package to Node's bundled
 * copy is only safe when their versions line up. So a request that needs
 * any of them (`verifyTls: false`, `network`) goes through the `undici`
 * package's own fetch and dispatchers together, chosen for each URL it's
 * sent to (a redirect can lead to a host with no proxy or another
 * certificate); every other request uses the built-in fetch. Both publish
 * the same diagnostics-channel events, so timing (timing.ts) works either way.
 */
export function fetchFor(config: Pick<RequestConfig, 'verifyTls' | 'network'>): typeof fetch {
  if (verifiesTls(config) && !config.network) return fetch;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const dispatcher = dispatcherFor(config, url);
    if (!dispatcher) return fetch(input, init);
    const undiciInit = { ...init, body: asUndiciBody(init?.body), dispatcher } as Parameters<typeof undiciFetch>[1];
    return undiciFetch(input as Parameters<typeof undiciFetch>[0], undiciInit);
  }) as unknown as typeof fetch;
}
