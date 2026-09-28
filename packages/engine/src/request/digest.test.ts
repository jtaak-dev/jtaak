import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { digestAuthorization, parseDigestChallenge } from './digest';
import { executeRequest } from './executor';
import type { RequestConfig } from '../types';

const param = (header: string, name: string) =>
  new RegExp(`${name}=(?:"([^"]*)"|([^,\\s]*))`)
    .exec(header)
    ?.slice(1)
    .find((v) => v !== undefined);

describe('parseDigestChallenge', () => {
  it('reads a challenge, preferring SHA-256 when the server offers several', () => {
    const header =
      'Basic realm="x", Digest realm="http-auth@example.org", qop="auth, auth-int", algorithm=MD5, nonce="n1", opaque="o1", ' +
      'Digest realm="http-auth@example.org", qop="auth", algorithm=SHA-256, nonce="n2", opaque="o2", userhash=false';
    expect(parseDigestChallenge(header)).toEqual({
      realm: 'http-auth@example.org',
      nonce: 'n2',
      opaque: 'o2',
      algorithm: 'SHA-256',
      qop: ['auth'],
      userhash: false,
      stale: false,
    });
  });

  it('defaults to MD5, and ignores what it cannot answer', () => {
    expect(parseDigestChallenge('Digest realm="r", nonce="n"')).toMatchObject({ algorithm: 'MD5', qop: [] });
    expect(parseDigestChallenge('Digest realm="r", nonce="n", algorithm=SHA-512-256')).toBeUndefined();
    expect(parseDigestChallenge('Bearer realm="r"')).toBeUndefined();
  });
});

describe('digestAuthorization', () => {
  it('gives RFC 2617’s worked example (MD5, qop=auth)', () => {
    const header = digestAuthorization(
      {
        realm: 'testrealm@host.com',
        nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
        opaque: '5ccc069c403ebaf9f0171e9517f40e41',
        algorithm: 'MD5',
        qop: ['auth', 'auth-int'],
        userhash: false,
        stale: false,
      },
      { username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', cnonce: '0a4f113b' },
    );
    expect(param(header, 'response')).toBe('6629fae49393a05397450978507c4ef1');
    expect(header).toContain('qop=auth, nc=00000001, cnonce="0a4f113b"');
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  });

  it('gives RFC 7616’s worked examples (SHA-256 and MD5)', () => {
    const challenge = {
      realm: 'http-auth@example.org',
      nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      opaque: 'FQhe/qaU925kfnzjCev0ciny7QMkPqMAFRtzCUYo5tdS',
      qop: ['auth', 'auth-int'],
      userhash: false,
      stale: false,
    };
    const input = {
      username: 'Mufasa',
      password: 'Circle of Life',
      method: 'GET',
      uri: '/dir/index.html',
      cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ',
    };
    expect(param(digestAuthorization({ ...challenge, algorithm: 'SHA-256' }, input), 'response')).toBe(
      '753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1',
    );
    expect(param(digestAuthorization({ ...challenge, algorithm: 'MD5' }, input), 'response')).toBe(
      '8ca523f5e9506fed4657c9700eebdbec',
    );
  });
});

describe('executeRequest with Digest auth', () => {
  let server: http.Server;
  let url: string;
  let attempts = 0;
  const md5 = (text: string) => createHash('md5').update(text).digest('hex');

  beforeAll(async () => {
    // Checks the answer the way a server would, from its own copy of the password.
    server = http.createServer((req, res) => {
      attempts++;
      const auth = req.headers.authorization ?? '';
      const nonce = 'server-nonce';
      if (auth.startsWith('Digest ')) {
        const ha1 = md5(`alice:api:s3cret`);
        const ha2 = md5(`${req.method}:${param(auth, 'uri')}`);
        const expected = md5(`${ha1}:${nonce}:${param(auth, 'nc')}:${param(auth, 'cnonce')}:auth:${ha2}`);
        if (param(auth, 'response') === expected && param(auth, 'uri') === req.url) {
          res.end('welcome');
          return;
        }
      }
      res.writeHead(401, { 'WWW-Authenticate': `Digest realm="api", qop="auth", nonce="${nonce}", algorithm=MD5` });
      res.end('who are you?');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/secret?x=1`;
  });
  afterAll(() => server.close());

  const request = (password: string): RequestConfig => ({
    id: 'r',
    name: 'r',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'digest', digest: { username: 'alice', password } },
  });

  it('answers the challenge and sends again', async () => {
    attempts = 0;
    const response = await executeRequest(request('s3cret'));
    expect(response.status).toBe(200);
    expect(response.body).toBe('welcome');
    expect(attempts).toBe(2);
  });

  it('returns the second 401 when the password is wrong, without trying again', async () => {
    attempts = 0;
    const response = await executeRequest(request('wrong'));
    expect(response.status).toBe(401);
    expect(attempts).toBe(2);
  });
});
