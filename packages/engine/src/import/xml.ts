// A small namespace-aware XML parser for the documents importers read (WSDL
// and XML Schema): elements, attributes and text, with each element's
// namespace resolved and the prefixes in scope kept for resolving QName
// attribute values (`type="tns:Order"`). No DTDs or external entities: a
// DOCTYPE is skipped, and only the predefined and numeric entities are
// expanded.

export interface XmlElement {
  /** As written, with its prefix: `wsdl:operation`. */
  name: string;
  /** Without the prefix: `operation`. */
  local: string;
  /** The element's namespace URI, `''` for none. */
  ns: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text, joined (not its children's). */
  text: string;
  /** The prefixes in scope here (`''` is the default namespace). */
  scope: Record<string, string>;
}

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

const NAME = /[^\s/>=]+/y;
const ATTRIBUTE = /\s*([^\s/>=]+)\s*=\s*("[^"]*"|'[^']*')/y;

/** Parses a document and returns its root element. Throws `XmlError` for malformed XML. */
export function parseXml(text: string): XmlElement {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  const fail = (message: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new XmlError(`${message} (line ${line})`);
  };

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const chunk = text.slice(i, lt === -1 ? text.length : lt);
    if (chunk && stack.length > 0) stack.at(-1)!.text += decode(chunk);
    else if (chunk.trim() && stack.length === 0) {
      fail('Text outside the root element');
    }
    if (lt === -1) break;
    i = lt;

    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) fail('Unclosed comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) fail('Unclosed CDATA section');
      if (stack.length > 0) stack.at(-1)!.text += text.slice(i + 9, end);
      i = end + 3;
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) fail('Unclosed processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!', i)) {
      // A DOCTYPE, with any internal subset in brackets.
      let depth = 0;
      let j = i + 2;
      for (; j < text.length; j++) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        else if (text[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end === -1) fail('Unclosed end tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`Unexpected </${name}>`);
      i = end + 1;
    } else {
      NAME.lastIndex = i + 1;
      const nameMatch = NAME.exec(text);
      if (!nameMatch) fail('A tag without a name');
      const name = nameMatch![0];
      i = NAME.lastIndex;
      const attrs: Record<string, string> = {};
      for (;;) {
        ATTRIBUTE.lastIndex = i;
        const attribute = ATTRIBUTE.exec(text);
        if (!attribute) break;
        attrs[attribute[1]] = decode(attribute[2].slice(1, -1));
        i = ATTRIBUTE.lastIndex;
      }
      while (/\s/.test(text[i] ?? '')) i++;
      const selfClosing = text.startsWith('/>', i);
      if (!selfClosing && text[i] !== '>') fail(`Malformed tag <${name}>`);
      i += selfClosing ? 2 : 1;

      const parentScope = stack.at(-1)?.scope ?? {};
      let scope = parentScope;
      for (const [attr, value] of Object.entries(attrs)) {
        if (attr === 'xmlns' || attr.startsWith('xmlns:')) {
          if (scope === parentScope) scope = { ...parentScope };
          scope[attr === 'xmlns' ? '' : attr.slice(6)] = value;
        }
      }
      const colon = name.indexOf(':');
      const prefix = colon === -1 ? '' : name.slice(0, colon);
      const element: XmlElement = {
        name,
        local: colon === -1 ? name : name.slice(colon + 1),
        ns: scope[prefix] ?? '',
        attrs,
        children: [],
        text: '',
        scope,
      };
      if (stack.length > 0) stack.at(-1)!.children.push(element);
      else if (root) fail('More than one root element');
      else root = element;
      if (!selfClosing) stack.push(element);
    }
  }
  if (stack.length > 0) throw new XmlError(`<${stack.at(-1)!.name}> is never closed`);
  if (!root) throw new XmlError('No root element');
  return root;
}

/** A QName attribute value (`tns:Order`) as its namespace and local name, with the prefixes in scope at `element`. */
export function resolveQName(element: XmlElement, qname: string): { ns: string; local: string } {
  const colon = qname.indexOf(':');
  if (colon === -1) return { ns: element.scope[''] ?? '', local: qname };
  return { ns: element.scope[qname.slice(0, colon)] ?? '', local: qname.slice(colon + 1) };
}

/** The children of `element` with a namespace and local name. */
export function childrenNamed(element: XmlElement, ns: string, local: string): XmlElement[] {
  return element.children.filter((child) => child.ns === ns && child.local === local);
}

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`);
}
