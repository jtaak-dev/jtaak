import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { blank, isSecretName, stripAuth, stripKeyValues, stripSettings } from '../export/nativeExport.js';
import {
  MESSAGING_PROTOCOLS,
  type AuthConfig,
  type CollectionCategory,
  type CollectionNodeKind,
  type KeyValue,
  type RequestConfig,
  type WorkspaceCredentialFinding,
  type WorkspaceFolderChanges,
  type WorkspaceFolderFiles,
} from '../types.js';
import {
  COLLECTION_CATEGORIES,
  getWorkspace,
  listEnvironments,
  listMcpServerConnections,
  listMessagingConnections,
  listWebSocketConnections,
  storableConfig,
} from './repository.js';

// A workspace as a folder of files, for keeping it in version control and
// sharing it: one file per item, keyed by its id, so edits to different items
// change different files and merge without help.
//
//   workspace.json                       id, name, formatVersion
//   collections/<id>.json                a collection or folder
//   requests/<id>.json                   a saved request
//   connections/<websocket|mcp|messaging>/<id>.json
//   environments/<id>.json               the workspace's own (not global) ones
//   examples/<id>.json                   a request's response examples
//
// Each file is canonical JSON: keys sorted, two-space indent, a final newline,
// no timestamps, so the same data always writes the same bytes. What belongs
// to this computer stays out: history, cookies, OAuth 2.0 tokens, and the
// values of variables marked secret (their names are kept). Secret-named
// headers in response examples are blanked, as in a native export. Other
// credentials are written as they are; findWorkspaceCredentials lists them, so
// an application can ask for them to be moved into secret variables first.

/** The folder format's version, in workspace.json. A newer one is refused. */
export const WORKSPACE_FOLDER_VERSION = 1;

export type WorkspaceFolderErrorReason = 'invalid' | 'tooNew' | 'foreign';

/** A folder that can't be applied: `invalid` (a file is malformed or refers to
 * something missing), `tooNew` (a newer format) or `foreign` (an id belongs to
 * another workspace in this database). */
export class WorkspaceFolderError extends Error {
  constructor(
    readonly reason: WorkspaceFolderErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceFolderError';
  }
}

type ConnectionKind = 'websocket' | 'mcp' | 'messaging';

const CONNECTION_TABLES: Record<ConnectionKind, string> = {
  websocket: 'ws_connections',
  mcp: 'mcp_connections',
  messaging: 'messaging_connections',
};

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MANAGED_DIRS = ['collections', 'requests', 'connections', 'environments', 'examples'];

/** Which item a path holds, or undefined for a file the format doesn't use. */
export function classify(file: string): { kind: string; id: string } | undefined {
  if (file === 'workspace.json') return { kind: 'workspace', id: '' };
  const match =
    /^(collections|requests|environments|examples)\/([^/]+)\.json$/.exec(file) ??
    /^connections\/(websocket|mcp|messaging)\/([^/]+)\.json$/.exec(file);
  if (!match || !ID.test(match[2])) return undefined;
  return { kind: match[1], id: match[2] };
}

// ---- Canonical JSON ----------------------------------------------------------

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .filter((key) => object[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(object[key])]),
    );
  }
  return value;
}

export function serialize(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

// ---- Database → files ----------------------------------------------------------

interface CollectionFile {
  id: string;
  name: string;
  kind: CollectionNodeKind;
  category: CollectionCategory;
  parentId: string | null;
  order: number;
}

interface RequestFile {
  id: string;
  collectionId: string;
  name: string;
  order: number;
  config: Omit<RequestConfig, 'id' | 'name'>;
}

interface EnvironmentFile {
  id: string;
  name: string;
  variables: { name: string; value: string; secret?: true }[];
}

interface ExampleFile {
  id: string;
  requestId: string;
  name: string;
  order: number;
  status: number;
  statusText: string;
  headers: { name: string; value: string }[];
  body: string;
}

/**
 * The files of a workspace's folder (see the format above), by path. Throws
 * when there's no such workspace.
 */
export function workspaceFolderFiles(db: Database.Database, workspaceId: string): WorkspaceFolderFiles {
  const workspace = getWorkspace(db, workspaceId);
  if (!workspace) throw new Error(`Workspace ${workspaceId} does not exist.`);
  const files: WorkspaceFolderFiles = {
    'workspace.json': serialize({ formatVersion: WORKSPACE_FOLDER_VERSION, id: workspace.id, name: workspace.name }),
  };

  const collections = db
    .prepare('SELECT id, name, kind, category, parent_folder_id, sort_order FROM collections WHERE workspace_id = ?')
    .all(workspaceId) as {
    id: string;
    name: string;
    kind: CollectionNodeKind;
    category: CollectionCategory;
    parent_folder_id: string | null;
    sort_order: number;
  }[];
  for (const row of collections) {
    const file: CollectionFile = {
      id: row.id,
      name: row.name,
      kind: row.kind,
      category: row.category,
      parentId: row.parent_folder_id,
      order: row.sort_order,
    };
    files[`collections/${row.id}.json`] = serialize(file);
  }

  const requests = db
    .prepare(
      `SELECT r.id, r.collection_id, r.name, r.sort_order, r.config_json FROM requests r
       JOIN collections c ON c.id = r.collection_id WHERE c.workspace_id = ?`,
    )
    .all(workspaceId) as { id: string; collection_id: string; name: string; sort_order: number; config_json: string }[];
  for (const row of requests) {
    const { id: _id, name: _name, ...config } = storableConfig(JSON.parse(row.config_json) as RequestConfig);
    const file: RequestFile = {
      id: row.id,
      collectionId: row.collection_id,
      name: row.name,
      order: row.sort_order,
      config,
    };
    files[`requests/${row.id}.json`] = serialize(file);
  }

  for (const c of listWebSocketConnections(db, workspaceId)) {
    const { workspaceId: _w, createdAt: _c, updatedAt: _u, sortOrder, ...rest } = c;
    files[`connections/websocket/${c.id}.json`] = serialize({ ...rest, order: sortOrder });
  }
  for (const c of listMcpServerConnections(db, workspaceId)) {
    const { workspaceId: _w, createdAt: _c, updatedAt: _u, sortOrder, ...rest } = c;
    files[`connections/mcp/${c.id}.json`] = serialize({ ...rest, order: sortOrder });
  }
  for (const c of listMessagingConnections(db, workspaceId)) {
    const { workspaceId: _w, createdAt: _c, updatedAt: _u, sortOrder, ...rest } = c;
    files[`connections/messaging/${c.id}.json`] = serialize({ ...rest, order: sortOrder });
  }

  for (const env of listEnvironments(db, workspaceId)) {
    const secrets = new Set(env.secrets);
    const file: EnvironmentFile = {
      id: env.id,
      name: env.name,
      variables: Object.entries(env.variables).map(([name, value]) =>
        secrets.has(name) ? { name, value: '', secret: true } : { name, value },
      ),
    };
    files[`environments/${env.id}.json`] = serialize(file);
  }

  const examples = db
    .prepare(
      `SELECT e.id, e.request_id, e.name, e.sort_order, e.status, e.status_text, e.headers_json, e.body
       FROM response_examples e
       JOIN requests r ON r.id = e.request_id
       JOIN collections c ON c.id = r.collection_id
       WHERE c.workspace_id = ?`,
    )
    .all(workspaceId) as {
    id: string;
    request_id: string;
    name: string;
    sort_order: number;
    status: number;
    status_text: string;
    headers_json: string;
    body: string;
  }[];
  for (const row of examples) {
    const headers = JSON.parse(row.headers_json) as Record<string, string>;
    const file: ExampleFile = {
      id: row.id,
      requestId: row.request_id,
      name: row.name,
      order: row.sort_order,
      status: row.status,
      statusText: row.status_text,
      headers: Object.entries(headers).map(([name, value]) => ({
        name,
        value: isSecretName(name) ? blank(value) : value,
      })),
      body: row.body,
    };
    files[`examples/${row.id}.json`] = serialize(file);
  }
  return files;
}

// ---- Reading and checking files ------------------------------------------------

export type Json = Record<string, unknown>;

interface ParsedFolder {
  workspace: { id: string; name: string };
  /** Every item by path, as parsed (canonical once serialized again). */
  items: Map<string, { kind: string; id: string; value: Json }>;
}

function invalid(file: string, message: string): WorkspaceFolderError {
  return new WorkspaceFolderError('invalid', `${file}: ${message}`);
}

export function parseObject(file: string, text: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(file, 'not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(file, 'not a JSON object.');
  return value as Json;
}

function need(file: string, value: Json, key: string, type: 'string' | 'number' | 'object' | 'array'): void {
  const field = value[key];
  const ok =
    type === 'array'
      ? Array.isArray(field)
      : type === 'object'
        ? !!field && typeof field === 'object' && !Array.isArray(field)
        : typeof field === type && (type !== 'number' || Number.isFinite(field));
  if (!ok) throw invalid(file, `"${key}" must be ${type === 'array' || type === 'object' ? 'an' : 'a'} ${type}.`);
}

function oneOf(file: string, value: Json, key: string, allowed: readonly string[]): void {
  if (!allowed.includes(value[key] as string)) throw invalid(file, `"${key}" must be one of ${allowed.join(', ')}.`);
}

const CONNECTION_FIELDS: Record<ConnectionKind, [string, 'string' | 'object' | 'array'][]> = {
  websocket: [
    ['url', 'string'],
    ['headers', 'array'],
    ['subprotocols', 'array'],
    ['auth', 'object'],
  ],
  mcp: [
    ['command', 'string'],
    ['args', 'array'],
    ['env', 'array'],
    ['headers', 'array'],
  ],
  messaging: [
    ['url', 'string'],
    ['headers', 'array'],
    ['auth', 'object'],
    ['settings', 'object'],
    ['subscriptions', 'array'],
  ],
};

/** Parses and checks a folder's files: each item's shape, and that everything it
 * refers to (a parent, a collection of the right category, a request) is there. */
function parseFolder(files: WorkspaceFolderFiles): ParsedFolder {
  const workspaceText = files['workspace.json'];
  if (workspaceText === undefined) throw invalid('workspace.json', 'missing.');
  const workspace = parseObject('workspace.json', workspaceText);
  need('workspace.json', workspace, 'formatVersion', 'number');
  if ((workspace.formatVersion as number) > WORKSPACE_FOLDER_VERSION) {
    throw new WorkspaceFolderError(
      'tooNew',
      `This workspace folder uses a newer format (version ${String(workspace.formatVersion)}; this version reads up to ${WORKSPACE_FOLDER_VERSION}). Update to read it.`,
    );
  }
  need('workspace.json', workspace, 'id', 'string');
  need('workspace.json', workspace, 'name', 'string');
  if (!ID.test(workspace.id as string)) throw invalid('workspace.json', '"id" is not a valid id.');

  const items = new Map<string, { kind: string; id: string; value: Json }>();
  for (const [file, text] of Object.entries(files)) {
    const place = classify(file);
    if (!place || place.kind === 'workspace') continue;
    const value = parseObject(file, text);
    if (value.id !== place.id) throw invalid(file, '"id" must match the file name.');
    need(file, value, 'name', 'string');
    switch (place.kind) {
      case 'collections':
        oneOf(file, value, 'kind', ['collection', 'folder']);
        oneOf(file, value, 'category', COLLECTION_CATEGORIES);
        need(file, value, 'order', 'number');
        if (value.parentId !== null) need(file, value, 'parentId', 'string');
        break;
      case 'requests':
        need(file, value, 'collectionId', 'string');
        need(file, value, 'order', 'number');
        need(file, value, 'config', 'object');
        need(file, value.config as Json, 'method', 'string');
        need(file, value.config as Json, 'url', 'string');
        break;
      case 'environments':
        need(file, value, 'variables', 'array');
        for (const variable of value.variables as unknown[]) {
          const v = variable as Json;
          if (!v || typeof v !== 'object' || typeof v.name !== 'string' || typeof v.value !== 'string') {
            throw invalid(file, 'each variable needs a "name" and a "value".');
          }
        }
        break;
      case 'examples':
        need(file, value, 'requestId', 'string');
        need(file, value, 'order', 'number');
        need(file, value, 'status', 'number');
        need(file, value, 'statusText', 'string');
        need(file, value, 'headers', 'array');
        need(file, value, 'body', 'string');
        break;
      default: {
        const kind = place.kind as ConnectionKind;
        need(file, value, 'collectionId', 'string');
        need(file, value, 'order', 'number');
        for (const [key, type] of CONNECTION_FIELDS[kind]) need(file, value, key, type);
        if (kind === 'mcp') oneOf(file, value, 'transport', ['stdio', 'http']);
        if (kind === 'messaging') oneOf(file, value, 'protocol', MESSAGING_PROTOCOLS);
      }
    }
    items.set(file, { kind: place.kind, id: place.id, value });
  }

  // References.
  const collections = new Map<string, Json>();
  const requests = new Set<string>();
  for (const item of items.values()) {
    if (item.kind === 'collections') collections.set(item.id, item.value);
    if (item.kind === 'requests') requests.add(item.id);
  }
  for (const [file, item] of items) {
    const v = item.value;
    if (item.kind === 'collections' && v.parentId !== null) {
      const parent = collections.get(v.parentId as string);
      if (!parent) throw invalid(file, 'its parent folder is missing.');
      if (parent.category !== v.category) throw invalid(file, "its category isn't its parent's.");
      const seen = new Set<string>([item.id]);
      for (let at: Json | undefined = parent; at && at.parentId !== null; at = collections.get(at.parentId as string)) {
        if (seen.has(at.id as string)) throw invalid(file, 'its folders contain each other.');
        seen.add(at.id as string);
      }
    }
    const category = { requests: 'api', websocket: 'websocket', mcp: 'mcp', messaging: 'messaging' }[item.kind];
    if (category) {
      const collection = collections.get(v.collectionId as string);
      if (!collection) throw invalid(file, 'its collection is missing.');
      if (collection.category !== category) throw invalid(file, `its collection isn't in the ${category} category.`);
    }
    if (item.kind === 'examples' && !requests.has(v.requestId as string))
      throw invalid(file, 'its request is missing.');
  }
  return { workspace: { id: workspace.id as string, name: workspace.name as string }, items };
}

// ---- Files → database ------------------------------------------------------------

/**
 * Makes a workspace in the database what a folder's files say, keeping every
 * id: the workspace (`workspace.json`'s id) is created if it isn't there, each
 * item that differs is added or updated, and each item the folder doesn't
 * have is removed. Files the format doesn't use are ignored. Items that are
 * the same aren't touched, and a variable marked secret keeps the value it
 * has here. All in one transaction: a folder that can't be applied
 * (WorkspaceFolderError) changes nothing.
 */
export function applyWorkspaceFolder(db: Database.Database, files: WorkspaceFolderFiles): WorkspaceFolderChanges {
  const folder = parseFolder(files);
  const workspaceId = folder.workspace.id;

  return db.transaction((): WorkspaceFolderChanges => {
    const exists = getWorkspace(db, workspaceId) !== undefined;
    const current = exists ? workspaceFolderFiles(db, workspaceId) : {};
    assertOwnIds(db, workspaceId, folder);

    const changes: WorkspaceFolderChanges = { added: [], updated: [], removed: [] };
    const workspaceFile = serialize({
      formatVersion: WORKSPACE_FOLDER_VERSION,
      id: workspaceId,
      name: folder.workspace.name,
    });
    if (!exists) {
      db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(
        workspaceId,
        folder.workspace.name,
        Date.now(),
      );
      changes.added.push('workspace.json');
    } else if (current['workspace.json'] !== workspaceFile) {
      db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(folder.workspace.name, workspaceId);
      changes.updated.push('workspace.json');
    }
    // The folder says which collections there are: none is seeded on opening.
    const seed = db.prepare('INSERT OR IGNORE INTO workspace_seeds (workspace_id, category) VALUES (?, ?)');
    for (const category of COLLECTION_CATEGORIES) seed.run(workspaceId, category);

    const changed = [...folder.items].filter(([file, item]) => {
      if (current[file] === undefined) changes.added.push(file);
      else if (current[file] !== serialize(item.value)) changes.updated.push(file);
      else return false;
      return true;
    });
    const now = Date.now();
    for (const [, item] of parentsFirst(changed.filter(([, item]) => item.kind === 'collections'))) {
      upsertCollection(db, workspaceId, item.value, now);
    }
    for (const [, item] of changed) {
      if (item.kind === 'requests') upsertRequest(db, item.value, now);
      else if (item.kind === 'environments') upsertEnvironment(db, workspaceId, item.value);
      else if (item.kind === 'websocket' || item.kind === 'mcp' || item.kind === 'messaging') {
        upsertConnection(db, item.kind, workspaceId, item.value, now);
      }
    }
    for (const [, item] of changed) if (item.kind === 'examples') upsertExample(db, item.value, now);

    // Removals, after the moves above, so deleting a collection only takes
    // with it what the folder removes too.
    const removed = Object.keys(current).filter((file) => file !== 'workspace.json' && !folder.items.has(file));
    const order = ['examples', 'requests', 'websocket', 'mcp', 'messaging', 'environments', 'collections'];
    removed.sort((a, b) => order.indexOf(classify(a)!.kind) - order.indexOf(classify(b)!.kind));
    for (const file of removed) {
      const { kind, id } = classify(file)!;
      const table =
        kind === 'examples'
          ? 'response_examples'
          : kind in CONNECTION_TABLES
            ? CONNECTION_TABLES[kind as ConnectionKind]
            : kind;
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      changes.removed.push(file);
    }
    for (const list of Object.values(changes)) (list as string[]).sort();
    return changes;
  })();
}

/** Refuses a folder whose ids are already used by another workspace here (or a global environment). */
function assertOwnIds(db: Database.Database, workspaceId: string, folder: ParsedFolder): void {
  const owner: Record<string, string> = {
    collections: 'SELECT workspace_id AS owner FROM collections WHERE id = ?',
    requests:
      'SELECT c.workspace_id AS owner FROM requests r JOIN collections c ON c.id = r.collection_id WHERE r.id = ?',
    environments: "SELECT COALESCE(workspace_id, '') AS owner FROM environments WHERE id = ?",
    examples: `SELECT c.workspace_id AS owner FROM response_examples e JOIN requests r ON r.id = e.request_id
               JOIN collections c ON c.id = r.collection_id WHERE e.id = ?`,
    websocket: 'SELECT workspace_id AS owner FROM ws_connections WHERE id = ?',
    mcp: 'SELECT workspace_id AS owner FROM mcp_connections WHERE id = ?',
    messaging: 'SELECT workspace_id AS owner FROM messaging_connections WHERE id = ?',
  };
  for (const [file, item] of folder.items) {
    const row = db.prepare(owner[item.kind]).get(item.id) as { owner: string } | undefined;
    if (row && row.owner !== workspaceId) {
      throw new WorkspaceFolderError('foreign', `${file}: its id belongs to another workspace in this database.`);
    }
  }
}

function parentsFirst<T extends [string, { id: string; value: Json }]>(entries: T[]): T[] {
  const byId = new Map(entries.map((entry) => [entry[1].id, entry]));
  const done = new Set<string>();
  const out: T[] = [];
  const visit = (entry: T): void => {
    if (done.has(entry[1].id)) return;
    done.add(entry[1].id);
    const parent = byId.get(entry[1].value.parentId as string);
    if (parent) visit(parent);
    out.push(entry);
  };
  entries.forEach(visit);
  return out;
}

function upsertCollection(db: Database.Database, workspaceId: string, v: Json, now: number): void {
  db.prepare(
    `INSERT INTO collections (id, workspace_id, parent_folder_id, name, kind, category, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_folder_id = excluded.parent_folder_id, name = excluded.name,
       kind = excluded.kind, category = excluded.category, sort_order = excluded.sort_order`,
  ).run(v.id, workspaceId, v.parentId, v.name, v.kind, v.category, v.order, now);
}

function upsertRequest(db: Database.Database, v: Json, now: number): void {
  const config = storableConfig({ ...(v.config as RequestConfig), id: v.id as string, name: v.name as string });
  db.prepare(
    `INSERT INTO requests (id, collection_id, name, protocol, method, url, config_json, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET collection_id = excluded.collection_id, name = excluded.name,
       protocol = excluded.protocol, method = excluded.method, url = excluded.url,
       config_json = excluded.config_json, sort_order = excluded.sort_order, updated_at = excluded.updated_at`,
  ).run(
    v.id,
    v.collectionId,
    v.name,
    config.protocol ?? 'http',
    config.method,
    config.url,
    JSON.stringify(config),
    v.order,
    now,
  );
}

function upsertEnvironment(db: Database.Database, workspaceId: string, v: Json): void {
  const existing = db.prepare('SELECT variables_json FROM environments WHERE id = ?').get(v.id) as
    { variables_json: string } | undefined;
  const local = existing ? (JSON.parse(existing.variables_json) as Record<string, string>) : {};
  const list = v.variables as { name: string; value: string; secret?: boolean }[];
  const variables = Object.fromEntries(list.map((x) => [x.name, x.secret ? (local[x.name] ?? '') : x.value]));
  const secrets = [...new Set(list.filter((x) => x.secret).map((x) => x.name))].sort();
  db.prepare(
    `INSERT INTO environments (id, workspace_id, name, variables_json, secrets_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, variables_json = excluded.variables_json,
       secrets_json = excluded.secrets_json`,
  ).run(v.id, workspaceId, v.name, JSON.stringify(variables), JSON.stringify(secrets));
}

function verifyTlsColumn(v: Json): number | null {
  return typeof v.verifyTls === 'boolean' ? Number(v.verifyTls) : null;
}

function testScriptColumn(v: Json): string | null {
  return typeof v.testScript === 'string' && v.testScript ? v.testScript : null;
}

function upsertConnection(
  db: Database.Database,
  kind: ConnectionKind,
  workspaceId: string,
  v: Json,
  now: number,
): void {
  const json = (key: string) => JSON.stringify(v[key]);
  const columns: Record<string, unknown> =
    kind === 'websocket'
      ? {
          url: v.url,
          headers_json: json('headers'),
          subprotocols_json: json('subprotocols'),
          auth_json: json('auth'),
          verify_tls: verifyTlsColumn(v),
          test_script: testScriptColumn(v),
        }
      : kind === 'mcp'
        ? {
            transport: v.transport,
            command: v.command,
            args_json: json('args'),
            env_json: json('env'),
            headers_json: json('headers'),
            verify_tls: verifyTlsColumn(v),
          }
        : {
            protocol: v.protocol,
            url: v.url,
            headers_json: json('headers'),
            auth_json: json('auth'),
            settings_json: json('settings'),
            subscriptions_json: json('subscriptions'),
            verify_tls: verifyTlsColumn(v),
            test_script: testScriptColumn(v),
          };
  const all: Record<string, unknown> = {
    id: v.id,
    workspace_id: workspaceId,
    collection_id: v.collectionId,
    sort_order: v.order,
    name: v.name,
    ...columns,
    created_at: now,
    updated_at: now,
  };
  const names = Object.keys(all);
  const updates = names.filter((name) => name !== 'id' && name !== 'workspace_id' && name !== 'created_at');
  db.prepare(
    `INSERT INTO ${CONNECTION_TABLES[kind]} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
     ON CONFLICT(id) DO UPDATE SET ${updates.map((name) => `${name} = excluded.${name}`).join(', ')}`,
  ).run(...Object.values(all));
}

function upsertExample(db: Database.Database, v: Json, now: number): void {
  const headers = Object.fromEntries((v.headers as { name: string; value: string }[]).map((h) => [h.name, h.value]));
  db.prepare(
    `INSERT INTO response_examples (id, request_id, name, status, status_text, headers_json, body, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET request_id = excluded.request_id, name = excluded.name, status = excluded.status,
       status_text = excluded.status_text, headers_json = excluded.headers_json, body = excluded.body,
       sort_order = excluded.sort_order`,
  ).run(v.id, v.requestId, v.name, v.status, v.statusText, JSON.stringify(headers), v.body, v.order, now);
}

// ---- Credentials -----------------------------------------------------------------

/** The paths at which two JSON values differ. */
function differences(a: unknown, b: unknown, at: string): string[] {
  if (a === b) return [];
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => differences((a as Json)[key], (b as Json)[key], at ? `${at}.${key}` : key));
  }
  return [at];
}

function keyValueFindings(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return [];
  const stripped = stripKeyValues(list as KeyValue[]);
  return (list as KeyValue[]).flatMap((kv, index) =>
    stripped[index].value !== kv.value ? [`${field}.${kv.key}`] : [],
  );
}

function authFindings(auth: unknown, field: string): string[] {
  if (!auth || typeof auth !== 'object') return [];
  return differences(auth, stripAuth(auth as AuthConfig), field);
}

/**
 * The credentials a folder's files hold as literal values: secret-named
 * params, headers and environment variables (unless marked secret), auth
 * passwords, tokens and keys, and secret-named connection settings. A value
 * that is only a `{{variable}}` reference isn't one. An application sharing
 * the folder can ask for each to be moved into a variable marked secret, or
 * into its own store, before the files leave the computer.
 */
export function findWorkspaceCredentials(files: WorkspaceFolderFiles): WorkspaceCredentialFinding[] {
  const findings: WorkspaceCredentialFinding[] = [];
  for (const file of Object.keys(files).sort()) {
    const place = classify(file);
    if (!place || place.kind === 'workspace') continue;
    let value: Json;
    try {
      value = parseObject(file, files[file]);
    } catch {
      continue;
    }
    const fields: string[] = [];
    if (place.kind === 'requests') {
      const config = (value.config ?? {}) as Json;
      fields.push(...keyValueFindings(config.params, 'params'), ...keyValueFindings(config.headers, 'headers'));
      fields.push(...authFindings(config.auth, 'auth'));
    } else if (place.kind === 'environments' && Array.isArray(value.variables)) {
      for (const v of value.variables as { name: string; value: string; secret?: boolean }[]) {
        if (!v.secret && isSecretName(v.name) && blank(v.value) !== v.value) fields.push(`variables.${v.name}`);
      }
    } else if (place.kind === 'websocket' || place.kind === 'mcp' || place.kind === 'messaging') {
      fields.push(...keyValueFindings(value.headers, 'headers'), ...keyValueFindings(value.env, 'env'));
      fields.push(...authFindings(value.auth, 'auth'));
      if (value.settings && typeof value.settings === 'object') {
        fields.push(...differences(value.settings, stripSettings(value.settings as Json), 'settings'));
      }
    }
    for (const field of fields) findings.push({ file, field });
  }
  return findings;
}

// ---- On disk ---------------------------------------------------------------------

/** Reads a workspace folder's files from a directory: only the paths the format uses. */
export function readWorkspaceFolder(dir: string): WorkspaceFolderFiles {
  const files: WorkspaceFolderFiles = {};
  const add = (relative: string) => {
    if (classify(relative)) files[relative] = fs.readFileSync(path.join(dir, ...relative.split('/')), 'utf8');
  };
  if (fs.existsSync(path.join(dir, 'workspace.json'))) add('workspace.json');
  const walk = (relative: string): void => {
    const absolute = path.join(dir, ...relative.split('/'));
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) add(child);
    }
  };
  MANAGED_DIRS.forEach(walk);
  return files;
}

/**
 * Writes a workspace folder's files into a directory: each file whose text
 * changed, and removes the format's files that are no longer in it. Anything
 * else there (a `.git` folder, a README) is left alone. Returns the paths
 * written and removed.
 */
export function writeWorkspaceFolder(
  dir: string,
  files: WorkspaceFolderFiles,
): { written: string[]; removed: string[] } {
  for (const file of Object.keys(files)) {
    if (!classify(file)) throw new Error(`${file} is not a path of a workspace folder.`);
  }
  const existing = readWorkspaceFolder(dir);
  const written: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (existing[file] === text) continue;
    const absolute = path.join(dir, ...file.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
    written.push(file);
  }
  const removed = Object.keys(existing).filter((file) => files[file] === undefined);
  for (const file of removed) fs.rmSync(path.join(dir, ...file.split('/')));
  return { written: written.sort(), removed: removed.sort() };
}
