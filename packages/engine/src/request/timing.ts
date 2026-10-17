import { AsyncLocalStorage } from 'node:async_hooks';
import diagnosticsChannel from 'node:diagnostics_channel';
import type { Socket } from 'node:net';
import type { PeerCertificate, TLSSocket } from 'node:tls';
import { performance } from 'node:perf_hooks';
import type { ConnectionTls, RequestTimingPhases, TlsCertificateSummary } from '../types.js';

/**
 * Where a request's time goes: DNS, connecting, TLS, waiting for the first
 * byte, and downloading the body, from the diagnostics-channel events that
 * Node's fetch (undici) and net publish as a request runs.
 *
 * The events carry no reference to the fetch call, so they're matched up in
 * two steps. undici's request object is tied to the calling fetch's marks
 * when it's created (that event runs synchronously inside the fetch call,
 * within its AsyncLocalStorage context); every later request event carries
 * that same object. Connection timings are recorded on the socket, and the
 * first request sent over a new socket claims it; later ones reuse it.
 * (Events fired from a socket's data handler run in the context of whoever
 * created the socket, so the context alone can't attribute them.)
 */
export interface ConnectionMarks {
  created: number;
  lookup?: number;
  connect?: number;
  secureConnect?: number;
  /** A request has already been sent over this connection. */
  claimed: boolean;
}

export interface TimingMarks {
  /** The connection this request opened; absent when it reused one. */
  connection?: ConnectionMarks;
  /** The request (headers and body) was sent. */
  requestSent?: number;
  /** The response's headers arrived. */
  firstByte?: number;
  /** The TLS connection the last request went out on (a new or a reused one; after a redirect, the final one). */
  tls?: ConnectionTls;
}

const current = new AsyncLocalStorage<TimingMarks>();
const byRequest = new WeakMap<object, TimingMarks>();
const bySocket = new WeakMap<object, ConnectionMarks>();
// Each TLS socket's details, read once: by the time a request goes out on it,
// the handshake is done, whoever opened it.
const tlsBySocket = new WeakMap<object, ConnectionTls | undefined>();

// A resumed TLS session shows no certificate, so the last one each endpoint
// showed is kept for it (a few hundred endpoints at most).
const certificateByEndpoint = new Map<string, TlsCertificateSummary>();
const MAX_ENDPOINTS = 256;

function tlsOf(socket: object): ConnectionTls | undefined {
  if (!(socket as { encrypted?: boolean }).encrypted) return undefined;
  if (!tlsBySocket.has(socket)) {
    const tls = socket as TLSSocket;
    const details = connectionTls(tls);
    const endpoint = `${(tls as { servername?: string }).servername || tls.remoteAddress}:${tls.remotePort}`;
    if (details?.certificate) {
      certificateByEndpoint.delete(endpoint);
      certificateByEndpoint.set(endpoint, details.certificate);
      if (certificateByEndpoint.size > MAX_ENDPOINTS) {
        certificateByEndpoint.delete(certificateByEndpoint.keys().next().value!);
      }
    } else if (details && tls.isSessionReused?.()) {
      const known = certificateByEndpoint.get(endpoint);
      if (known) details.certificate = known;
    }
    tlsBySocket.set(socket, details);
  }
  return tlsBySocket.get(socket);
}
let subscribed = false;

function now(): number {
  return performance.now();
}

function marksOf(message: unknown): TimingMarks | undefined {
  const request = (message as { request?: object }).request;
  return request ? byRequest.get(request) : undefined;
}

/** Subscribes once, on first use: until then a host process pays nothing. */
function subscribe(): void {
  if (subscribed) return;
  subscribed = true;

  // A client socket (plain or TLS) was created, before it connects. Only
  // sockets opened while one of this engine's requests runs are timed.
  diagnosticsChannel.subscribe('net.client.socket', (message) => {
    if (!current.getStore()) return;
    const socket = (message as { socket: Socket }).socket;
    const connection: ConnectionMarks = { created: now(), claimed: false };
    bySocket.set(socket, connection);
    socket.once('lookup', () => (connection.lookup = now()));
    socket.once('connect', () => (connection.connect = now()));
    socket.once('secureConnect', () => (connection.secureConnect = now()));
  });
  diagnosticsChannel.subscribe('undici:request:create', (message) => {
    const marks = current.getStore();
    const request = (message as { request?: object }).request;
    if (marks && request) byRequest.set(request, marks);
  });
  // The socket a request goes out on: a new one it claims, or a reused one.
  // After a redirect, the first request's connection is the one reported.
  diagnosticsChannel.subscribe('undici:client:sendHeaders', (message) => {
    const marks = marksOf(message);
    const socket = (message as { socket?: object }).socket;
    if (marks && socket) marks.tls = tlsOf(socket);
    const connection = socket ? bySocket.get(socket) : undefined;
    if (!marks || !connection || connection.claimed) return;
    connection.claimed = true;
    marks.connection ??= connection;
  });
  // The last request's, so after a redirect these describe the final response.
  diagnosticsChannel.subscribe('undici:request:bodySent', (message) => {
    const marks = marksOf(message);
    if (marks) marks.requestSent = now();
  });
  diagnosticsChannel.subscribe('undici:request:headers', (message) => {
    const marks = marksOf(message);
    if (marks) marks.firstByte = now();
  });
}

/** What a TLS socket agreed on, and the certificate it was shown. */
export function connectionTls(socket: TLSSocket): ConnectionTls | undefined {
  if (typeof socket.getProtocol !== 'function') return undefined;
  const cipher = socket.getCipher?.();
  const certificate = socket.getPeerCertificate?.();
  const error = socket.authorizationError;
  return {
    protocol: socket.getProtocol(),
    ...(cipher ? { cipher: cipher.standardName ?? cipher.name } : {}),
    ...(typeof socket.alpnProtocol === 'string' ? { alpnProtocol: socket.alpnProtocol } : {}),
    authorized: socket.authorized === true,
    ...(error ? { authorizationError: typeof error === 'string' ? error : (error as Error).message } : {}),
    ...(certificate && certificate.subject ? { certificate: certificateSummary(certificate) } : {}),
  };
}

function distinguishedName(name: Record<string, string | string[]> | undefined): string {
  if (!name) return '';
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('+') : value}`)
    .join(', ');
}

function isoTime(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toISOString();
}

function certificateSummary(certificate: PeerCertificate): TlsCertificateSummary {
  const subject = distinguishedName(certificate.subject as unknown as Record<string, string>);
  const issuer = distinguishedName(certificate.issuer as unknown as Record<string, string>);
  return {
    subject,
    issuer,
    subjectAltNames: certificate.subjectaltname ? certificate.subjectaltname.split(/,\s*/) : [],
    validFrom: isoTime(certificate.valid_from),
    validTo: isoTime(certificate.valid_to),
    fingerprint256: certificate.fingerprint256,
    serialNumber: certificate.serialNumber,
    selfSigned: subject === issuer,
  };
}

/** Runs `send` with fresh timing marks, and returns them with its result. */
export async function withTiming<T>(send: () => Promise<T>): Promise<{ result: T; marks: TimingMarks }> {
  subscribe();
  const marks: TimingMarks = {};
  const result = await current.run(marks, send);
  return { result, marks };
}

/**
 * The phases from a request's marks, with `end` the moment its body was read.
 * Undefined if the events never arrived (so there's nothing true to show).
 */
export function timingPhases(marks: TimingMarks, end: number): RequestTimingPhases | undefined {
  if (marks.firstByte === undefined) return undefined;
  const span = (from?: number, to?: number) => (from === undefined || to === undefined ? 0 : Math.max(0, to - from));
  const connection = marks.connection;
  return {
    // No lookup event for an IP address, and no connection times at all for a
    // reused connection: 0.
    dnsMs: span(connection?.created, connection?.lookup),
    connectMs: span(connection?.lookup ?? connection?.created, connection?.connect),
    tlsMs: span(connection?.connect, connection?.secureConnect),
    waitMs: span(marks.requestSent, marks.firstByte),
    downloadMs: span(marks.firstByte, end),
    reusedConnection: connection === undefined,
  };
}
