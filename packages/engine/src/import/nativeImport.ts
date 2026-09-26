import type Database from 'better-sqlite3';
import {
  createCollectionNode,
  createEnvironment,
  createMcpServerConnection,
  createRequest,
  createWebSocketConnection,
  listEnvironments,
  updateEnvironmentVariables,
  updateMcpServerConnection,
  updateWebSocketConnection,
} from '../storage/repository.js';
import {
  DEFAULT_ENGINE_PROFILE,
  NATIVE_EXPORT_VERSION,
  type NativeExportCollection,
  type NativeExportDocument,
  type NativeExportEnvironment,
  type NativeExportFolder,
  type NativeExportItem,
  type NativeImportOptions,
  type NativeImportPreview,
  type NativeImportResult,
  type AuthConfig,
  type CollectionCategory,
  type EngineProfile,
  type ExportScope,
  type HttpMethod,
  type KeyValue,
  type Protocol,
  type RequestBody,
  type RequestConfig,
} from '../types.js';

// ---- Validation --------------------------------------------------------------
//
// An export file is untrusted input (it came from someone else), so unlike
// the Postman importer's lenient fallbacks, every field the engine later relies
// on is checked here and rebuilt into a fresh object — nothing unexpected is
// carried through to storage. Errors name the exact path that failed.

class ValidationError extends Error {}

const MAX_DEPTH = 64;
const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PROTOCOLS: readonly Protocol[] = ['http', 'graphql', 'websocket', 'sse', 'grpc', 'mcp', 'soap'];
const BODY_MODES: readonly RequestBody['mode'][] = ['none', 'raw', 'json', 'form-data', 'urlencoded', 'binary'];
const AUTH_TYPES: readonly AuthConfig['type'][] = ['none', 'basic', 'bearer', 'apiKey'];
const CATEGORIES: readonly CollectionCategory[] = ['api', 'websocket', 'mcp'];
const SCOPES: readonly ExportScope[] = ['collection', 'category', 'workspace'];
const ITEM_TYPE_BY_CATEGORY: Record<CollectionCategory, NativeExportItem['type']> = {
  api: 'request',
  websocket: 'websocket',
  mcp: 'mcp',
};

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, 'expected an object');
  return value;
}

function arr(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  return value;
}

function name(value: unknown, path: string): string {
  const s = str(value, path).trim();
  if (!s) fail(path, 'must not be empty');
  return s;
}

function optStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, `expected one of ${allowed.join(', ')}`);
  return value as T;
}

function strList(value: unknown, path: string): string[] {
  return value === undefined ? [] : arr(value, path).map((v, i) => str(v, `${path}[${i}]`));
}

function keyValues(value: unknown, path: string): KeyValue[] {
  if (value === undefined) return [];
  return arr(value, path).map((entry, i) => {
    const p = `${path}[${i}]`;
    const kv = obj(entry, p);
    return { key: str(kv.key, `${p}.key`), value: str(kv.value ?? '', `${p}.value`), enabled: kv.enabled !== false };
  });
}

function auth(value: unknown, path: string): AuthConfig {
  if (value === undefined) return { type: 'none' };
  const a = obj(value, path);
  const out: AuthConfig = { type: oneOf(a.type, AUTH_TYPES, `${path}.type`) };
  if (a.basic !== undefined) {
    const b = obj(a.basic, `${path}.basic`);
    out.basic = {
      username: str(b.username ?? '', `${path}.basic.username`),
      password: str(b.password ?? '', `${path}.basic.password`),
    };
  }
  if (a.bearer !== undefined) {
    out.bearer = { token: str(obj(a.bearer, `${path}.bearer`).token ?? '', `${path}.bearer.token`) };
  }
  if (a.apiKey !== undefined) {
    const k = obj(a.apiKey, `${path}.apiKey`);
    out.apiKey = {
      key: str(k.key ?? '', `${path}.apiKey.key`),
      value: str(k.value ?? '', `${path}.apiKey.value`),
      addTo: oneOf(k.addTo ?? 'header', ['header', 'query'] as const, `${path}.apiKey.addTo`),
    };
  }
  return out;
}

function body(value: unknown, path: string): RequestBody {
  if (value === undefined) return { mode: 'none' };
  const b = obj(value, path);
  const out: RequestBody = { mode: oneOf(b.mode, BODY_MODES, `${path}.mode`) };
  const raw = optStr(b.raw, `${path}.raw`);
  if (raw !== undefined) out.raw = raw;
  if (b.formData !== undefined) out.formData = keyValues(b.formData, `${path}.formData`);
  const binaryPath = optStr(b.binaryPath, `${path}.binaryPath`);
  if (binaryPath !== undefined) out.binaryPath = binaryPath;
  return out;
}

function requestConfig(value: unknown, path: string): Omit<RequestConfig, 'id' | 'name'> {
  const c = obj(value, path);
  const out: Omit<RequestConfig, 'id' | 'name'> = {
    method: oneOf(c.method ?? 'GET', HTTP_METHODS, `${path}.method`),
    url: str(c.url ?? '', `${path}.url`),
    params: keyValues(c.params, `${path}.params`),
    headers: keyValues(c.headers, `${path}.headers`),
    body: body(c.body, `${path}.body`),
    auth: auth(c.auth, `${path}.auth`),
  };
  if (c.protocol !== undefined) out.protocol = oneOf(c.protocol, PROTOCOLS, `${path}.protocol`);
  const pre = optStr(c.preRequestScript, `${path}.preRequestScript`);
  if (pre !== undefined) out.preRequestScript = pre;
  const test = optStr(c.testScript, `${path}.testScript`);
  if (test !== undefined) out.testScript = test;
  // Protocol-specific payloads (GraphQL query, gRPC proto source, …) are
  // owned by each protocol's editor, which already tolerates missing fields;
  // only its overall shape is checked here. A JSON round-trip guarantees a
  // plain data object with no prototype tricks.
  if (c.protocolConfig !== undefined)
    out.protocolConfig = JSON.parse(JSON.stringify(obj(c.protocolConfig, `${path}.protocolConfig`)));
  return out;
}

function item(value: unknown, category: CollectionCategory, path: string): NativeExportItem {
  const i = obj(value, path);
  const expected = ITEM_TYPE_BY_CATEGORY[category];
  if (i.type !== expected) fail(`${path}.type`, `a ${category} collection can only hold "${expected}" items`);
  const itemName = name(i.name, `${path}.name`);
  if (expected === 'request')
    return { type: 'request', name: itemName, config: requestConfig(i.config, `${path}.config`) };
  if (expected === 'websocket') {
    return {
      type: 'websocket',
      name: itemName,
      url: str(i.url, `${path}.url`),
      headers: keyValues(i.headers, `${path}.headers`),
      subprotocols: strList(i.subprotocols, `${path}.subprotocols`),
      auth: auth(i.auth, `${path}.auth`),
    };
  }
  return {
    type: 'mcp',
    name: itemName,
    transport: oneOf(i.transport, ['stdio', 'http'] as const, `${path}.transport`),
    command: str(i.command, `${path}.command`),
    args: strList(i.args, `${path}.args`),
    env: keyValues(i.env, `${path}.env`),
    headers: keyValues(i.headers, `${path}.headers`),
  };
}

function folder(value: unknown, category: CollectionCategory, path: string, depth: number): NativeExportFolder {
  if (depth > MAX_DEPTH) fail(path, `folders are nested more than ${MAX_DEPTH} levels deep`);
  const f = obj(value, path);
  return {
    name: name(f.name, `${path}.name`),
    folders: (f.folders === undefined ? [] : arr(f.folders, `${path}.folders`)).map((child, i) =>
      folder(child, category, `${path}.folders[${i}]`, depth + 1),
    ),
    items: (f.items === undefined ? [] : arr(f.items, `${path}.items`)).map((entry, i) =>
      item(entry, category, `${path}.items[${i}]`),
    ),
  };
}

function environment(value: unknown, path: string): NativeExportEnvironment {
  const e = obj(value, path);
  const vars = e.variables === undefined ? {} : obj(e.variables, `${path}.variables`);
  return {
    name: name(e.name, `${path}.name`),
    variables: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, str(v, `${path}.variables.${k}`)])),
  };
}

export function isNativeExport(json: unknown, profile: EngineProfile = DEFAULT_ENGINE_PROFILE): boolean {
  return isObject(json) && json.format === profile.exportFormat;
}

/** Checks an untrusted export file and returns a clean, fully-typed copy.
 * Throws with a readable message naming the offending field. */
export function validateNativeExport(
  json: unknown,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): NativeExportDocument {
  const product = profile.productName;
  try {
    const doc = obj(json, 'file');
    if (doc.format !== profile.exportFormat) fail('format', `this is not a ${product} export file`);
    if (typeof doc.version !== 'number') fail('version', 'expected a number');
    if (doc.version > NATIVE_EXPORT_VERSION) {
      throw new ValidationError(
        `This file was exported by a newer version of ${product} (format v${doc.version}); update ${product} to import it.`,
      );
    }
    if (doc.version !== NATIVE_EXPORT_VERSION) fail('version', `unsupported format version ${doc.version}`);
    return {
      format: profile.exportFormat,
      version: NATIVE_EXPORT_VERSION,
      scope: oneOf(doc.scope, SCOPES, 'scope'),
      exportedAt: str(doc.exportedAt ?? '', 'exportedAt'),
      secretsStripped: doc.secretsStripped === true,
      collections: arr(doc.collections, 'collections').map((value, i): NativeExportCollection => {
        const path = `collections[${i}]`;
        const category = oneOf(obj(value, path).category, CATEGORIES, `${path}.category`);
        return { category, ...folder(value, category, path, 0) };
      }),
      environments: (doc.environments === undefined ? [] : arr(doc.environments, 'environments')).map((e, i) =>
        environment(e, `environments[${i}]`),
      ),
    };
  } catch (err) {
    if (err instanceof ValidationError) throw new Error(`Invalid ${product} export — ${err.message}`, { cause: err });
    throw err;
  }
}

// ---- Preview -------------------------------------------------------------------

function walk(
  f: NativeExportFolder,
  visit: (item: NativeExportItem) => void,
): { folderCount: number; itemCount: number } {
  let folderCount = 0;
  let itemCount = f.items.length;
  f.items.forEach(visit);
  for (const child of f.folders) {
    const sub = walk(child, visit);
    folderCount += 1 + sub.folderCount;
    itemCount += sub.itemCount;
  }
  return { folderCount, itemCount };
}

/** What an import would create, plus the things worth warning about — shown
 * to the user before they confirm. */
export function previewNativeImport(doc: NativeExportDocument): NativeImportPreview {
  let scriptRequestCount = 0;
  let localFileRequestCount = 0;
  const mcpStdioCommands: string[] = [];
  const visit = (i: NativeExportItem) => {
    if (i.type === 'request') {
      if (i.config.preRequestScript?.trim() || i.config.testScript?.trim()) scriptRequestCount++;
      if (i.config.body.mode === 'binary' && i.config.body.binaryPath) localFileRequestCount++;
    } else if (i.type === 'mcp' && i.transport === 'stdio') {
      mcpStdioCommands.push([i.command, ...i.args].join(' '));
    }
  };
  return {
    scope: doc.scope,
    exportedAt: doc.exportedAt,
    secretsStripped: doc.secretsStripped,
    collections: doc.collections.map((c) => ({ name: c.name, category: c.category, ...walk(c, visit) })),
    environments: doc.environments.map((e) => e.name),
    scriptRequestCount,
    mcpStdioCommands,
    localFileRequestCount,
  };
}

// ---- Import --------------------------------------------------------------------

/** "Users API" → "Users API (imported)" → "Users API (imported 2)" … when taken. */
function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base;
  for (let n = 1; taken.has(candidate); n++) candidate = n === 1 ? `${base} (imported)` : `${base} (imported ${n})`;
  taken.add(candidate);
  return candidate;
}

/**
 * Imports a validated export into a workspace, always as new copies (fresh
 * ids; nothing existing is touched). Root collections and environments whose
 * names are taken get an "(imported)" suffix. Runs in one transaction, so a
 * failure part-way leaves the workspace exactly as it was.
 */
export function importNative(
  db: Database.Database,
  workspaceId: string,
  doc: NativeExportDocument,
  options: NativeImportOptions,
): NativeImportResult {
  const result: NativeImportResult = { collections: [], folderCount: 0, itemCount: 0, environmentCount: 0 };

  function insertItem(collectionId: string, i: NativeExportItem) {
    if (i.type === 'request') {
      const { preRequestScript, testScript, ...rest } = i.config;
      const config: RequestConfig = {
        id: '',
        name: i.name,
        ...rest,
        ...(options.includeScripts && { preRequestScript, testScript }),
      };
      createRequest(db, { collectionId, name: i.name, config });
    } else if (i.type === 'websocket') {
      const created = createWebSocketConnection(db, { collectionId, name: i.name, url: i.url });
      updateWebSocketConnection(db, created.id, {
        url: i.url,
        headers: i.headers,
        subprotocols: i.subprotocols,
        auth: i.auth,
      });
    } else {
      const created = createMcpServerConnection(db, {
        collectionId,
        name: i.name,
        transport: i.transport,
        command: i.command,
      });
      updateMcpServerConnection(db, created.id, {
        transport: i.transport,
        command: i.command,
        args: i.args,
        env: i.env,
        headers: i.headers,
      });
    }
    result.itemCount++;
  }

  function insertContents(nodeId: string, f: NativeExportFolder) {
    for (const i of f.items) insertItem(nodeId, i);
    for (const child of f.folders) {
      const created = createCollectionNode(db, {
        workspaceId,
        parentFolderId: nodeId,
        name: child.name,
        kind: 'folder',
      });
      result.folderCount++;
      insertContents(created.id, child);
    }
  }

  db.transaction(() => {
    const takenByCategory = new Map<CollectionCategory, Set<string>>();
    for (const c of doc.collections) {
      let taken = takenByCategory.get(c.category);
      if (!taken) {
        const rows = db
          .prepare('SELECT name FROM collections WHERE workspace_id = ? AND category = ? AND parent_folder_id IS NULL')
          .all(workspaceId, c.category) as { name: string }[];
        taken = new Set(rows.map((r) => r.name));
        takenByCategory.set(c.category, taken);
      }
      const root = createCollectionNode(db, {
        workspaceId,
        parentFolderId: null,
        name: uniqueName(c.name, taken),
        kind: 'collection',
        category: c.category,
      });
      result.collections.push({ id: root.id, name: root.name, category: root.category });
      insertContents(root.id, c);
    }

    if (options.includeEnvironments) {
      const taken = new Set(listEnvironments(db, workspaceId).map((e) => e.name));
      for (const e of doc.environments) {
        const env = createEnvironment(db, workspaceId, uniqueName(e.name, taken));
        updateEnvironmentVariables(db, env.id, e.variables);
        result.environmentCount++;
      }
    }
  })();

  return result;
}
