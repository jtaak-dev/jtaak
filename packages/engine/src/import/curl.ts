import type { HttpMethod, KeyValue, RequestConfig } from '../types.js';

/** Splits a curl command into tokens, respecting single- and double-quoted
 * strings (including escaped quotes) so header values containing spaces
 * don't get split apart. */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (quote) {
      if (char === '\\' && quote === '"' && i + 1 < command.length) {
        current += command[++i];
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else if (char === '\\' && command[i + 1] === '\n') {
      i++; // line continuation
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function parseHeader(value: string): KeyValue {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex === -1) return { key: value.trim(), value: '', enabled: true };
  return { key: value.slice(0, separatorIndex).trim(), value: value.slice(separatorIndex + 1).trim(), enabled: true };
}

/**
 * Parses a `curl ...` command copied from a browser's devtools or another
 * tool into a `RequestConfig`. Covers the common flags real-world curl
 * commands actually use — not a full curl CLI reimplementation.
 */
export function parseCurlCommand(command: string): RequestConfig {
  const tokens = tokenize(command.trim()).filter((t) => t !== 'curl');

  let url = '';
  let method: HttpMethod | undefined;
  const headers: KeyValue[] = [];
  let rawBody: string | undefined;
  let basicAuth: { username: string; password: string } | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    switch (token) {
      case '-X':
      case '--request':
        method = tokens[++i]?.toUpperCase() as HttpMethod;
        break;
      case '-H':
      case '--header':
        headers.push(parseHeader(tokens[++i] ?? ''));
        break;
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
        rawBody = tokens[++i];
        break;
      case '-u':
      case '--user': {
        const [username = '', password = ''] = (tokens[++i] ?? '').split(':');
        basicAuth = { username, password };
        break;
      }
      case '-b':
      case '--cookie':
        headers.push({ key: 'Cookie', value: tokens[++i] ?? '', enabled: true });
        break;
      case '-A':
      case '--user-agent':
        headers.push({ key: 'User-Agent', value: tokens[++i] ?? '', enabled: true });
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      case '-k':
      case '--insecure':
      case '-s':
      case '--silent':
      case '-v':
      case '--verbose':
      case '-L':
      case '--location':
        break; // flags with no effect on the request shape itself
      default:
        if (!token.startsWith('-') && url === '') url = token;
        break;
    }
  }

  return {
    id: 'imported-curl',
    name: 'Imported from cURL',
    method: method ?? (rawBody !== undefined ? 'POST' : 'GET'),
    url,
    params: [],
    headers,
    body: rawBody !== undefined ? { mode: 'raw', raw: rawBody } : { mode: 'none' },
    auth: basicAuth ? { type: 'basic', basic: basicAuth } : { type: 'none' },
  };
}
