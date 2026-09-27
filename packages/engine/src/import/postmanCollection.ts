import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createCollectionNode, createRequest } from '../storage/repository.js';
import type { AuthConfig, HttpMethod, ImportResult, KeyValue, RequestBody, RequestConfig } from '../types.js';

// Postman Collection v2.1 shapes, kept deliberately loose (optional
// everywhere) since this is untrusted external JSON — we defend with
// fallbacks rather than validating a full schema.
interface PostmanKeyValue {
  key?: string;
  value?: string;
  disabled?: boolean;
}
interface PostmanUrl {
  raw?: string;
  query?: PostmanKeyValue[];
}
interface PostmanBody {
  mode?: 'raw' | 'urlencoded' | 'formdata' | 'file' | 'graphql';
  raw?: string;
  options?: { raw?: { language?: string } };
  urlencoded?: PostmanKeyValue[];
  formdata?: (PostmanKeyValue & { type?: string })[];
}
interface PostmanAuth {
  type?: string;
  bearer?: PostmanKeyValue[];
  basic?: PostmanKeyValue[];
  apikey?: PostmanKeyValue[];
}
interface PostmanEvent {
  listen?: string;
  script?: { exec?: string[] };
}
interface PostmanRequest {
  method?: string;
  header?: PostmanKeyValue[];
  url?: string | PostmanUrl;
  body?: PostmanBody;
  auth?: PostmanAuth;
}
interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: PostmanRequest;
  event?: PostmanEvent[];
  /** `strictSSL: false` is Postman's per-request "SSL certificate verification" off. */
  protocolProfileBehavior?: { strictSSL?: boolean };
}
interface PostmanCollectionRoot {
  info?: { name?: string };
  item?: PostmanItem[];
}

function findValue(list: PostmanKeyValue[] | undefined, key: string): string {
  return list?.find((entry) => entry.key === key)?.value ?? '';
}

function convertBody(body: PostmanBody | undefined): RequestBody {
  if (!body?.mode || body.mode === 'file' || body.mode === 'graphql') return { mode: 'none' };
  if (body.mode === 'raw') {
    const isJson = body.options?.raw?.language === 'json';
    return { mode: isJson ? 'json' : 'raw', raw: body.raw ?? '' };
  }
  if (body.mode === 'urlencoded') {
    return { mode: 'urlencoded', formData: toKeyValues(body.urlencoded) };
  }
  if (body.mode === 'formdata') {
    return { mode: 'form-data', formData: toKeyValues((body.formdata ?? []).filter((entry) => entry.type !== 'file')) };
  }
  return { mode: 'none' };
}

function toKeyValues(list: PostmanKeyValue[] | undefined): KeyValue[] {
  return (list ?? []).map((entry) => ({ key: entry.key ?? '', value: entry.value ?? '', enabled: !entry.disabled }));
}

function convertAuth(auth: PostmanAuth | undefined): AuthConfig {
  switch (auth?.type) {
    case 'bearer':
      return { type: 'bearer', bearer: { token: findValue(auth.bearer, 'token') } };
    case 'basic':
      return {
        type: 'basic',
        basic: { username: findValue(auth.basic, 'username'), password: findValue(auth.basic, 'password') },
      };
    case 'apikey':
      return {
        type: 'apiKey',
        apiKey: {
          key: findValue(auth.apikey, 'key'),
          value: findValue(auth.apikey, 'value'),
          addTo: findValue(auth.apikey, 'in') === 'query' ? 'query' : 'header',
        },
      };
    default:
      return { type: 'none' };
  }
}

function extractScripts(events: PostmanEvent[] | undefined): { preRequestScript?: string; testScript?: string } {
  const preRequest = events?.find((e) => e.listen === 'prerequest')?.script?.exec;
  const test = events?.find((e) => e.listen === 'test')?.script?.exec;
  return {
    preRequestScript: preRequest ? preRequest.join('\n') : undefined,
    testScript: test ? test.join('\n') : undefined,
  };
}

function convertRequest(item: PostmanItem): RequestConfig {
  const request = item.request ?? {};
  const method = (request.method ?? 'GET').toUpperCase() as HttpMethod;

  let url = '';
  let params: KeyValue[] = [];
  if (typeof request.url === 'string') {
    url = request.url;
  } else if (request.url) {
    url = request.url.raw ?? '';
    params = toKeyValues(request.url.query);
  }

  return {
    id: randomUUID(),
    name: item.name ?? `${method} ${url}`,
    method,
    url,
    params,
    headers: toKeyValues(request.header),
    body: convertBody(request.body),
    auth: convertAuth(request.auth),
    ...extractScripts(item.event),
    ...(item.protocolProfileBehavior?.strictSSL === false && { verifyTls: false }),
  };
}

/**
 * Note on import fidelity: script text is imported verbatim, not translated.
 * Postman's real scripting API (chai's `.to.` BDD chain, `pm.response.to.have.status()`,
 * etc.) is broader than this engine's sandbox (`pm.test`/`pm.expect(...).toX()`),
 * so an imported script may need editing before it runs here. The request
 * shape (method/url/headers/body/auth) imports fully.
 */
function importItems(
  db: Database.Database,
  workspaceId: string,
  parentId: string,
  items: PostmanItem[],
  counts: { folders: number; requests: number },
): void {
  for (const item of items) {
    if (Array.isArray(item.item)) {
      counts.folders++;
      const folder = createCollectionNode(db, {
        workspaceId,
        parentFolderId: parentId,
        name: item.name ?? 'Folder',
        kind: 'folder',
      });
      importItems(db, workspaceId, folder.id, item.item, counts);
    } else if (item.request) {
      counts.requests++;
      const config = convertRequest(item);
      createRequest(db, { collectionId: parentId, name: config.name, config });
    }
  }
}

export function importPostmanCollection(
  db: Database.Database,
  workspaceId: string,
  postmanJson: unknown,
): ImportResult {
  const collection = postmanJson as PostmanCollectionRoot;
  const counts = { folders: 0, requests: 0 };

  const collectionId = db.transaction(() => {
    const root = createCollectionNode(db, {
      workspaceId,
      parentFolderId: null,
      name: collection.info?.name ?? 'Imported Collection',
      kind: 'collection',
    });
    importItems(db, workspaceId, root.id, collection.item ?? [], counts);
    return root.id;
  })();

  return { collectionId, folderCount: counts.folders, requestCount: counts.requests };
}
