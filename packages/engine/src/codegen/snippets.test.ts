import { describe, expect, it } from 'vitest';
import { generateSnippet } from './snippets';
import type { RequestConfig } from '../types';

function config(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req-1',
    name: 'test',
    method: 'GET',
    url: 'https://api.example.com/users',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('generateSnippet', () => {
  it('generates a curl command with headers, query params, and a JSON body', () => {
    const snippet = generateSnippet(
      config({
        method: 'POST',
        params: [{ key: 'debug', value: 'true', enabled: true }],
        headers: [{ key: 'X-Trace', value: '123', enabled: true }],
        body: { mode: 'json', raw: '{"name":"jtaak"}' },
      }),
      'curl',
    );
    expect(snippet).toContain("curl -X POST 'https://api.example.com/users?debug=true'");
    expect(snippet).toContain("-H 'X-Trace: 123'");
    expect(snippet).toContain(`-d '{"name":"jtaak"}'`);
  });

  it("sends a binary body's file with --data-binary in curl", () => {
    const snippet = generateSnippet(
      config({ method: 'PUT', body: { mode: 'binary', binaryPath: "/tmp/it's.bin" } }),
      'curl',
    );
    expect(snippet).toContain(`--data-binary '@/tmp/it'\\''s.bin'`);
  });

  it('sends form-data as -F parts in curl, with files as @path', () => {
    const snippet = generateSnippet(
      config({
        method: 'POST',
        body: {
          mode: 'form-data',
          formData: [
            { key: 'note', value: 'hi', enabled: true },
            { key: 'photo', value: '', enabled: true, type: 'file', src: '/data/a.png' },
            { key: 'off', value: 'x', enabled: false },
          ],
        },
      }),
      'curl',
    );
    expect(snippet).toContain(`-F 'note=hi'`);
    expect(snippet).toContain(`-F 'photo=@/data/a.png'`);
    expect(snippet).not.toContain('off=');
    expect(snippet).not.toContain(' -d ');
  });

  it('includes bearer auth as an Authorization header in curl', () => {
    const snippet = generateSnippet(config({ auth: { type: 'bearer', bearer: { token: 'abc123' } } }), 'curl');
    expect(snippet).toContain("-H 'Authorization: Bearer abc123'");
  });

  it('includes basic auth via -u in curl', () => {
    const snippet = generateSnippet(
      config({ auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } } }),
      'curl',
    );
    expect(snippet).toContain("-u 'alice:secret'");
  });

  it('generates a fetch snippet with method, headers, and body', () => {
    const snippet = generateSnippet(
      config({
        method: 'POST',
        headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
        body: { mode: 'json', raw: '{"a":1}' },
      }),
      'js-fetch',
    );
    expect(snippet).toContain("fetch('https://api.example.com/users'");
    expect(snippet).toContain(`method: 'POST'`);
    expect(snippet).toContain('"Content-Type": "application/json"');
    expect(snippet).toContain('body:');
  });

  it('generates an axios snippet with basic auth', () => {
    const snippet = generateSnippet(
      config({ auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } } }),
      'js-axios',
    );
    expect(snippet).toContain("require('axios')");
    expect(snippet).toContain("username: 'alice'");
    expect(snippet).toContain("password: 'secret'");
  });

  it('generates a python requests snippet', () => {
    const snippet = generateSnippet(config({ method: 'GET' }), 'python-requests');
    expect(snippet).toContain('import requests');
    expect(snippet).toContain('requests.get(');
  });

  it('generates a go net/http snippet', () => {
    const snippet = generateSnippet(config({ method: 'GET' }), 'go');
    expect(snippet).toContain('package main');
    expect(snippet).toContain('net/http');
    expect(snippet).toContain('http.NewRequest("GET"');
  });

  describe('with the TLS certificate check off', () => {
    const insecure = config({ verifyTls: false });

    it("adds each language's option for it", () => {
      expect(generateSnippet(insecure, 'curl')).toContain('--insecure');
      expect(generateSnippet(insecure, 'python-requests')).toContain('verify=False');
      const axios = generateSnippet(insecure, 'js-axios');
      expect(axios).toContain("const https = require('https');");
      expect(axios).toContain('httpsAgent: new https.Agent({ rejectUnauthorized: false })');
      const go = generateSnippet(insecure, 'go');
      expect(go).toContain('"crypto/tls"');
      expect(go).toContain('InsecureSkipVerify: true');
    });

    it("notes that fetch can't do it", () => {
      expect(generateSnippet(insecure, 'js-fetch')).toMatch(/^\/\/ fetch can't skip TLS certificate checks/);
    });

    it('adds nothing when the check is on', () => {
      for (const language of ['curl', 'js-fetch', 'js-axios', 'python-requests', 'go'] as const) {
        const snippet = generateSnippet(config(), language);
        expect(snippet).not.toMatch(/insecure|verify=False|rejectUnauthorized|InsecureSkipVerify|crypto\/tls/i);
      }
    });
  });

  it('does not skip disabled headers or params', () => {
    const snippet = generateSnippet(
      config({
        params: [{ key: 'q', value: 'x', enabled: false }],
        headers: [{ key: 'X-Skip', value: 'y', enabled: false }],
      }),
      'curl',
    );
    expect(snippet).not.toContain('q=x');
    expect(snippet).not.toContain('X-Skip');
  });
});

describe('file bodies in every language', () => {
  const binary = config({ method: 'PUT', body: { mode: 'binary', binaryPath: '/data/photo.png' } });
  const form = config({
    method: 'POST',
    headers: [{ key: 'Content-Type', value: 'multipart/form-data', enabled: true }],
    body: {
      mode: 'form-data',
      formData: [
        { key: 'note', value: 'hi', enabled: true },
        { key: 'photo', value: '', enabled: true, type: 'file', src: 'C:\\data\\photo.png' },
      ],
    },
  });

  it('reads the file with fs in fetch and axios, and builds FormData with a Blob for a file part', () => {
    expect(generateSnippet(binary, 'js-fetch')).toContain(`const fs = require('fs');`);
    expect(generateSnippet(binary, 'js-fetch')).toContain(`body: fs.readFileSync("/data/photo.png")`);
    expect(generateSnippet(binary, 'js-axios')).toContain(`data: fs.readFileSync("/data/photo.png")`);
    const fetchForm = generateSnippet(form, 'js-fetch');
    expect(fetchForm).toContain(`form.append("note", "hi");`);
    expect(fetchForm).toContain(
      `form.append("photo", new Blob([fs.readFileSync("C:\\\\data\\\\photo.png")]), "photo.png");`,
    );
    expect(fetchForm).toContain('body: form');
    // The multipart boundary comes from FormData, so the request's own Content-Type is left out.
    expect(fetchForm).not.toContain('multipart/form-data');
    expect(generateSnippet(form, 'js-axios')).toContain('data: form');
  });

  it('opens the file in Python, and sends form-data as multipart files=', () => {
    expect(generateSnippet(binary, 'python-requests')).toContain(`data=open("/data/photo.png", 'rb')`);
    const python = generateSnippet(form, 'python-requests');
    expect(python).toContain(
      `files=[("note", (None, "hi")), ("photo", ("photo.png", open("C:\\\\data\\\\photo.png", 'rb')))]`,
    );
    expect(python).not.toContain('multipart/form-data');
  });

  it('opens the file in Go, and writes form-data with a multipart.Writer', () => {
    const goBinary = generateSnippet(binary, 'go');
    expect(goBinary).toContain('body, _ := os.Open("/data/photo.png")');
    expect(goBinary).toContain('req, _ := http.NewRequest("PUT", "https://api.example.com/users", body)');
    // The file's type, as the engine sends it, in every language.
    expect(goBinary).toContain('req.Header.Set("Content-Type", "image/png")');
    for (const language of ['curl', 'js-fetch', 'js-axios', 'python-requests'] as const) {
      expect([language, generateSnippet(binary, language)]).toEqual([language, expect.stringContaining('image/png')]);
    }
    const goForm = generateSnippet(form, 'go');
    expect(goForm).toContain('"mime/multipart"');
    expect(goForm).toContain('form.WriteField("note", "hi")');
    expect(goForm).toContain('part, _ := form.CreateFormFile("photo", "photo.png")');
    expect(goForm).toContain('req.Header.Set("Content-Type", form.FormDataContentType())');
    expect(goForm).not.toContain('"multipart/form-data"');
  });

  it('writes text-only form-data as multipart too, not as a urlencoded string', () => {
    const textOnly = config({
      method: 'POST',
      body: { mode: 'form-data', formData: [{ key: 'a', value: '1', enabled: true }] },
    });
    expect(generateSnippet(textOnly, 'js-fetch')).toContain(`form.append("a", "1");`);
    expect(generateSnippet(textOnly, 'js-fetch')).not.toContain('fs');
    expect(generateSnippet(textOnly, 'python-requests')).toContain(`files=[("a", (None, "1"))]`);
    expect(generateSnippet(textOnly, 'go')).not.toContain('"os"');
  });
});
