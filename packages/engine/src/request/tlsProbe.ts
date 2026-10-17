import tls from 'node:tls';
import type { ConnectionTls, RequestConfig } from '../types.js';
import { describeError } from './errors.js';
import { tlsOptionsFor } from './network.js';
import { connectionTls } from './timing.js';

export interface ProbeTlsOptions {
  /** The name to ask for (SNI) and check the certificate against; default: the host, unless it's an IP address. */
  servername?: string;
  /** Default 10 s. */
  timeoutMs?: number;
}

/**
 * The TLS connection a server offers on `host:port`, from a handshake of its
 * own with a connection's TLS settings (its extra authorities and client
 * certificate, `network`): the protocol, the cipher and the certificate, and
 * whether the certificate is trusted (described, not refused, so an untrusted
 * one can be shown). It sends nothing after the handshake, and doesn't go
 * through a proxy. For connections whose own TLS details aren't at hand: a
 * WebSocket, a broker, a gRPC server.
 */
export function probeTls(
  config: Pick<RequestConfig, 'verifyTls' | 'network'>,
  host: string,
  port: number,
  options: ProbeTlsOptions = {},
): Promise<ConnectionTls> {
  const isIp = /^[\d.]+$/.test(host) || host.includes(':');
  const servername = options.servername ?? (isIp ? undefined : host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      ...tlsOptionsFor({ ...config, verifyTls: true }, host, port),
      host,
      port,
      ...(servername && { servername }),
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No TLS handshake from ${host}:${port} within ${(options.timeoutMs ?? 10_000) / 1000} s.`));
    }, options.timeoutMs ?? 10_000);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const details = connectionTls(socket);
      socket.end();
      socket.destroy();
      if (details) resolve(details);
      else reject(new Error(`No TLS details from ${host}:${port}.`));
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`TLS handshake with ${host}:${port} failed: ${describeError(error)}`, { cause: error }));
    });
  });
}
