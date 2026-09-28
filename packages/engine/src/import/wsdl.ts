import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { createCollectionNode, createRequest } from '../storage/repository.js';
import { SOAP_ENVELOPE_NAMESPACES } from '../request/soap.js';
import { fetchFor } from '../request/tls.js';
import type { ImportResult, NetworkSettings, RequestConfig, SoapProtocolConfig } from '../types.js';
import { childrenNamed, escapeXml, parseXml, resolveQName, XmlError, type XmlElement } from './xml.js';

// WSDL 1.1 import: a service's operations as SOAP requests, each with its
// endpoint, SOAP version (from its binding), SOAPAction and a starting
// envelope built from the operation's input message and the XML Schema
// types it uses.

const WSDL = 'http://schemas.xmlsoap.org/wsdl/';
const SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD = 'http://www.w3.org/2001/XMLSchema';

/** A WSDL and the documents it imports (other WSDLs, schemas), by resolved location. */
export interface WsdlSource {
  /** Where the WSDL came from: a URL or a file path (relative imports are resolved against it). */
  location: string;
  documents: Record<string, string>;
  /** Imports that couldn't be read. */
  warnings?: string[];
}

/** A WSDL's requests: its services, each with a folder of requests per SOAP port (unnamed when there's one). */
export interface WsdlImport {
  name: string;
  services: { name: string; ports: { name?: string; requests: RequestConfig[] }[] }[];
  warnings: string[];
}

const MAX_DOCUMENTS = 50;

function isUrl(location: string): boolean {
  return /^[a-z][a-z\d+.-]+:\/\//i.test(location);
}

/** Where `relative` points from the document at `base`: a URL, or a file path. */
export function resolveLocation(base: string, relative: string): string {
  if (isUrl(relative) || !base) return relative;
  if (isUrl(base)) return new URL(relative, base).toString();
  return path.resolve(path.dirname(base), relative);
}

/** The locations a document imports or includes (WSDL imports, schema imports and includes). */
function referencesOf(root: XmlElement): string[] {
  const found: string[] = [];
  const visit = (element: XmlElement) => {
    if (element.ns === WSDL && element.local === 'import' && element.attrs.location) found.push(element.attrs.location);
    if (
      element.ns === XSD &&
      (element.local === 'import' || element.local === 'include' || element.local === 'redefine')
    ) {
      if (element.attrs.schemaLocation) found.push(element.attrs.schemaLocation);
    }
    element.children.forEach(visit);
  };
  visit(root);
  return found;
}

export interface LoadWsdlOptions {
  /** Reads a document: by default a URL is fetched (with `verifyTls` and `network`) and a path read from disk. */
  read?: (location: string) => Promise<string>;
  verifyTls?: boolean;
  network?: NetworkSettings;
}

/** Reads a WSDL document from a URL or a file. */
export async function readWsdlDocument(
  location: string,
  options: Pick<LoadWsdlOptions, 'verifyTls' | 'network'> = {},
): Promise<string> {
  if (location.startsWith('file:')) return readFile(fileURLToPath(location), 'utf8');
  if (!isUrl(location)) return readFile(location, 'utf8');
  const response = await fetchFor(options)(location, { headers: { Accept: 'text/xml, application/xml, */*' } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
  return response.text();
}

/**
 * Reads a WSDL from a URL or a file, with every document it imports or
 * includes (up to 50). The WSDL itself must be readable; an import that
 * isn't becomes a warning, and its operations or types are left out.
 */
export async function loadWsdl(location: string, options: LoadWsdlOptions = {}): Promise<WsdlSource> {
  const read = options.read ?? ((l: string) => readWsdlDocument(l, options));
  const documents: Record<string, string> = {};
  const warnings: string[] = [];
  const queue = [location];
  while (queue.length > 0 && Object.keys(documents).length < MAX_DOCUMENTS) {
    const next = queue.shift()!;
    if (next in documents) continue;
    let text: string;
    try {
      text = await read(next);
    } catch (error) {
      if (next === location)
        throw new Error(`Couldn't read the WSDL ${location}: ${(error as Error).message}`, { cause: error });
      warnings.push(`Couldn't read ${next}, which the WSDL imports: ${(error as Error).message}`);
      documents[next] = '';
      continue;
    }
    documents[next] = text;
    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch (error) {
      if (next === location) throw new Error(`The WSDL isn't valid XML: ${(error as Error).message}`, { cause: error });
      continue; // reported when it's read below
    }
    for (const reference of referencesOf(root)) queue.push(resolveLocation(next, reference));
  }
  return { location, documents, ...(warnings.length > 0 && { warnings }) };
}

// ---- Reading the WSDL -------------------------------------------------------

const key = (ns: string, local: string) => `${ns}\u0000${local}`;

interface Schema {
  element: XmlElement;
  targetNamespace: string;
  elementsQualified: boolean;
  attributesQualified: boolean;
}

interface Declaration {
  element: XmlElement;
  schema: Schema;
}

interface Model {
  messages: Map<string, XmlElement>;
  portTypes: Map<string, XmlElement>;
  bindings: Map<string, XmlElement>;
  services: XmlElement[];
  elements: Map<string, Declaration>;
  types: Map<string, Declaration>;
  groups: Map<string, Declaration>;
  attributeGroups: Map<string, Declaration>;
  /** A prefix the WSDL itself uses for each namespace. */
  prefixes: Map<string, string>;
  definitionsName?: string;
  warnings: string[];
}

function addSchema(model: Model, element: XmlElement, seen: Set<XmlElement>): void {
  if (seen.has(element)) return;
  seen.add(element);
  const schema: Schema = {
    element,
    targetNamespace: element.attrs.targetNamespace ?? '',
    elementsQualified: element.attrs.elementFormDefault === 'qualified',
    attributesQualified: element.attrs.attributeFormDefault === 'qualified',
  };
  const tables: Record<string, Map<string, Declaration>> = {
    element: model.elements,
    complexType: model.types,
    simpleType: model.types,
    group: model.groups,
    attributeGroup: model.attributeGroups,
  };
  for (const child of element.children) {
    const table = child.ns === XSD ? tables[child.local] : undefined;
    if (table && child.attrs.name) table.set(key(schema.targetNamespace, child.attrs.name), { element: child, schema });
  }
}

function buildModel(source: WsdlSource): Model {
  const model: Model = {
    messages: new Map(),
    portTypes: new Map(),
    bindings: new Map(),
    services: [],
    elements: new Map(),
    types: new Map(),
    groups: new Map(),
    attributeGroups: new Map(),
    prefixes: new Map(),
    warnings: [...(source.warnings ?? [])],
  };
  const seenSchemas = new Set<XmlElement>();
  let main = true;
  const order = [source.location, ...Object.keys(source.documents).filter((l) => l !== source.location)];
  for (const location of order) {
    const text = source.documents[location];
    if (!text) continue;
    let root: XmlElement;
    try {
      root = parseXml(text);
    } catch (error) {
      if (main) throw error;
      model.warnings.push(`${location} isn't valid XML (${(error as XmlError).message}); left out.`);
      continue;
    }
    for (const [prefix, ns] of Object.entries(root.scope)) {
      if (prefix && !model.prefixes.has(ns)) model.prefixes.set(ns, prefix);
    }
    if (root.ns === XSD && root.local === 'schema') {
      addSchema(model, root, seenSchemas);
    } else if (root.ns === WSDL && root.local === 'definitions') {
      if (main) model.definitionsName = root.attrs.name;
      const tns = root.attrs.targetNamespace ?? '';
      for (const child of root.children) {
        if (child.ns !== WSDL) continue;
        const name = child.attrs.name;
        if (child.local === 'types') {
          for (const schema of childrenNamed(child, XSD, 'schema')) addSchema(model, schema, seenSchemas);
        } else if (child.local === 'message' && name) model.messages.set(key(tns, name), child);
        else if (child.local === 'portType' && name) model.portTypes.set(key(tns, name), child);
        else if (child.local === 'binding' && name) model.bindings.set(key(tns, name), child);
        else if (child.local === 'service') model.services.push(child);
      }
    } else if (main) {
      throw new Error(
        root.local === 'description'
          ? 'This is a WSDL 2.0 document; only WSDL 1.1 is supported.'
          : `This isn't a WSDL: its root element is <${root.name}>.`,
      );
    }
    main = false;
  }
  return model;
}

// ---- Sample XML from the schema ---------------------------------------------

const SAMPLES: Record<string, string> = {
  boolean: 'false',
  decimal: '0.0',
  float: '0.0',
  double: '0.0',
  integer: '0',
  int: '0',
  long: '0',
  short: '0',
  byte: '0',
  nonNegativeInteger: '0',
  nonPositiveInteger: '0',
  positiveInteger: '1',
  negativeInteger: '-1',
  unsignedLong: '0',
  unsignedInt: '0',
  unsignedShort: '0',
  unsignedByte: '0',
  dateTime: '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  time: '00:00:00',
  duration: 'P0D',
  gYear: '2026',
  gYearMonth: '2026-01',
  gMonth: '--01',
  gMonthDay: '--01-01',
  gDay: '---01',
  base64Binary: '',
  hexBinary: '',
};

const MAX_DEPTH = 12;

class SampleWriter {
  readonly namespaces = new Map<string, string>();
  constructor(private readonly model: Model) {}

  prefixFor(ns: string): string {
    let prefix = this.namespaces.get(ns);
    if (prefix) return prefix;
    const wsdlPrefix = this.model.prefixes.get(ns);
    const taken = new Set([...this.namespaces.values(), 'soap', 'xml', 'xmlns']);
    prefix =
      wsdlPrefix && /^[A-Za-z_][\w.-]*$/.test(wsdlPrefix) && !taken.has(wsdlPrefix)
        ? wsdlPrefix
        : `ns${this.namespaces.size + 1}`;
    while (taken.has(prefix)) prefix = `ns${Number(prefix.slice(2)) + 1}`;
    this.namespaces.set(ns, prefix);
    return prefix;
  }

  private qualified(ns: string, local: string): string {
    return ns ? `${this.prefixFor(ns)}:${local}` : local;
  }

  /** Lines for an element declaration (`xsd:element`), global or local. */
  element(decl: XmlElement, schema: Schema, indent: string, path: string[], global = false): string[] {
    if (decl.attrs.ref) {
      const ref = resolveQName(decl, decl.attrs.ref);
      const target = this.model.elements.get(key(ref.ns, ref.local));
      const lines = target
        ? this.element(target.element, target.schema, indent, path, true)
        : [`${indent}<${this.qualified(ref.ns, ref.local)}>?</${this.qualified(ref.ns, ref.local)}>`];
      return [...this.occurrence(decl, indent), ...lines];
    }
    const name = decl.attrs.name ?? 'element';
    const form = decl.attrs.form;
    const inNamespace = global || form === 'qualified' || (form !== 'unqualified' && schema.elementsQualified);
    const tag = inNamespace ? this.qualified(schema.targetNamespace, name) : name;
    const lines = global ? [] : this.occurrence(decl, indent);
    const { attributes, children, text } = this.content(decl, schema, indent + '  ', path);
    const open = `<${tag}${attributes}`;
    if (children.length > 0) return [...lines, `${indent}${open}>`, ...children, `${indent}</${tag}>`];
    return [...lines, `${indent}${open}>${text}</${tag}>`];
  }

  private occurrence(decl: XmlElement, indent: string): string[] {
    const min = decl.attrs.minOccurs ?? '1';
    const max = decl.attrs.maxOccurs ?? '1';
    if (max === 'unbounded' || Number(max) > 1) {
      return [`${indent}<!--${min === '0' ? 'Zero' : min === '1' ? 'One' : min} or more:-->`];
    }
    return min === '0' ? [`${indent}<!--Optional:-->`] : [];
  }

  /** An element's attributes, child lines and text, from its type. */
  private content(
    decl: XmlElement,
    schema: Schema,
    indent: string,
    path: string[],
  ): { attributes: string; children: string[]; text: string } {
    const inline = decl.children.find((c) => c.ns === XSD && (c.local === 'complexType' || c.local === 'simpleType'));
    if (inline) return this.typeContent(inline, schema, indent, path);
    if (!decl.attrs.type) return { attributes: '', children: [], text: '?' };
    return this.namedTypeContent(resolveQName(decl, decl.attrs.type), indent, path);
  }

  private namedTypeContent(
    type: { ns: string; local: string },
    indent: string,
    path: string[],
  ): { attributes: string; children: string[]; text: string } {
    if (type.ns === XSD) return { attributes: '', children: [], text: SAMPLES[type.local] ?? '?' };
    const typeKey = key(type.ns, type.local);
    if (path.includes(typeKey) || path.length >= MAX_DEPTH) {
      return { attributes: '', children: [`${indent}<!--${type.local} (recursive), left out-->`], text: '' };
    }
    const found = this.model.types.get(typeKey);
    if (!found) return { attributes: '', children: [], text: '?' };
    return this.typeContent(found.element, found.schema, indent, [...path, typeKey]);
  }

  private typeContent(
    type: XmlElement,
    schema: Schema,
    indent: string,
    path: string[],
  ): { attributes: string; children: string[]; text: string } {
    if (type.local === 'simpleType') return { attributes: '', children: [], text: this.simpleSample(type, path) };
    let attributes = '';
    const children: string[] = [];
    let text = '';
    for (const part of type.children) {
      if (part.ns !== XSD) continue;
      if (part.local === 'sequence' || part.local === 'all' || part.local === 'choice' || part.local === 'group') {
        children.push(...this.particle(part, schema, indent, path));
      } else if (part.local === 'attribute' || part.local === 'attributeGroup') {
        attributes += this.attributes(part, schema, path);
      } else if (part.local === 'complexContent' || part.local === 'simpleContent') {
        const derivation = part.children.find(
          (c) => c.ns === XSD && (c.local === 'extension' || c.local === 'restriction'),
        );
        if (!derivation) continue;
        if (derivation.local === 'extension' && derivation.attrs.base) {
          const base = this.namedTypeContent(resolveQName(derivation, derivation.attrs.base), indent, path);
          attributes += base.attributes;
          children.push(...base.children);
          text = base.text;
        } else if (part.local === 'simpleContent' && derivation.attrs.base) {
          text = this.namedTypeContent(resolveQName(derivation, derivation.attrs.base), indent, path).text;
        }
        const own = this.typeContent(derivation, schema, indent, path);
        attributes += own.attributes;
        children.push(...own.children);
      }
    }
    return { attributes, children, text: children.length > 0 ? '' : text };
  }

  /** A sequence, all, choice or group reference's elements. */
  private particle(part: XmlElement, schema: Schema, indent: string, path: string[]): string[] {
    if (part.local === 'group') {
      if (!part.attrs.ref)
        return part.children.flatMap((c) => (c.ns === XSD ? this.particle(c, schema, indent, path) : []));
      const ref = resolveQName(part, part.attrs.ref);
      const group = this.model.groups.get(key(ref.ns, ref.local));
      return group
        ? group.element.children.flatMap((c) => (c.ns === XSD ? this.particle(c, group.schema, indent, path) : []))
        : [];
    }
    if (part.local === 'element') return this.element(part, schema, indent, path);
    if (part.local === 'any') return [`${indent}<!--Any element can go here-->`];
    if (part.local !== 'sequence' && part.local !== 'all' && part.local !== 'choice') return [];
    const members = part.children.filter(
      (c) => c.ns === XSD && ['element', 'sequence', 'choice', 'group', 'any'].includes(c.local),
    );
    if (part.local === 'choice' && members.length > 1) {
      return [
        `${indent}<!--A choice of ${members.length}; the first is shown-->`,
        ...this.particle(members[0], schema, indent, path),
      ];
    }
    return members.flatMap((member) => this.particle(member, schema, indent, path));
  }

  private attributes(part: XmlElement, schema: Schema, path: string[]): string {
    if (part.local === 'attributeGroup') {
      if (!part.attrs.ref) return '';
      const ref = resolveQName(part, part.attrs.ref);
      const group = this.model.attributeGroups.get(key(ref.ns, ref.local));
      return group
        ? group.element.children
            .filter((c) => c.ns === XSD && (c.local === 'attribute' || c.local === 'attributeGroup'))
            .map((c) => this.attributes(c, group.schema, path))
            .join('')
        : '';
    }
    if (part.attrs.use === 'prohibited') return '';
    const ref = part.attrs.ref ? resolveQName(part, part.attrs.ref) : undefined;
    const name = ref ? this.qualified(ref.ns, ref.local) : part.attrs.name;
    if (!name) return '';
    const qualified =
      !ref && (part.attrs.form === 'qualified' || (part.attrs.form !== 'unqualified' && schema.attributesQualified));
    const attrName = qualified ? this.qualified(schema.targetNamespace, name) : name;
    const inline = part.children.find((c) => c.ns === XSD && c.local === 'simpleType');
    const value =
      part.attrs.fixed ??
      part.attrs.default ??
      (inline
        ? this.simpleSample(inline, path)
        : part.attrs.type
          ? this.namedTypeContent(resolveQName(part, part.attrs.type), '', path).text
          : '?');
    return ` ${attrName}="${escapeXml(value)}"`;
  }

  private simpleSample(type: XmlElement, path: string[]): string {
    const restriction = type.children.find((c) => c.ns === XSD && c.local === 'restriction');
    if (!restriction) return '?';
    const enumeration = restriction.children.find((c) => c.ns === XSD && c.local === 'enumeration');
    if (enumeration?.attrs.value !== undefined) return escapeXml(enumeration.attrs.value);
    if (restriction.attrs.base)
      return this.namedTypeContent(resolveQName(restriction, restriction.attrs.base), '', path).text;
    const inner = restriction.children.find((c) => c.ns === XSD && c.local === 'simpleType');
    return inner ? this.simpleSample(inner, path) : '?';
  }
}

// ---- Operations as requests -------------------------------------------------

interface SoapBinding {
  version: SoapProtocolConfig['version'];
  ns: string;
  style: string;
  element: XmlElement;
  portType?: XmlElement;
}

function soapBinding(model: Model, binding: XmlElement): SoapBinding | undefined {
  const soap = binding.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === 'binding');
  if (!soap) return undefined;
  const type = binding.attrs.type ? resolveQName(binding, binding.attrs.type) : undefined;
  return {
    version: soap.ns === SOAP12 ? '1.2' : '1.1',
    ns: soap.ns,
    style: soap.attrs.style ?? 'document',
    element: binding,
    portType: type && model.portTypes.get(key(type.ns, type.local)),
  };
}

/** A message's parts, those `parts` (space-separated) names if given. */
function messageParts(model: Model, at: XmlElement, qname: string | undefined, only?: string): XmlElement[] {
  if (!qname) return [];
  const ref = resolveQName(at, qname);
  const message = model.messages.get(key(ref.ns, ref.local));
  if (!message) return [];
  const parts = childrenNamed(message, WSDL, 'part');
  const names = only?.trim().split(/\s+/);
  return names ? parts.filter((p) => names.includes(p.attrs.name ?? '')) : parts;
}

function partLines(
  writer: SampleWriter,
  model: Model,
  part: XmlElement,
  indent: string,
  unqualified: boolean,
): string[] {
  const noSchema: Schema = { element: part, targetNamespace: '', elementsQualified: false, attributesQualified: false };
  if (part.attrs.element) {
    const ref = resolveQName(part, part.attrs.element);
    const decl = model.elements.get(key(ref.ns, ref.local));
    if (decl) return writer.element(decl.element, decl.schema, indent, [], true);
    const tag = `${writer.prefixFor(ref.ns)}:${ref.local}`;
    return [`${indent}<${tag}>?</${tag}>`];
  }
  // A typed part: an element named after the part (unqualified, as rpc style has it).
  const decl: XmlElement = {
    ...part,
    local: 'element',
    ns: XSD,
    children: [],
    attrs: { name: part.attrs.name ?? 'part', ...(part.attrs.type && { type: part.attrs.type }) },
  };
  return writer.element(decl, { ...noSchema, elementsQualified: !unqualified }, indent, []);
}

function envelopeFor(
  model: Model,
  binding: SoapBinding,
  bindingOperation: XmlElement,
  operation: XmlElement,
  definitionsNs: string,
): string {
  const writer = new SampleWriter(model);
  const soapOperation = bindingOperation.children.find((c) => c.ns === binding.ns && c.local === 'operation');
  const style = soapOperation?.attrs.style ?? binding.style;
  const input = childrenNamed(bindingOperation, WSDL, 'input')[0];
  const soapBody = input?.children.find((c) => c.ns === binding.ns && c.local === 'body');
  const inputMessage = childrenNamed(operation, WSDL, 'input')[0];
  const parts = messageParts(model, inputMessage ?? operation, inputMessage?.attrs.message, soapBody?.attrs.parts);

  const body: string[] = [];
  if (style === 'rpc') {
    const ns = soapBody?.attrs.namespace ?? definitionsNs;
    const tag = ns ? `${writer.prefixFor(ns)}:${operation.attrs.name}` : (operation.attrs.name ?? 'operation');
    const children = parts.flatMap((part) => partLines(writer, model, part, '      ', true));
    body.push(...(children.length > 0 ? [`    <${tag}>`, ...children, `    </${tag}>`] : [`    <${tag}/>`]));
  } else {
    for (const part of parts) body.push(...partLines(writer, model, part, '    ', true));
  }

  const header: string[] = [];
  for (const soapHeader of input?.children.filter((c) => c.ns === binding.ns && c.local === 'header') ?? []) {
    const [part] = messageParts(model, soapHeader, soapHeader.attrs.message, soapHeader.attrs.part);
    if (part) header.push(...partLines(writer, model, part, '    ', true));
  }

  const declarations = [...writer.namespaces].map(([ns, prefix]) => ` xmlns:${prefix}="${escapeXml(ns)}"`).join('');
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<soap:Envelope xmlns:soap="${SOAP_ENVELOPE_NAMESPACES[binding.version]}"${declarations}>`,
    ...(header.length > 0 ? ['  <soap:Header>', ...header, '  </soap:Header>'] : ['  <soap:Header/>']),
    '  <soap:Body>',
    ...body,
    '  </soap:Body>',
    '</soap:Envelope>',
  ].join('\n');
}

/**
 * A WSDL's SOAP operations as requests, without storing them: for each
 * service, a list of requests per SOAP port (SOAP 1.1 and 1.2 ports are
 * often both there). HTTP bindings and anything unreadable are skipped,
 * with a warning.
 */
export function wsdlRequests(source: WsdlSource | string): WsdlImport {
  const src: WsdlSource = typeof source === 'string' ? { location: '', documents: { '': source } } : source;
  let model: Model;
  try {
    model = buildModel(src);
  } catch (error) {
    if (error instanceof XmlError) throw new Error(`The WSDL isn't valid XML: ${error.message}`, { cause: error });
    throw error;
  }
  const main = parseXml(src.documents[src.location] ?? '');
  const definitionsNs = main.attrs.targetNamespace ?? '';
  const services: WsdlImport['services'] = [];

  for (const service of model.services) {
    const ports: WsdlImport['services'][number]['ports'] = [];
    for (const port of childrenNamed(service, WSDL, 'port')) {
      const address = port.children.find((c) => (c.ns === SOAP11 || c.ns === SOAP12) && c.local === 'address');
      const bindingName = port.attrs.binding ? resolveQName(port, port.attrs.binding) : undefined;
      const bindingElement = bindingName && model.bindings.get(key(bindingName.ns, bindingName.local));
      const binding = bindingElement && soapBinding(model, bindingElement);
      if (!address || !binding) {
        model.warnings.push(`Port "${port.attrs.name}" of "${service.attrs.name}" isn't a SOAP port; left out.`);
        continue;
      }
      if (!binding.portType) {
        model.warnings.push(`The operations of port "${port.attrs.name}" weren't found; left out.`);
        continue;
      }
      const operations = new Map(
        childrenNamed(binding.portType, WSDL, 'operation').map((operation) => [operation.attrs.name, operation]),
      );
      const requests: RequestConfig[] = [];
      for (const bindingOperation of childrenNamed(binding.element, WSDL, 'operation')) {
        const name = bindingOperation.attrs.name ?? 'operation';
        const operation = operations.get(name);
        if (!operation) continue;
        const soapOperation = bindingOperation.children.find((c) => c.ns === binding.ns && c.local === 'operation');
        requests.push({
          id: '',
          name,
          protocol: 'soap',
          method: 'POST',
          url: address.attrs.location ?? '',
          params: [],
          headers: [],
          body: { mode: 'raw', raw: envelopeFor(model, binding, bindingOperation, operation, definitionsNs) },
          auth: { type: 'none' },
          protocolConfig: { version: binding.version, action: soapOperation?.attrs.soapAction ?? '' },
        });
      }
      ports.push({ name: `${port.attrs.name ?? 'Port'} (SOAP ${binding.version})`, requests });
    }
    if (ports.length === 0) continue;
    services.push({
      name: service.attrs.name ?? 'Service',
      ports: ports.length === 1 ? [{ requests: ports[0].requests }] : ports,
    });
  }
  if (services.length === 0) throw new Error('The WSDL has no SOAP services to import.');
  return {
    name: services.length === 1 ? services[0].name : (model.definitionsName ?? services[0].name),
    services,
    warnings: model.warnings,
  };
}

/**
 * Imports a WSDL (see `loadWsdl` for one with imports) as a new collection
 * of SOAP requests, one per operation: named after the service (or the WSDL,
 * with a folder per service when it has several), with a folder per SOAP
 * port when a service has more than one.
 */
export function importWsdl(db: Database.Database, workspaceId: string, source: WsdlSource | string): ImportResult {
  const parsed = wsdlRequests(source);
  let folderCount = 0;
  let requestCount = 0;
  const collectionId = db.transaction(() => {
    const collection = createCollectionNode(db, {
      workspaceId,
      parentFolderId: null,
      name: parsed.name,
      kind: 'collection',
    });
    const folder = (parentFolderId: string, name: string) => {
      folderCount++;
      return createCollectionNode(db, { workspaceId, parentFolderId, name, kind: 'folder' }).id;
    };
    for (const service of parsed.services) {
      const serviceId = parsed.services.length > 1 ? folder(collection.id, service.name) : collection.id;
      for (const port of service.ports) {
        const portId = port.name ? folder(serviceId, port.name) : serviceId;
        for (const config of port.requests) {
          requestCount++;
          createRequest(db, { collectionId: portId, name: config.name, config });
        }
      }
    }
    return collection.id;
  })();
  return { collectionId, folderCount, requestCount, ...(parsed.warnings.length > 0 && { warnings: parsed.warnings }) };
}
