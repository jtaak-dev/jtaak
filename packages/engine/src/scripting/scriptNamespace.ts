// Renames the global a script calls (`acme.test(...)` → `other.test(...)`),
// for moving scripts between applications whose EngineProfiles use different
// script namespaces. Pure and free of Node built-ins, so browser code can use it.
//
// A small tokenizer, not a parser: it knows enough JavaScript to skip string
// literals, template text, comments, regex literals and property names, and
// rewrites the namespace only where it's used as an object (followed by `.`,
// `?.` or `[`). It doesn't track scopes, so a local variable that shadows the
// namespace and is used the same way is renamed too.

const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;
const IDENTIFIER_START = /[\p{ID_Start}$_]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$‌‍]/u;
const DIGIT = /[0-9]/;
const WHITESPACE = /\s/;

const RESERVED_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

// Words after which an expression starts, so a `/` that follows begins a regex.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

/** True for a plain JavaScript identifier that isn't a reserved word, such as `jt` or `acme`. */
export function isScriptNamespace(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/**
 * What the previous significant token was:
 * - `value`: an identifier, number, literal or closing bracket, after which `/` divides;
 * - `dot`: `.` or `?.`, after which an identifier is a property name;
 * - `other`: anything else (operators, opening brackets, the start), after which `/` starts a regex.
 */
type Previous = 'value' | 'dot' | 'other';

/**
 * Rewrites uses of the global `from` as an object (`from.x`, `from?.x`,
 * `from[x]`) to `to`, leaving strings, template text (but not the
 * expressions inside `${…}`), comments, regex literals, property names
 * (`x.from`), object keys and longer identifiers alone. `count` is the
 * number of uses rewritten. Throws if either name isn't a JavaScript identifier.
 */
export function rewriteScriptNamespace(source: string, from: string, to: string): { source: string; count: number } {
  if (!isScriptNamespace(from)) throw new TypeError(`"${from}" is not a JavaScript identifier`);
  if (!isScriptNamespace(to)) throw new TypeError(`"${to}" is not a JavaScript identifier`);
  if (from === to || !source.includes(from)) return { source, count: 0 };

  const n = source.length;
  let out = '';
  let copied = 0;
  let count = 0;
  let i = 0;
  let previous: Previous = 'other';
  // Brace depth inside each open `${…}`, innermost last.
  const templates: number[] = [];

  /** Skips template text from `i`; true if it stopped at a `${`, false at the closing backtick (or the end). */
  const skipTemplateText = (): boolean => {
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        i += 2;
      } else if (c === '`') {
        i++;
        return false;
      } else if (c === '$' && source[i + 1] === '{') {
        i += 2;
        templates.push(0);
        return true;
      } else {
        i++;
      }
    }
    return false;
  };

  /** True if the text at `j`, after whitespace, is `.`, `?.` or `[`. */
  const followedByAccess = (j: number): boolean => {
    while (j < n && WHITESPACE.test(source[j])) j++;
    const c = source[j];
    if (c === '.' || c === '[') return true;
    return c === '?' && source[j + 1] === '.' && !DIGIT.test(source[j + 2] ?? '');
  };

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (WHITESPACE.test(c)) {
      i++;
    } else if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? n : end + 1;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && source[i] !== c && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i++;
      previous = 'value';
    } else if (c === '`') {
      i++;
      previous = skipTemplateText() ? 'other' : 'value';
    } else if (c === '{') {
      if (templates.length > 0) templates[templates.length - 1]++;
      i++;
      previous = 'other';
    } else if (c === '}') {
      i++;
      if (templates.length > 0 && templates[templates.length - 1] === 0) {
        templates.pop();
        previous = skipTemplateText() ? 'other' : 'value';
      } else {
        if (templates.length > 0) templates[templates.length - 1]--;
        previous = 'value';
      }
    } else if (c === ')' || c === ']') {
      i++;
      previous = 'value';
    } else if (c === '.' && DIGIT.test(next ?? '')) {
      i = skipNumber(source, i);
      previous = 'value';
    } else if (c === '.') {
      if (source.startsWith('...', i)) {
        i += 3;
        previous = 'other';
      } else {
        i++;
        previous = 'dot';
      }
    } else if (c === '?' && next === '.' && !DIGIT.test(source[i + 2] ?? '')) {
      i += 2;
      previous = 'dot';
    } else if ((c === '+' || c === '-') && next === c) {
      // `a++ / b` divides; `++/re/.lastIndex` is too unusual to matter.
      i += 2;
      if (previous !== 'value') previous = 'other';
    } else if (DIGIT.test(c)) {
      i = skipNumber(source, i);
      previous = 'value';
    } else if (c === '#' && IDENTIFIER_START.test(next ?? '')) {
      // A private name (`#acme`) is never the global.
      i = skipIdentifier(source, i + 1);
      previous = 'value';
    } else if (IDENTIFIER_START.test(c) || c === '\\') {
      const start = i;
      i = skipIdentifier(source, i);
      const word = source.slice(start, i);
      if (word === from && previous !== 'dot' && followedByAccess(i)) {
        out += source.slice(copied, start) + to;
        copied = i;
        count++;
      }
      previous = previous !== 'dot' && KEYWORDS_BEFORE_EXPRESSION.has(word) ? 'other' : 'value';
    } else if (c === '/' && previous !== 'value') {
      const end = regexEnd(source, i);
      if (end < 0) {
        i++;
        previous = 'other';
      } else {
        i = end;
        previous = 'value';
      }
    } else {
      i++;
      previous = 'other';
    }
  }

  return count === 0 ? { source, count } : { source: out + source.slice(copied), count };
}

function skipIdentifier(source: string, i: number): number {
  i++;
  while (i < source.length && (IDENTIFIER_PART.test(source[i]) || source[i] === '\\')) i++;
  return i;
}

/** Skips a numeric literal: decimal, hex/octal/binary, separators, exponent, BigInt suffix. */
function skipNumber(source: string, i: number): number {
  const hex = source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X');
  while (i < source.length) {
    const c = source[i];
    if (/[0-9A-Za-z_.]/.test(c)) {
      i++;
    } else if ((c === '+' || c === '-') && !hex && (source[i - 1] === 'e' || source[i - 1] === 'E')) {
      i++;
    } else {
      break;
    }
  }
  return i;
}

/** The index just past a regex literal starting at `i` (flags included), or -1 if it isn't closed on its line. */
function regexEnd(source: string, i: number): number {
  let inClass = false;
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j];
    if (c === '\n' || c === '\r') return -1;
    if (c === '\\') {
      j++;
    } else if (c === '[') {
      inClass = true;
    } else if (c === ']') {
      inClass = false;
    } else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < source.length && IDENTIFIER_PART.test(source[k])) k++;
      return k;
    }
  }
  return -1;
}
