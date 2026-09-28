import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseSetCookie } from './cookies';
import { executeRequest } from './executor';

describe('parseSetCookie', () => {
  it('reads the name, value and every attribute', () => {
    expect(
      parseSetCookie(
        'session=abc123; Domain=.Example.com; Path=/app; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Max-Age=3600; Secure; HttpOnly; SameSite=lax',
      ),
    ).toEqual({
      name: 'session',
      value: 'abc123',
      domain: 'example.com',
      path: '/app',
      expires: 'Wed, 21 Oct 2026 07:28:00 GMT',
      maxAge: 3600,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
  });

  it('keeps a value with = in it, and an empty value', () => {
    expect(parseSetCookie('token=a=b==; Path=/')).toMatchObject({ name: 'token', value: 'a=b==' });
    expect(parseSetCookie('cleared=; Max-Age=0')).toMatchObject({ name: 'cleared', value: '', maxAge: 0 });
  });

  it('ignores attributes it does not know, and a path that is not absolute', () => {
    expect(parseSetCookie('a=1; Priority=High; Path=relative')).toEqual({
      name: 'a',
      value: '1',
      secure: false,
      httpOnly: false,
    });
  });

  it('gives undefined without a name=value pair', () => {
    expect(parseSetCookie('no-equals-sign')).toBeUndefined();
    expect(parseSetCookie('=value-without-name')).toBeUndefined();
  });
});

describe('ExecutedResponse.setCookies', () => {
  let server: http.Server;
  let url: string;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.setHeader('Set-Cookie', ['a=1; Path=/', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT']);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => server.close());

  it('keeps each Set-Cookie header, which headers joins into one', async () => {
    const response = await executeRequest({
      id: 'r',
      name: 'r',
      method: 'GET',
      url,
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
    });
    expect(response.setCookies).toEqual(['a=1; Path=/', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT']);
    expect(response.setCookies!.map((h) => parseSetCookie(h)!.name)).toEqual(['a', 'b']);
  });
});
