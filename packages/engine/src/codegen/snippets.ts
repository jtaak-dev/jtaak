import type { CodegenLanguage, KeyValue, RequestConfig } from '../types.js';

export const CODEGEN_LANGUAGES: { id: CodegenLanguage; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'js-fetch', label: 'JavaScript (fetch)' },
  { id: 'js-axios', label: 'JavaScript (axios)' },
  { id: 'python-requests', label: 'Python (requests)' },
  { id: 'go', label: 'Go (net/http)' },
];

function enabled(items: KeyValue[]): KeyValue[] {
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
      .map((kv) => `${kv.key}=${kv.value}`)
      .join('&');
  }
  return undefined;
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

function generateCurl(config: RequestConfig): string {
  const lines = [`curl -X ${config.method} '${escapeSingleQuotes(fullUrl(config))}'`];
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
  const body = bodyString(config);
  if (body !== undefined) lines.push(`  -d '${escapeSingleQuotes(body)}'`);
  return lines.join(' \\\n');
}

function authHeaders(config: RequestConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.auth.type === 'bearer' && config.auth.bearer?.token)
    headers.Authorization = `Bearer ${config.auth.bearer.token}`;
  if (config.auth.type === 'apiKey' && config.auth.apiKey?.addTo === 'header')
    headers[config.auth.apiKey.key] = config.auth.apiKey.value;
  return headers;
}

function generateJsFetch(config: RequestConfig): string {
  const headers = {
    ...Object.fromEntries(enabled(config.headers).map((h) => [h.key, h.value])),
    ...authHeaders(config),
  };
  const isBasic = config.auth.type === 'basic' && config.auth.basic;
  if (isBasic)
    headers.Authorization = `Basic \${btoa('${config.auth.basic!.username}:${config.auth.basic!.password}')}`;

  const options: string[] = [`  method: '${config.method}'`];
  if (Object.keys(headers).length > 0)
    options.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`);
  const body = bodyString(config);
  if (body !== undefined) options.push(`  body: ${JSON.stringify(body)}`);

  return `fetch('${fullUrl(config)}', {\n${options.join(',\n')}\n})\n  .then((res) => res.json())\n  .then(console.log);`;
}

function generateJsAxios(config: RequestConfig): string {
  const headers = {
    ...Object.fromEntries(enabled(config.headers).map((h) => [h.key, h.value])),
    ...authHeaders(config),
  };
  const optionLines: string[] = [`  method: '${config.method.toLowerCase()}'`, `  url: '${fullUrl(config)}'`];
  if (Object.keys(headers).length > 0)
    optionLines.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`);
  if (config.auth.type === 'basic' && config.auth.basic) {
    optionLines.push(
      `  auth: { username: '${config.auth.basic.username}', password: '${config.auth.basic.password}' }`,
    );
  }
  const body = bodyString(config);
  if (body !== undefined) optionLines.push(`  data: ${JSON.stringify(body)}`);
  return `const axios = require('axios');\n\naxios({\n${optionLines.join(',\n')}\n}).then((res) => console.log(res.data));`;
}

function generatePythonRequests(config: RequestConfig): string {
  const headers = {
    ...Object.fromEntries(enabled(config.headers).map((h) => [h.key, h.value])),
    ...authHeaders(config),
  };
  const args = [`    '${fullUrl(config)}'`];
  if (Object.keys(headers).length > 0) args.push(`    headers=${JSON.stringify(headers)}`);
  if (config.auth.type === 'basic' && config.auth.basic) {
    args.push(`    auth=('${config.auth.basic.username}', '${config.auth.basic.password}')`);
  }
  const body = bodyString(config);
  if (body !== undefined) args.push(`    data=${JSON.stringify(body)}`);
  return `import requests\n\nresponse = requests.${config.method.toLowerCase()}(\n${args.join(',\n')},\n)\nprint(response.status_code)\nprint(response.json())`;
}

function generateGo(config: RequestConfig): string {
  const body = bodyString(config);
  const lines = ['package main', '', 'import (', '\t"fmt"', '\t"net/http"'];
  if (body !== undefined) lines.push('\t"strings"');
  lines.push(')', '', 'func main() {');
  if (body !== undefined) {
    lines.push(`\tbody := strings.NewReader(\`${body}\`)`);
    lines.push(`\treq, _ := http.NewRequest("${config.method}", "${fullUrl(config)}", body)`);
  } else {
    lines.push(`\treq, _ := http.NewRequest("${config.method}", "${fullUrl(config)}", nil)`);
  }
  for (const header of enabled(config.headers)) {
    lines.push(`\treq.Header.Set("${header.key}", "${header.value}")`);
  }
  if (config.auth.type === 'bearer' && config.auth.bearer?.token) {
    lines.push(`\treq.Header.Set("Authorization", "Bearer ${config.auth.bearer.token}")`);
  }
  if (config.auth.type === 'basic' && config.auth.basic) {
    lines.push(`\treq.SetBasicAuth("${config.auth.basic.username}", "${config.auth.basic.password}")`);
  }
  lines.push(
    '',
    '\tclient := &http.Client{}',
    '\tresp, _ := client.Do(req)',
    '\tdefer resp.Body.Close()',
    '\tfmt.Println(resp.Status)',
    '}',
  );
  return lines.join('\n');
}

export function generateSnippet(config: RequestConfig, language: CodegenLanguage): string {
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
