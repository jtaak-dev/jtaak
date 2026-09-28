import type { CodegenLanguage, FormField, KeyValue, RequestConfig } from '../types.js';
import { soapAsHttp } from '../request/soap.js';
import { mediaTypeFor } from '../request/mediaTypes.js';

export const CODEGEN_LANGUAGES: { id: CodegenLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'js-fetch', label: 'JavaScript (fetch)' },
  { id: 'js-axios', label: 'JavaScript (axios)' },
  { id: 'python-requests', label: 'Python (requests)' },
  { id: 'go', label: 'Go (net/http)' },
];

function enabled<T extends KeyValue>(items: T[]): T[] {
  return items.filter((item) => item.enabled && item.key.trim().length > 0);
}

/** Query params appended to the URL. Auth (apiKey-in-query) is intentionally
 * left out here — each generator decides how idiomatically to express auth. */
function fullUrl(config: RequestConfig): string {
  const params = enabled(config.params);
  if (params.length === 0) return config.url;
  const separator = config.url.includes('?') ? '&' : '?';
  const query = params.map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`).join('&');
  return `${config.url}${separator}${query}`;
}

function bodyString(config: RequestConfig): string | undefined {
  if (config.body.mode === 'none') return undefined;
  if (config.body.mode === 'raw' || config.body.mode === 'json') return config.body.raw ?? '';
  if (config.body.mode === 'urlencoded' || config.body.mode === 'form-data') {
    return enabled(config.body.formData ?? [])
      .filter((field) => field.type !== 'file')
      .map((kv) => `${kv.key}=${kv.value}`)
      .join('&');
  }
  return undefined;
}

/** A binary body's file, if the request sends one. */
function binaryPath(config: RequestConfig): string | undefined {
  return config.body.mode === 'binary' ? config.body.binaryPath || undefined : undefined;
}

/** A form-data body's enabled rows (text and files), or undefined for any other body. */
function formFields(config: RequestConfig): FormField[] | undefined {
  return config.body.mode === 'form-data' ? enabled(config.body.formData ?? []) : undefined;
}

/** A file's name, from a Windows or POSIX path. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** A binary body's Content-Type when the request sets none: from the file's extension, as the engine sends it. */
function binaryContentType(config: RequestConfig): string | undefined {
  const file = binaryPath(config);
  const set = enabled(config.headers).some((h) => h.key.toLowerCase() === 'content-type');
  return file && !set ? mediaTypeFor(file) : undefined;
}

/** Headers as sent: less a Content-Type a multipart body sets itself (with its boundary), plus a binary body's. */
function headersFor(config: RequestConfig, headers: Record<string, string>): Record<string, string> {
  const binaryType = binaryContentType(config);
  if (binaryType) return { ...headers, 'Content-Type': binaryType };
  if (!formFields(config)) return headers;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type'));
}

const quote = (value: string) => JSON.stringify(value);

/** Node code that builds a FormData body (`form`) for fetch or axios, reading files with `fs`. */
function jsFormData(fields: FormField[]): string[] {
  const lines = ['const form = new FormData();'];
  for (const field of fields) {
    if (field.type === 'file') {
      if (!field.src) continue;
      lines.push(
        `form.append(${quote(field.key)}, new Blob([fs.readFileSync(${quote(field.src)})]), ${quote(fileName(field.src))});`,
      );
    } else {
      lines.push(`form.append(${quote(field.key)}, ${quote(field.value)});`);
    }
  }
  return lines;
}

/** What JavaScript sends as the body (an expression), and the lines it needs first. */
function jsBody(config: RequestConfig): { before: string[]; body?: string } {
  const file = binaryPath(config);
  if (file) return { before: [`const fs = require('fs');`], body: `fs.readFileSync(${quote(file)})` };
  const fields = formFields(config);
  if (fields) {
    const usesFiles = fields.some((f) => f.type === 'file' && f.src);
    return { before: [...(usesFiles ? [`const fs = require('fs');`] : []), ...jsFormData(fields)], body: 'form' };
  }
  const body = bodyString(config);
  return { before: [], body: body === undefined ? undefined : quote(body) };
}

/** The request skips checking the server's TLS certificate (`RequestConfig.verifyTls`). */
function skipsTlsCheck(config: RequestConfig): boolean {
  return config.verifyTls === false;
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function generateCurl(config: RequestConfig): string {
  const lines = [`curl -X ${config.method} '${escapeSingleQuotes(fullUrl(config))}'`];
  if (skipsTlsCheck(config)) lines.push('  --insecure');
  for (const header of enabled(config.headers)) {
    lines.push(`  -H '${escapeSingleQuotes(`${header.key}: ${header.value}`)}'`);
  }
  if (config.auth.type === 'bearer' && config.auth.bearer?.token) {
    lines.push(`  -H '${escapeSingleQuotes(`Authorization: Bearer ${config.auth.bearer.token}`)}'`);
  }
  if (config.auth.type === 'basic' && config.auth.basic) {
    lines.push(`  -u '${escapeSingleQuotes(`${config.auth.basic.username}:${config.auth.basic.password}`)}'`);
  }
  if (config.auth.type === 'apiKey' && config.auth.apiKey?.addTo === 'header') {
    lines.push(`  -H '${escapeSingleQuotes(`${config.auth.apiKey.key}: ${config.auth.apiKey.value}`)}'`);
  }
  if (config.auth.type === 'digest' && config.auth.digest) {
    lines.push(
      `  --digest -u '${escapeSingleQuotes(`${config.auth.digest.username}:${config.auth.digest.password}`)}'`,
    );
  }
  const oauth2 = oauth2Header(config);
  if (oauth2) lines.push(`  -H '${escapeSingleQuotes(`Authorization: ${oauth2}`)}'`);
  if (config.body.mode === 'form-data') {
    for (const field of enabled(config.body.formData ?? [])) {
      const part = field.type === 'file' ? `${field.key}=@${field.src ?? ''}` : `${field.key}=${field.value}`;
      lines.push(`  -F '${escapeSingleQuotes(part)}'`);
    }
  }
  const body = config.body.mode === 'form-data' ? undefined : bodyString(config);
  if (body !== undefined) lines.push(`  -d '${escapeSingleQuotes(body)}'`);
  if (config.body.mode === 'binary' && config.body.binaryPath) {
    const type = binaryContentType(config);
    if (type) lines.push(`  -H 'Content-Type: ${type}'`);
    lines.push(`  --data-binary '@${escapeSingleQuotes(config.body.binaryPath)}'`);
  }
  return lines.join(' \\\n');
}

/** An OAuth 2.0 request's Authorization value: its token, or a placeholder for one. */
function oauth2Header(config: RequestConfig): string | undefined {
  const oauth2 = config.auth.type === 'oauth2' ? config.auth.oauth2 : undefined;
  if (!oauth2 || oauth2.addTo === 'query') return undefined;
  const prefix = oauth2.headerPrefix ?? 'Bearer';
  const token = oauth2.token?.accessToken ?? '<access token>';
  return prefix ? `${prefix} ${token}` : token;
}

function authHeaders(config: RequestConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  const oauth2 = oauth2Header(config);
  if (oauth2) headers.Authorization = oauth2;
  if (config.auth.type === 'bearer' && config.auth.bearer?.token)
    headers.Authorization = `Bearer ${config.auth.bearer.token}`;
  if (config.auth.type === 'apiKey' && config.auth.apiKey?.addTo === 'header')
    headers[config.auth.apiKey.key] = config.auth.apiKey.value;
  return headers;
}

function generateJsFetch(config: RequestConfig): string {
  const headers = headersFor(config, {
    ...Object.fromEntries(enabled(config.headers).map((h) => [h.key, h.value])),
    ...authHeaders(config),
  });
  const isBasic = config.auth.type === 'basic' && config.auth.basic;
  if (isBasic)
    headers.Authorization = `Basic \${btoa('${config.auth.basic!.username}:${config.auth.basic!.password}')}`;

  const options: string[] = [`  method: '${config.method}'`];
  if (Object.keys(headers).length > 0)
    options.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`);
  const { before, body } = jsBody(config);
  if (body !== undefined) options.push(`  body: ${body}`);

  // fetch has no option to skip certificate checks.
  const note = skipsTlsCheck(config)
    ? `// fetch can't skip TLS certificate checks. In Node, for testing only, run with\n// NODE_TLS_REJECT_UNAUTHORIZED=0.\n`
    : '';
  const prelude = before.length > 0 ? `${before.join('\n')}\n\n` : '';
  return `${note}${prelude}fetch('${fullUrl(config)}', {\n${options.join(',\n')}\n})\n  .then((res) => res.json())\n  .then(console.log);`;
}

function generateJsAxios(config: RequestConfig): string {
  const headers = headersFor(config, {
    ...Object.fromEntries(enabled(config.headers).map((h) => [h.key, h.value])),
    ...authHeaders(config),
  });
  const optionLines: string[] = [`  method: '${config.method.toLowerCase()}'`, `  url: '${fullUrl(config)}'`];
  if (Object.keys(headers).length > 0)
    optionLines.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`);
  if (config.auth.type === 'basic' && config.auth.basic) {
    optionLines.push(
      `  auth: { username: '${config.auth.basic.username}', password: '${config.auth.basic.password}' }`,
    );
  }
  const { before, body } = jsBody(config);
  if (body !== undefined) optionLines.push(`  data: ${body}`);
  const skip = skipsTlsCheck(config);
  if (skip) optionLines.push(`  httpsAgent: new https.Agent({ rejectUnauthorized: false })`);
  const requires = `const axios = require('axios');\n${skip ? `const https = require('https');\n` : ''}`;
  const prelude = before.length > 0 ? `${before.join('\n')}\n` : '';
  return `${requires}${prelude}\naxios({\n${optionLines.join(',\n')}\n}).then((res) => console.log(res.data));`;
}

function generatePythonRequests(config: RequestConfig): string {
  const headers = headersFor(config, {
    ...Object.fromEntries(enabled(config.headers).map((h) => [h.key, h.value])),
    ...authHeaders(config),
  });
  const args = [`    '${fullUrl(config)}'`];
  if (Object.keys(headers).length > 0) args.push(`    headers=${JSON.stringify(headers)}`);
  if (config.auth.type === 'basic' && config.auth.basic) {
    args.push(`    auth=('${config.auth.basic.username}', '${config.auth.basic.password}')`);
  }
  const file = binaryPath(config);
  const fields = formFields(config);
  if (file) {
    args.push(`    data=open(${quote(file)}, 'rb')`);
  } else if (fields) {
    // files= makes it multipart; (None, value) is a text part.
    const parts = fields.flatMap((field) =>
      field.type === 'file'
        ? field.src
          ? [`(${quote(field.key)}, (${quote(fileName(field.src))}, open(${quote(field.src)}, 'rb')))`]
          : []
        : [`(${quote(field.key)}, (None, ${quote(field.value)}))`],
    );
    args.push(`    files=[${parts.join(', ')}]`);
  } else {
    const body = bodyString(config);
    if (body !== undefined) args.push(`    data=${JSON.stringify(body)}`);
  }
  if (skipsTlsCheck(config)) args.push('    verify=False');
  return `import requests\n\nresponse = requests.${config.method.toLowerCase()}(\n${args.join(',\n')},\n)\nprint(response.status_code)\nprint(response.json())`;
}

function generateGo(config: RequestConfig): string {
  const file = binaryPath(config);
  const fields = formFields(config);
  const body = file || fields ? undefined : bodyString(config);
  const skip = skipsTlsCheck(config);
  const usesFiles = Boolean(fields?.some((f) => f.type === 'file' && f.src));
  const imports = new Set(['"fmt"', '"net/http"']);
  if (skip) imports.add('"crypto/tls"');
  if (body !== undefined) imports.add('"strings"');
  if (file) imports.add('"os"');
  if (fields) imports.add('"bytes"').add('"mime/multipart"');
  if (usesFiles) imports.add('"io"').add('"os"');
  const lines = ['package main', '', 'import (', ...[...imports].sort().map((i) => `\t${i}`), ')', '', 'func main() {'];
  const request = (reader: string) =>
    `\treq, _ := http.NewRequest(${quote(config.method)}, ${quote(fullUrl(config))}, ${reader})`;
  if (file) {
    lines.push(`\tbody, _ := os.Open(${quote(file)})`, '\tdefer body.Close()', request('body'));
  } else if (fields) {
    lines.push('\tvar body bytes.Buffer', '\tform := multipart.NewWriter(&body)');
    for (const field of fields) {
      if (field.type !== 'file') {
        lines.push(`\tform.WriteField(${quote(field.key)}, ${quote(field.value)})`);
      } else if (field.src) {
        lines.push(
          '\t{',
          `\t\tfile, _ := os.Open(${quote(field.src)})`,
          `\t\tpart, _ := form.CreateFormFile(${quote(field.key)}, ${quote(fileName(field.src))})`,
          '\t\tio.Copy(part, file)',
          '\t\tfile.Close()',
          '\t}',
        );
      }
    }
    lines.push('\tform.Close()', request('&body'), '\treq.Header.Set("Content-Type", form.FormDataContentType())');
  } else if (body !== undefined) {
    lines.push(`\tbody := strings.NewReader(\`${body}\`)`, request('body'));
  } else {
    lines.push(request('nil'));
  }
  for (const header of enabled(config.headers)) {
    if (fields && header.key.toLowerCase() === 'content-type') continue;
    lines.push(`\treq.Header.Set("${header.key}", "${header.value}")`);
  }
  const binaryType = binaryContentType(config);
  if (binaryType) lines.push(`\treq.Header.Set("Content-Type", ${quote(binaryType)})`);
  if (config.auth.type === 'bearer' && config.auth.bearer?.token) {
    lines.push(`\treq.Header.Set("Authorization", "Bearer ${config.auth.bearer.token}")`);
  }
  if (config.auth.type === 'basic' && config.auth.basic) {
    lines.push(`\treq.SetBasicAuth("${config.auth.basic.username}", "${config.auth.basic.password}")`);
  }
  lines.push(
    '',
    skip
      ? '\tclient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}'
      : '\tclient := &http.Client{}',
    '\tresp, _ := client.Do(req)',
    '\tdefer resp.Body.Close()',
    '\tfmt.Println(resp.Status)',
    '}',
  );
  return lines.join('\n');
}

export function generateSnippet(request: RequestConfig, language: CodegenLanguage): string {
  // A SOAP request is written as the HTTP POST it's sent as.
  const config = request.protocol === 'soap' ? soapAsHttp(request) : request;
  switch (language) {
    case 'curl':
      return generateCurl(config);
    case 'js-fetch':
      return generateJsFetch(config);
    case 'js-axios':
      return generateJsAxios(config);
    case 'python-requests':
      return generatePythonRequests(config);
    case 'go':
      return generateGo(config);
  }
}
