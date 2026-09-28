import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { executeRequest } from './executor';
import { CookieJar } from './cookieJar';
import { fileNameOf, mediaTypeFor } from './files';
import type { FormField, RequestConfig } from '../types';

let server: http.Server;
let baseUrl: string;
let dir: string;
const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 10, 13]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jtaak-files-'));
  writeFileSync(join(dir, 'data.bin'), bytes);
  writeFileSync(join(dir, 'photo.PNG'), bytes);
  server = http.createServer((req, res) => {
    // /redirect sends a 307, which keeps the method and the body.
    if (req.url === '/redirect') {
      req.resume();
      res.writeHead(307, { location: '/echo' });
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString('base64') }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

function binaryRequest(binaryPath: string | undefined, overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'r',
    name: 'binary',
    method: 'POST',
    url: `${baseUrl}/echo`,
    params: [],
    headers: [],
    body: { mode: 'binary', binaryPath },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('binary bodies', () => {
  it("sends the file's bytes, with a Content-Type from its extension", async () => {
    const echo = JSON.parse((await executeRequest(binaryRequest(join(dir, 'photo.PNG')))).body);
    expect(Buffer.from(echo.body, 'base64')).toEqual(bytes);
    expect(echo.headers['content-type']).toBe('image/png');
    expect(echo.headers['content-length']).toBe(String(bytes.length));
  });

  it('keeps a Content-Type header the request sets', async () => {
    const echo = JSON.parse(
      (
        await executeRequest(
          binaryRequest(join(dir, 'data.bin'), {
            headers: [{ key: 'Content-Type', value: 'application/vnd.custom', enabled: true }],
          }),
        )
      ).body,
    );
    expect(echo.headers['content-type']).toBe('application/vnd.custom');
    expect(Buffer.from(echo.body, 'base64')).toEqual(bytes);
  });

  it('sends the file again after a redirect that keeps the body', async () => {
    const response = await executeRequest(binaryRequest(join(dir, 'data.bin'), { url: `${baseUrl}/redirect` }), {
      cookieJar: new CookieJar(),
    });
    expect(Buffer.from(JSON.parse(response.body).body, 'base64')).toEqual(bytes);
  });

  it('sends no body when no file is chosen', async () => {
    const echo = JSON.parse((await executeRequest(binaryRequest(undefined))).body);
    expect(echo.body).toBe('');
  });

  it("names the file when it can't be read", async () => {
    await expect(executeRequest(binaryRequest(join(dir, 'missing.bin')))).rejects.toThrow(
      /Couldn't read the body file ".*missing\.bin": no such file/,
    );
  });
});

describe('form-data file rows', () => {
  function formRequest(formData: FormField[], mode: 'form-data' | 'urlencoded' = 'form-data'): RequestConfig {
    return { ...binaryRequest(undefined), body: { mode, formData } };
  }

  it('send a file as a file part, named after it, next to text parts', async () => {
    const echo = JSON.parse(
      (
        await executeRequest(
          formRequest([
            { key: 'note', value: 'hi', enabled: true },
            { key: 'photo', value: '', enabled: true, type: 'file', src: join(dir, 'photo.PNG') },
            { key: 'none', value: '', enabled: true, type: 'file' },
            { key: 'off', value: '', enabled: false, type: 'file', src: join(dir, 'missing.bin') },
          ]),
        )
      ).body,
    );
    expect(echo.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const sent = Buffer.from(echo.body, 'base64');
    const text = sent.toString('latin1');
    expect(text).toContain('Content-Disposition: form-data; name="note"\r\n\r\nhi\r\n');
    expect(text).toContain(
      'Content-Disposition: form-data; name="photo"; filename="photo.PNG"\r\nContent-Type: image/png',
    );
    expect(sent.includes(bytes)).toBe(true);
    expect(text).not.toContain('name="none"');
    expect(text).not.toContain('name="off"');
  });

  it('are left out of a urlencoded body', async () => {
    const echo = JSON.parse(
      (
        await executeRequest(
          formRequest(
            [
              { key: 'a', value: '1', enabled: true },
              { key: 'f', value: '', enabled: true, type: 'file', src: join(dir, 'data.bin') },
            ],
            'urlencoded',
          ),
        )
      ).body,
    );
    expect(Buffer.from(echo.body, 'base64').toString()).toBe('a=1');
  });

  it("name the file when it can't be read", async () => {
    await expect(
      executeRequest(formRequest([{ key: 'f', value: '', enabled: true, type: 'file', src: join(dir, 'gone.txt') }])),
    ).rejects.toThrow(/gone\.txt": no such file/);
  });
});

describe('mediaTypeFor and fileNameOf', () => {
  it('knows common extensions, in any case, and falls back to octet-stream', () => {
    expect(mediaTypeFor('a/b/report.PDF')).toBe('application/pdf');
    expect(mediaTypeFor('x.json')).toBe('application/json');
    expect(mediaTypeFor('noext')).toBe('application/octet-stream');
    expect(mediaTypeFor('x.weird')).toBe('application/octet-stream');
  });

  it('takes the name from Windows and POSIX paths', () => {
    expect(fileNameOf('C:\\Users\\me\\photo.png')).toBe('photo.png');
    expect(fileNameOf('/tmp/data.bin')).toBe('data.bin');
  });
});
