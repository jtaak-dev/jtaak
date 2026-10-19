import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { executeRequest } from './executor';
import { runRequestWithScripts } from '../scripting/runRequest';
import { emptyScopes, type RequestConfig } from '../types';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const n = Number(url.searchParams.get('n') ?? 0);
    if (url.pathname === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      // In pieces, so the limit falls inside a chunk as well as between them.
      for (let i = 0; i < n; i += 7) res.write('abcdefg'.slice(0, Math.min(7, n - i)));
      res.end();
    } else if (url.pathname === '/accents') {
      // 'é' is two bytes in UTF-8, '€' three.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('é€'.repeat(n));
    } else if (url.pathname === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync('x'.repeat(n)));
    } else if (url.pathname === '/broken') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100000' });
      res.write('x'.repeat(1000), () => res.destroy());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const config = (path: string, overrides: Partial<RequestConfig> = {}): RequestConfig => ({
  id: 'r',
  name: 'r',
  method: 'GET',
  url: `${baseUrl}${path}`,
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

describe('maxBodyBytes', () => {
  it('keeps the whole body without a limit, as before', async () => {
    const response = await executeRequest(config('/text?n=5000'));
    expect(response.body).toHaveLength(5000);
    expect(response.sizeBytes).toBe(5000);
    expect(response.bodyTruncated).toBeUndefined();
  });

  it('keeps a body under or at the limit whole, unmarked', async () => {
    for (const n of [999, 1000]) {
      const response = await executeRequest(config(`/text?n=${n}`), { maxBodyBytes: 1000 });
      expect(response.body).toHaveLength(n);
      expect(response.sizeBytes).toBe(n);
      expect(response.bodyTruncated).toBeUndefined();
    }
  });

  it('keeps only the limit of a bigger body, and its whole size', async () => {
    const response = await executeRequest(config('/text?n=100000'), { maxBodyBytes: 1000 });
    expect(response.body).toBe('abcdefg'.repeat(143).slice(0, 1000));
    expect(response.sizeBytes).toBe(100000);
    expect(response.bodyTruncated).toBe(true);
  });

  it('keeps nothing with a limit of 0', async () => {
    const response = await executeRequest(config('/text?n=10'), { maxBodyBytes: 0 });
    expect(response).toMatchObject({ body: '', sizeBytes: 10, bodyTruncated: true });
  });

  it('cuts on a character boundary, never half a character', async () => {
    for (const limit of [1, 2, 3, 4, 5, 6, 13]) {
      const response = await executeRequest(config('/accents?n=10'), { maxBodyBytes: limit });
      expect(response.bodyTruncated).toBe(true);
      expect(response.sizeBytes).toBe(50);
      expect(response.body).not.toContain('�');
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(limit);
      expect('é€'.repeat(10).startsWith(response.body)).toBe(true);
    }
    const exact = await executeRequest(config('/accents?n=10'), { maxBodyBytes: 7 });
    expect(exact.body).toBe('é€é');
  });

  it('limits the decompressed body of a gzip response', async () => {
    const response = await executeRequest(config('/gzip?n=50000'), { maxBodyBytes: 100 });
    expect(response).toMatchObject({ body: 'x'.repeat(100), sizeBytes: 50000, bodyTruncated: true });
  });

  it('fails as before when the body breaks off part-way', async () => {
    await expect(executeRequest(config('/broken'), { maxBodyBytes: 100 })).rejects.toThrow();
    await expect(executeRequest(config('/broken'))).rejects.toThrow();
  });

  it('shows scripts the kept part, and marks it', async () => {
    const testScript = [
      'jt.test("cut", () => jt.expect(jt.response.truncated).toBe(true));',
      'jt.test("kept", () => jt.expect(jt.response.body.length).toBe(10));',
    ].join('\n');
    const result = await runRequestWithScripts(config('/text?n=1000', { testScript }), emptyScopes(), undefined, {
      maxBodyBytes: 10,
    });
    expect(result.testResults.map((t) => t.passed)).toEqual([true, true]);
    expect(result.response?.bodyTruncated).toBe(true);

    const whole = await runRequestWithScripts(
      config('/text?n=10', { testScript: 'jt.test("whole", () => jt.expect(jt.response.truncated).toBe(false));' }),
      emptyScopes(),
    );
    expect(whole.testResults[0].passed).toBe(true);
  });
});
