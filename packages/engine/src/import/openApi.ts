import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createCollectionNode, createRequest } from '../storage/repository.js';
import type { HttpMethod, ImportResult, KeyValue, RequestBody, RequestConfig } from '../types.js';

// OpenAPI 3.x shapes, kept loose (untrusted external JSON). YAML specs
// aren't supported — callers are expected to pass parsed JSON (most
// OpenAPI tooling can export either).
interface OpenApiSchema {
  type?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  example?: unknown;
  default?: unknown;
}
interface OpenApiParameter {
  name?: string;
  in?: 'query' | 'header' | 'path' | 'cookie';
  example?: unknown;
}
interface OpenApiRequestBody {
  content?: Record<string, { schema?: OpenApiSchema; example?: unknown }>;
}
interface OpenApiOperation {
  summary?: string;
  operationId?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
}
type OpenApiPathItem = Record<string, OpenApiOperation | undefined>;
interface OpenApiRoot {
  info?: { title?: string };
  servers?: { url?: string }[];
  paths?: Record<string, OpenApiPathItem>;
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** Builds a minimal example value from a JSON Schema fragment — enough to
 * give an imported request body a plausible shape to edit, not a full
 * JSON Schema example generator. */
function exampleFromSchema(schema: OpenApiSchema | undefined): unknown {
  if (!schema) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  switch (schema.type) {
    case 'object': {
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties ?? {})) obj[key] = exampleFromSchema(propSchema);
      return obj;
    }
    case 'array':
      return [exampleFromSchema(schema.items)];
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

function convertOperation(
  baseUrl: string,
  path: string,
  method: HttpMethod,
  operation: OpenApiOperation,
): RequestConfig {
  // OpenAPI path templating ({id}) maps directly to this engine's variable
  // syntax ({{id}}), so an imported request is usable as soon as the user
  // sets that variable in an environment.
  const templatedPath = path.replace(/\{([^}]+)\}/g, '{{$1}}');

  const params: KeyValue[] = [];
  const headers: KeyValue[] = [];
  for (const param of operation.parameters ?? []) {
    if (!param.name) continue;
    const value = param.example != null ? String(param.example) : '';
    if (param.in === 'query') params.push({ key: param.name, value, enabled: true });
    else if (param.in === 'header') headers.push({ key: param.name, value, enabled: true });
  }

  let body: RequestBody = { mode: 'none' };
  const jsonContent = operation.requestBody?.content?.['application/json'];
  if (jsonContent) {
    const example = jsonContent.example ?? exampleFromSchema(jsonContent.schema);
    body = { mode: 'json', raw: JSON.stringify(example, null, 2) };
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

export function importOpenApi(db: Database.Database, workspaceId: string, openApiJson: unknown): ImportResult {
  const root = openApiJson as OpenApiRoot;
  const baseUrl = root.servers?.[0]?.url ?? '';
  const counts = { folders: 0, requests: 0 };

  const collectionId = db.transaction(() => {
    const collection = createCollectionNode(db, {
      workspaceId,
      parentFolderId: null,
      name: root.info?.title ?? 'Imported API',
      kind: 'collection',
    });
    const folderIdByTag = new Map<string, string>();

    for (const [path, pathItem] of Object.entries(root.paths ?? {})) {
      for (const [methodKey, operation] of Object.entries(pathItem)) {
        const method = methodKey.toUpperCase();
        if (!operation || !HTTP_METHODS.includes(method as HttpMethod)) continue;

        const config = convertOperation(baseUrl, path, method as HttpMethod, operation);

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
        createRequest(db, { collectionId: parentId, name: config.name, config });
      }
    }

    return collection.id;
  })();

  return { collectionId, folderCount: counts.folders, requestCount: counts.requests };
}
