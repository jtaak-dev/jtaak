import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { parse as parseYaml } from 'yaml';
import { createCollectionNode, createRequest } from '../storage/repository.js';
import { createResponseExample } from '../storage/examples.js';
import { saveApiSpec } from '../storage/specs.js';
import { exampleRequestFrom } from '../request/exampleRequest.js';
import type { HttpMethod, ImportResult, KeyValue, RequestBody, RequestConfig } from '../types.js';

// OpenAPI 3.x import (and the paths of a Swagger 2.0 document), from JSON or
// YAML: a request per operation, foldered by its first tag, its body from the
// schema's example, and the spec's own response examples as the request's
// examples. The spec is kept (storage/specs.ts) and each request names its
// operation (`source`), so a mock server can generate answers from the
// response schemas the examples don't cover. Shapes are kept loose: the
// document is untrusted input.

export interface OpenApiSchema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, OpenApiSchema>;
  additionalProperties?: boolean | OpenApiSchema;
  required?: string[];
  items?: OpenApiSchema;
  enum?: unknown[];
  const?: unknown;
  example?: unknown;
  examples?: unknown[];
  default?: unknown;
  nullable?: boolean;
  allOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  pattern?: string;
}
interface OpenApiParameter {
  name?: string;
  in?: 'query' | 'header' | 'path' | 'cookie' | 'body' | 'formData';
  example?: unknown;
  schema?: OpenApiSchema;
}
export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  example?: unknown;
  examples?: Record<string, { value?: unknown; summary?: string } | undefined>;
}
export interface OpenApiResponse {
  description?: string;
  content?: Record<string, OpenApiMediaType | undefined>;
  /** Swagger 2.0: one schema, and examples by media type. */
  schema?: OpenApiSchema;
  examples?: Record<string, unknown>;
}
export interface OpenApiOperation {
  summary?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { content?: Record<string, OpenApiMediaType | undefined> };
  responses?: Record<string, OpenApiResponse | undefined>;
  /** Swagger 2.0: the media types it answers with. */
  produces?: string[];
}
type OpenApiPathItem = Record<string, unknown> & { parameters?: OpenApiParameter[] };
export interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string };
  servers?: { url?: string; variables?: Record<string, { default?: string }> }[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  produces?: string[];
  paths?: Record<string, OpenApiPathItem | undefined>;
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** A spec's text as a document: JSON, or else YAML. */
export function parseOpenApiText(text: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = parseYaml(text, { maxAliasCount: 1000 });
    } catch (error) {
      throw new Error(`This isn't an OpenAPI document in JSON or YAML: ${(error as Error).message}`, { cause: error });
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error("This isn't an OpenAPI document: it should be an object with `openapi` and `paths`.");
  }
  return parsed as OpenApiDocument;
}

function pointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) return undefined; // Other files aren't followed.
  let node: unknown = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * A document with its local `$ref`s (`#/components/schemas/User`) replaced by
 * what they point at. A reference back into itself (a tree of nodes) becomes
 * `{}` at the second visit; a reference to another file stays as it is.
 */
export function resolveOpenApiRefs<T>(document: T): T {
  const resolve = (node: unknown, seen: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => resolve(item, seen));
    if (!node || typeof node !== 'object') return node;
    const ref = (node as { $ref?: unknown }).$ref;
    if (typeof ref === 'string' && ref.startsWith('#')) {
      if (seen.has(ref)) return {};
      const target = pointer(document, ref);
      return target === undefined ? {} : resolve(target, new Set([...seen, ref]));
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolve(value, seen)]));
  };
  return resolve(document, new Set()) as T;
}

/** The base URL: the first server's (its `{variables}` at their defaults), or Swagger 2.0's scheme, host and base path. */
function baseUrlOf(root: OpenApiDocument): string {
  const server = root.servers?.[0];
  if (server?.url) {
    return server.url.replace(/\{([^}]+)\}/g, (match, name: string) => server.variables?.[name]?.default ?? match);
  }
  if (root.host) return `${root.schemes?.[0] ?? 'https'}://${root.host}${root.basePath ?? ''}`;
  return root.basePath ?? '';
}

/** Builds a minimal example value from a JSON Schema fragment: a plausible body to edit, not a full generator. */
function exampleFromSchema(schema: OpenApiSchema | undefined, depth = 0): unknown {
  if (!schema || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  const composed = schema.allOf ?? schema.oneOf ?? schema.anyOf;
  if (composed?.length && !schema.type) {
    if (schema.allOf) {
      return Object.assign(
        {},
        ...schema.allOf.map((part) => {
          const value = exampleFromSchema(part, depth + 1);
          return value && typeof value === 'object' ? value : {};
        }),
      );
    }
    return exampleFromSchema(composed[0], depth + 1);
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  switch (type ?? (schema.properties ? 'object' : undefined)) {
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
        obj[key] = exampleFromSchema(propSchema, depth + 1);
      }
      return obj;
    }
    case 'array':
      return [exampleFromSchema(schema.items, depth + 1)];
    case 'string':
      return '';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

const isJson = (mediaType: string) => /[/+]json\b/i.test(mediaType);

function convertOperation(
  baseUrl: string,
  path: string,
  method: HttpMethod,
  operation: OpenApiOperation,
  shared: OpenApiParameter[],
): RequestConfig {
  // OpenAPI path templating ({id}) maps directly to this engine's variable
  // syntax ({{id}}), so an imported request is usable as soon as the user
  // sets that variable in an environment.
  const templatedPath = path.replace(/\{([^}]+)\}/g, '{{$1}}');

  // Path-level parameters apply to every operation; the operation's own win.
  const byPlace = new Map<string, OpenApiParameter>();
  for (const param of [...shared, ...(operation.parameters ?? [])]) {
    if (param?.name) byPlace.set(`${param.in}:${param.name}`, param);
  }
  const params: KeyValue[] = [];
  const headers: KeyValue[] = [];
  let swaggerBody: OpenApiSchema | undefined;
  for (const param of byPlace.values()) {
    const example = param.example ?? param.schema?.example ?? param.schema?.default;
    const value = example != null ? String(example) : '';
    if (param.in === 'query') params.push({ key: param.name!, value, enabled: true });
    else if (param.in === 'header') headers.push({ key: param.name!, value, enabled: true });
    else if (param.in === 'body') swaggerBody = param.schema;
  }

  let body: RequestBody = { mode: 'none' };
  const content = operation.requestBody?.content ?? {};
  const jsonType = Object.keys(content).find(isJson);
  const jsonContent = jsonType ? content[jsonType] : undefined;
  if (jsonContent) {
    const example =
      jsonContent.example ??
      Object.values(jsonContent.examples ?? {}).find((e) => e?.value !== undefined)?.value ??
      exampleFromSchema(jsonContent.schema);
    body = { mode: 'json', raw: JSON.stringify(example, null, 2) };
  } else if (swaggerBody) {
    body = { mode: 'json', raw: JSON.stringify(exampleFromSchema(swaggerBody), null, 2) };
  }

  return {
    id: randomUUID(),
    name: operation.summary || operation.operationId || `${method} ${path}`,
    method,
    url: `${baseUrl}${templatedPath}`,
    params,
    headers,
    body,
    auth: { type: 'none' },
  };
}

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** A response code as a status: `404`, `2XX` as 200; `default` isn't one. */
export function openApiStatus(code: string): number | undefined {
  const exact = /^([1-5]\d\d)$/.exec(code.trim());
  if (exact) return Number(exact[1]);
  const range = /^([1-5])XX$/i.exec(code.trim());
  return range ? Number(range[1]) * 100 : undefined;
}

export function reasonPhrase(status: number): string {
  return REASONS[status] ?? '';
}

/** An example value as a response body: JSON pretty-printed, text as it is. */
function bodyText(value: unknown, mediaType: string): string {
  if (typeof value === 'string' && !isJson(mediaType)) return value;
  return JSON.stringify(value, null, 2);
}

/** The examples an operation's spec gives for its responses: each with its status, media type and value. */
export function openApiResponseExamples(
  operation: OpenApiOperation,
  produces: string[] = [],
): { status: number; mediaType: string; name?: string; value: unknown }[] {
  const found: { status: number; mediaType: string; name?: string; value: unknown }[] = [];
  for (const [code, response] of Object.entries(operation.responses ?? {})) {
    const status = openApiStatus(code);
    if (!status || !response) continue;
    for (const [mediaType, media] of Object.entries(response.content ?? {})) {
      if (!media) continue;
      if (media.example !== undefined) found.push({ status, mediaType, value: media.example });
      for (const [name, example] of Object.entries(media.examples ?? {})) {
        if (example?.value !== undefined) found.push({ status, mediaType, name, value: example.value });
      }
      if (media.example === undefined && !media.examples && media.schema?.example !== undefined) {
        found.push({ status, mediaType, value: media.schema.example });
      }
    }
    // Swagger 2.0: examples by media type.
    for (const [mediaType, value] of Object.entries(response.examples ?? {})) {
      found.push({ status, mediaType: mediaType || produces[0] || 'application/json', value });
    }
  }
  return found;
}

/** An operation of a resolved document, by `METHOD /path` (RequestSource.operation). */
export function openApiOperation(document: OpenApiDocument, operation: string): OpenApiOperation | undefined {
  const at = operation.indexOf(' ');
  if (at < 0) return undefined;
  const method = operation.slice(0, at).toLowerCase();
  const pathItem = document.paths?.[operation.slice(at + 1)];
  const found = pathItem?.[method];
  return found && typeof found === 'object' ? (found as OpenApiOperation) : undefined;
}

export interface ImportOpenApiOptions {
  /** Where it came from (a URL or a file path): kept with the spec. */
  location?: string;
}

/**
 * Imports an OpenAPI 3.x (or Swagger 2.0) document, given as text (JSON or
 * YAML) or already parsed. Keeps it as the workspace's spec, links each
 * request to its operation, and makes the spec's response examples the
 * requests' examples (the first of the lowest 2xx status the default).
 */
export function importOpenApi(
  db: Database.Database,
  workspaceId: string,
  spec: unknown,
  options: ImportOpenApiOptions = {},
): ImportResult {
  const text = typeof spec === 'string' ? spec : JSON.stringify(spec, null, 2);
  const parsed = typeof spec === 'string' ? parseOpenApiText(spec) : (spec as OpenApiDocument);
  if (!parsed || typeof parsed !== 'object') throw new Error("This isn't an OpenAPI document.");
  const root = resolveOpenApiRefs(parsed);
  const baseUrl = baseUrlOf(root);
  const counts = { folders: 0, requests: 0, examples: 0 };
  const title = root.info?.title ?? 'Imported API';

  return db.transaction(() => {
    const kept = saveApiSpec(db, {
      workspaceId,
      kind: 'openapi',
      name: title,
      location: options.location,
      source: text,
    });
    const collection = createCollectionNode(db, { workspaceId, parentFolderId: null, name: title, kind: 'collection' });
    const folderIdByTag = new Map<string, string>();

    for (const [path, pathItem] of Object.entries(root.paths ?? {})) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const [methodKey, value] of Object.entries(pathItem)) {
        const method = methodKey.toUpperCase();
        if (!value || typeof value !== 'object' || !HTTP_METHODS.includes(method as HttpMethod)) continue;
        const operation = value as OpenApiOperation;

        const config: RequestConfig = {
          ...convertOperation(baseUrl, path, method as HttpMethod, operation, pathItem.parameters ?? []),
          source: { specId: kept.id, operation: `${method} ${path}` },
        };

        const tag = operation.tags?.[0];
        let parentId = collection.id;
        if (tag) {
          let folderId = folderIdByTag.get(tag);
          if (!folderId) {
            counts.folders++;
            folderId = createCollectionNode(db, {
              workspaceId,
              parentFolderId: collection.id,
              name: tag,
              kind: 'folder',
            }).id;
            folderIdByTag.set(tag, folderId);
          }
          parentId = folderId;
        }

        counts.requests++;
        const request = createRequest(db, { collectionId: parentId, name: config.name, config });

        // The spec's examples answer any request to the operation: they match on its method and path only.
        const examples = openApiResponseExamples(operation, operation.produces ?? root.produces).sort(
          (a, b) => a.status - b.status,
        );
        const firstSuccess = examples.find((e) => e.status >= 200 && e.status < 300);
        const exampleRequest = exampleRequestFrom(config, {});
        for (const example of examples) {
          counts.examples++;
          createResponseExample(db, request.id, {
            name: `${example.status} ${example.mediaType}${example.name ? `: ${example.name}` : ''}`,
            status: example.status,
            statusText: reasonPhrase(example.status),
            headers: { 'Content-Type': example.mediaType },
            body: bodyText(example.value, example.mediaType),
            request: exampleRequest,
            ...(example === firstSuccess && { isDefault: true }),
          });
        }
      }
    }

    return {
      collectionId: collection.id,
      folderCount: counts.folders,
      requestCount: counts.requests,
      specId: kept.id,
      exampleCount: counts.examples,
    };
  })();
}
