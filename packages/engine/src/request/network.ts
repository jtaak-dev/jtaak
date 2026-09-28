import { readFileSync, statSync } from 'node:fs';
import type { Agent } from 'node:http';
import { createRequire } from 'node:module';
import tls from 'node:tls';
import type { ClientCertificate, NetworkSettings, ProxyConfig, RequestConfig } from '../types.js';

const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
  'mqtt:': 1883,
  'mqtts:': 8883,
  'amqp:': 5672,
  'amqps:': 5671,
  'kafka:': 9092,
  'kafkas:': 9092,
  'nats:': 4222,
  'tls:': 4222,
};

/** The host and port a URL connects to (its scheme's default port when it has none). */
export function endpointOf(url: string | URL): { host: string; port: number } {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return { host, port: parsed.port ? Number(parsed.port) : (DEFAULT_PORTS[parsed.protocol] ?? 443) };
}

/**
 * Whether `host:port` matches a pattern: `example.com` (and its subdomains),
 * `.example.com` or `*.example.com` (its subdomains), `*` (everything), any of
 * them with `:port` to match that port only. IP addresses match exactly.
 */
export function hostMatches(pattern: string, host: string, port: number): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(p);
  if (!match) return p === host; // a bare IPv6 address
  if (match[2] && Number(match[2]) !== port) return false;
  const name = match[1].replace(/^\[|\]$/g, '');
  if (name === '*') return true;
  if (name.startsWith('*.')) return host.endsWith(name.slice(1));
  if (name.startsWith('.')) return host.endsWith(name);
  return host === name || host.endsWith(`.${name}`);
}

/** The proxy a connection to `url` goes through, or undefined when there's none or `noProxy` lists its host. */
export function proxyFor(network: NetworkSettings | undefined, url: string | URL): ProxyConfig | undefined {
  const proxy = network?.proxy;
  if (!proxy?.url) return undefined;
  const { host, port } = endpointOf(url);
  return (proxy.noProxy ?? []).some((pattern) => hostMatches(pattern, host, port)) ? undefined : proxy;
}

/**
 * A proxy from the conventional environment variables: `HTTPS_PROXY`, else
 * `HTTP_PROXY` (or their lower-case forms), with `NO_PROXY` as its no-proxy
 * list. A proxy URL's `user:password@` becomes its username and password.
 */
export function proxyFromEnvironment(env: Record<string, string | undefined> = process.env): ProxyConfig | undefined {
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy;
  if (!value?.trim()) return undefined;
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '')
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  let url = value.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  const username = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';
  return {
    url: parsed.toString().replace(/\/$/, ''),
    ...(username && { username }),
    ...(password && { password }),
    ...(noProxy.length > 0 && { noProxy }),
  };
}

/** A proxy's `Proxy-Authorization` value (Basic), from its username and password. */
export function proxyAuthorization(proxy: ProxyConfig): string | undefined {
  if (!proxy.username) return undefined;
  return `Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}`;
}

/** The client certificate for `host:port`: the first one whose `host` pattern matches. */
export function clientCertificateFor(
  network: NetworkSettings | undefined,
  host: string,
  port: number,
): ClientCertificate | undefined {
  return network?.clientCertificates?.find((certificate) => hostMatches(certificate.host, host, port));
}

// Certificate and key files, read once and again only when they change on disk.
const files = new Map<string, { mtimeMs: number; size: number; data: Buffer }>();

function readTlsFile(path: string, what: string): Buffer {
  try {
    const { mtimeMs, size } = statSync(path);
    const cached = files.get(path);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.data;
    const data = readFileSync(path);
    files.set(path, { mtimeMs, size, data });
    return data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === 'ENOENT' ? 'no such file' : (error as Error).message;
    throw new Error(`Couldn't read the ${what} "${path}": ${reason}`, { cause: error });
  }
}

/** The system's trusted certificate authorities (Node's bundled ones, plus NODE_EXTRA_CA_CERTS). */
function defaultCertificateAuthorities(): string[] {
  const get = (tls as { getCACertificates?: (type: 'default') => string[] }).getCACertificates;
  return get ? get('default') : [...tls.rootCertificates];
}

/** TLS options for a connection, in the shape `tls.connect` takes. */
export interface TlsConnectionOptions {
  rejectUnauthorized: boolean;
  /** The system's authorities plus the extra ones; only set when there are extra ones. */
  ca?: string[];
  cert?: Buffer;
  key?: Buffer;
  pfx?: Buffer;
  passphrase?: string;
}

/** Which server certificates a TLS connection accepts: `verifyTls` and the extra authorities (`network.caPaths`). */
export function trustOptionsFor(
  config: Pick<RequestConfig, 'verifyTls' | 'network'>,
): Pick<TlsConnectionOptions, 'rejectUnauthorized' | 'ca'> {
  const caPaths = config.network?.caPaths?.filter((path) => path.trim()) ?? [];
  if (caPaths.length === 0) return { rejectUnauthorized: config.verifyTls !== false };
  return {
    rejectUnauthorized: config.verifyTls !== false,
    ca: [
      ...defaultCertificateAuthorities(),
      ...caPaths.map((path) => readTlsFile(path, 'certificate authority file').toString('utf-8')),
    ],
  };
}

/**
 * What a TLS connection to `host:port` uses: whether it checks the server's
 * certificate (`verifyTls`), the extra authorities it trusts (`network.caPaths`,
 * next to the system's) and the client certificate it offers when the server
 * asks for one (`network.clientCertificates`, by host). The files are read
 * here; a missing one fails with a message naming it.
 */
export function tlsOptionsFor(
  config: Pick<RequestConfig, 'verifyTls' | 'network'>,
  host: string,
  port: number,
): TlsConnectionOptions {
  const options: TlsConnectionOptions = trustOptionsFor(config);
  const certificate = clientCertificateFor(config.network, host, port);
  if (certificate?.pfxPath) {
    options.pfx = readTlsFile(certificate.pfxPath, 'client certificate (PFX) file');
  } else if (certificate?.certPath) {
    options.cert = readTlsFile(certificate.certPath, 'client certificate file');
    if (certificate.keyPath) options.key = readTlsFile(certificate.keyPath, 'client certificate key file');
  }
  if (certificate?.passphrase && (options.pfx || options.key)) options.passphrase = certificate.passphrase;
  return options;
}

/** `tlsOptionsFor` the host and port `url` connects to. */
export function tlsOptionsForUrl(
  config: Pick<RequestConfig, 'verifyTls' | 'network'>,
  url: string,
): TlsConnectionOptions {
  const { host, port } = endpointOf(url);
  return tlsOptionsFor(config, host, port);
}

/** Whether a connection to `host:port` needs anything beyond Node's defaults (a certificate check left on). */
export function hasCustomTls(
  config: Pick<RequestConfig, 'verifyTls' | 'network'>,
  host: string,
  port: number,
): boolean {
  return (
    config.verifyTls === false ||
    (config.network?.caPaths ?? []).some((path) => path.trim()) ||
    clientCertificateFor(config.network, host, port) !== undefined
  );
}

// Loaded only when a connection goes through a proxy, so nothing loads for the CLI or a direct connection.
const require = createRequire(import.meta.url);

/**
 * An agent that tunnels a Node `http`/`https` connection (a WebSocket's
 * handshake) through the proxy for `url` with CONNECT, or undefined when
 * there's no proxy for it. The target's own TLS options still go on the
 * request; the proxy's certificate is checked like the server's.
 */
export function proxyAgentFor(config: Pick<RequestConfig, 'verifyTls' | 'network'>, url: string): Agent | undefined {
  const proxy = proxyFor(config.network, url);
  if (!proxy) return undefined;
  const { HttpsProxyAgent } = require('https-proxy-agent') as typeof import('https-proxy-agent');
  const authorization = proxyAuthorization(proxy);
  return new HttpsProxyAgent(proxy.url, {
    ...(authorization && { headers: { 'Proxy-Authorization': authorization } }),
    ...trustOptionsFor(config),
  });
}
