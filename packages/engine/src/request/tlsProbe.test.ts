import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { selfSignedCertificate } from '../test/tls';
import { probeTls } from './tlsProbe';

let server: tls.Server;
let port: number;

beforeAll(async () => {
  const { key, cert } = selfSignedCertificate();
  server = tls.createServer({ key, cert }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());

describe('probeTls', () => {
  it("describes a server's TLS connection, an untrusted certificate included", async () => {
    const details = await probeTls({}, '127.0.0.1', port);
    expect(details.protocol).toMatch(/^TLSv1\.[23]$/);
    expect(details.authorized).toBe(false);
    expect(details.authorizationError).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(details.certificate).toMatchObject({ subject: 'CN=localhost', selfSigned: true });
  });

  it('says why when there is no handshake', async () => {
    const plain = net.createServer((socket) => socket.end('not tls'));
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const plainPort = (plain.address() as AddressInfo).port;
    await expect(probeTls({}, '127.0.0.1', plainPort, { timeoutMs: 2000 })).rejects.toThrow(/TLS handshake with/);
    plain.close();
  });
});
