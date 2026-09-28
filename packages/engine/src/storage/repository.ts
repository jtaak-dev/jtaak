import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AuthConfig,
  CollectionCategory,
  CollectionNode,
  CollectionNodeKind,
  CollectionTreeNode,
  ConnectionTreeNode,
  Environment,
  KeyValue,
  McpServerConnection,
  McpTransportKind,
  MessagingConnection,
  MessagingProtocol,
  MessagingSubscription,
  Protocol,
  RequestConfig,
  SavedRequest,
  SavedRequestSummary,
  WebSocketConnection,
  Workspace,
} from '../types.js';

interface CollectionRow {
  id: string;
  workspace_id: string;
  parent_folder_id: string | null;
  name: string;
  kind: CollectionNodeKind;
  category: CollectionCategory;
  sort_order: number;
  created_at: number;
}

interface RequestRow {
  id: string;
  collection_id: string;
  name: string;
  protocol: string;
  method: string;
  url: string;
  config_json: string;
  sort_order: number;
  updated_at: number;
}

function toCollectionNode(row: CollectionRow): CollectionNode {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentFolderId: row.parent_folder_id,
    name: row.name,
    kind: row.kind,
    category: row.category,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

function toRequestSummary(row: RequestRow): SavedRequestSummary {
  return {
    id: row.id,
    collectionId: row.collection_id,
    name: row.name,
    protocol: (row.protocol as Protocol | undefined) ?? 'http',
    method: row.method as SavedRequestSummary['method'],
    url: row.url,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

type ConnectionTable = 'ws_connections' | 'mcp_connections' | 'messaging_connections';

function nextSortOrder(
  db: Database.Database,
  table: 'collections' | 'requests' | ConnectionTable,
  column: string,
  id: string | null,
): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM ${table} WHERE ${column} IS ?`)
    .get(id) as { maxOrder: number };
  return row.maxOrder + 1;
}

// ---- Workspaces ----------------------------------------------------------

export function listWorkspaces(db: Database.Database): Workspace[] {
  const rows = db.prepare('SELECT id, name, created_at AS createdAt FROM workspaces ORDER BY created_at ASC').all();
  return rows as Workspace[];
}

export function createWorkspace(db: Database.Database, name: string): Workspace {
  const workspace: Workspace = { id: randomUUID(), name, createdAt: Date.now() };
  db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(
    workspace.id,
    workspace.name,
    workspace.createdAt,
  );
  return workspace;
}

/** Every sidebar category, in the order a UI shows them. */
export const COLLECTION_CATEGORIES: readonly CollectionCategory[] = ['api', 'websocket', 'mcp', 'messaging'];

export const DEFAULT_COLLECTION_NAMES: Record<CollectionCategory, string> = {
  api: 'My Collection',
  websocket: 'My Connections',
  mcp: 'My MCPs',
  messaging: 'My Brokers',
};

const CONNECTION_TABLE_BY_CATEGORY: Partial<Record<CollectionCategory, ConnectionTable>> = {
  websocket: 'ws_connections',
  mcp: 'mcp_connections',
  messaging: 'messaging_connections',
};

/**
 * Creates a category's default collection the first time a workspace is
 * opened — once only: `workspace_seeds` remembers it, so a user who deletes
 * the default collection doesn't get it back on the next launch. An 'api'
 * category that already has collections (a database from before categories
 * existed) is marked seeded without adding another. Saved connections from
 * before categories existed have no collection yet and are adopted into the
 * category's first collection here.
 */
function seedCategory(db: Database.Database, workspaceId: string, category: CollectionCategory): void {
  const seeded = db
    .prepare('SELECT 1 FROM workspace_seeds WHERE workspace_id = ? AND category = ?')
    .get(workspaceId, category);
  if (seeded) return;

  db.transaction(() => {
    const existingRoot = db
      .prepare(
        'SELECT id FROM collections WHERE workspace_id = ? AND category = ? AND parent_folder_id IS NULL ORDER BY sort_order ASC LIMIT 1',
      )
      .get(workspaceId, category) as { id: string } | undefined;
    const rootId =
      existingRoot?.id ??
      createCollectionNode(db, {
        workspaceId,
        parentFolderId: null,
        name: DEFAULT_COLLECTION_NAMES[category],
        kind: 'collection',
        category,
      }).id;

    const connectionTable = CONNECTION_TABLE_BY_CATEGORY[category];
    if (connectionTable) {
      db.prepare(
        `UPDATE ${connectionTable} SET collection_id = ? WHERE workspace_id = ? AND collection_id IS NULL`,
      ).run(rootId, workspaceId);
    }
    db.prepare('INSERT INTO workspace_seeds (workspace_id, category) VALUES (?, ?)').run(workspaceId, category);
  })();
}

/**
 * Returns the first workspace, creating one if none exists yet, and makes
 * sure each category has had its default collection created once (see
 * seedCategory). Nothing needs a workspace switcher yet, so this keeps
 * single-workspace usage frictionless while the CRUD layer underneath
 * already supports many.
 */
export function getOrCreateDefaultWorkspace(db: Database.Database): { workspace: Workspace } {
  const existing = listWorkspaces(db)[0];
  const workspace = existing ?? createWorkspace(db, DEFAULT_WORKSPACE_NAME);
  for (const category of COLLECTION_CATEGORIES) seedCategory(db, workspace.id, category);
  return { workspace };
}

/** The name the first workspace gets, and the one an emptied last workspace gets back (`resetWorkspace`). */
export const DEFAULT_WORKSPACE_NAME = 'My Workspace';

export function getWorkspace(db: Database.Database, id: string): Workspace | undefined {
  return db.prepare('SELECT id, name, created_at AS createdAt FROM workspaces WHERE id = ?').get(id) as
    Workspace | undefined;
}

/**
 * A workspace, ready to use: with each category's default collection the
 * first time it's opened (as `getOrCreateDefaultWorkspace` does for the
 * first one). Undefined when there's no such workspace.
 */
export function openWorkspace(db: Database.Database, id: string): Workspace | undefined {
  const workspace = getWorkspace(db, id);
  if (!workspace) return undefined;
  for (const category of COLLECTION_CATEGORIES) seedCategory(db, workspace.id, category);
  return workspace;
}

export function renameWorkspace(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id);
}

/**
 * Deletes a workspace and everything in it: collections and what they hold,
 * environments, history, cookies, OAuth tokens and response examples.
 */
export function deleteWorkspace(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
}

/**
 * Empties a workspace, keeping its id: everything in it is deleted, as by
 * `deleteWorkspace`, and it starts again as a new one would, with `name`
 * (the default name unless given) and each category's default collection.
 */
export function resetWorkspace(db: Database.Database, id: string, name = DEFAULT_WORKSPACE_NAME): Workspace {
  return db.transaction(() => {
    const createdAt = getWorkspace(db, id)?.createdAt ?? Date.now();
    deleteWorkspace(db, id);
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt);
    return openWorkspace(db, id)!;
  })();
}

// ---- Collections & folders ------------------------------------------------

function getCollectionCategory(db: Database.Database, collectionId: string): CollectionCategory | undefined {
  const row = db.prepare('SELECT category FROM collections WHERE id = ?').get(collectionId) as
    { category: CollectionCategory } | undefined;
  return row?.category;
}

/** `category` only applies to a root collection (defaulting to 'api', which
 * is what importers create) — a folder always takes its parent's. */
export function createCollectionNode(
  db: Database.Database,
  input: {
    workspaceId: string;
    parentFolderId: string | null;
    name: string;
    kind: CollectionNodeKind;
    category?: CollectionCategory;
  },
): CollectionNode {
  const category = input.parentFolderId
    ? (getCollectionCategory(db, input.parentFolderId) ?? input.category ?? 'api')
    : (input.category ?? 'api');
  const node: CollectionNode = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    parentFolderId: input.parentFolderId,
    name: input.name,
    kind: input.kind,
    category,
    sortOrder: nextSortOrder(db, 'collections', 'parent_folder_id', input.parentFolderId),
    createdAt: Date.now(),
  };
  db.prepare(
    'INSERT INTO collections (id, workspace_id, parent_folder_id, name, kind, category, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    node.id,
    node.workspaceId,
    node.parentFolderId,
    node.name,
    node.kind,
    node.category,
    node.sortOrder,
    node.createdAt,
  );
  return node;
}

export function renameCollectionNode(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, id);
}

export function deleteCollectionNode(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM collections WHERE id = ?').run(id);
}

/** Moves a folder/collection under a new parent (or to workspace root), appending it after its new siblings. */
export function moveCollectionNode(db: Database.Database, id: string, newParentFolderId: string | null): void {
  if (newParentFolderId && getCollectionCategory(db, newParentFolderId) !== getCollectionCategory(db, id)) {
    throw new Error('Cannot move a folder into a different category.');
  }
  const sortOrder = nextSortOrder(db, 'collections', 'parent_folder_id', newParentFolderId);
  db.prepare('UPDATE collections SET parent_folder_id = ?, sort_order = ? WHERE id = ?').run(
    newParentFolderId,
    sortOrder,
    id,
  );
}

/** Rewrites sort_order (0..n-1) for a set of sibling folders/collections, in the given order. */
export function reorderCollectionNodes(db: Database.Database, orderedIds: string[]): void {
  const update = db.prepare('UPDATE collections SET sort_order = ? WHERE id = ?');
  db.transaction((ids: string[]) => {
    ids.forEach((id, index) => update.run(index, id));
  })(orderedIds);
}

// ---- Requests --------------------------------------------------------------

export function createRequest(
  db: Database.Database,
  input: { collectionId: string; name: string; config: RequestConfig },
): SavedRequest {
  const now = Date.now();
  const id = randomUUID();
  const sortOrder = nextSortOrder(db, 'requests', 'collection_id', input.collectionId);
  const config: RequestConfig = storableConfig({ ...input.config, id, name: input.name });
  const protocol: Protocol = config.protocol ?? 'http';
  db.prepare(
    'INSERT INTO requests (id, collection_id, name, protocol, method, url, config_json, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.collectionId,
    input.name,
    protocol,
    config.method,
    config.url,
    JSON.stringify(config),
    sortOrder,
    now,
  );
  return {
    id,
    collectionId: input.collectionId,
    name: input.name,
    protocol,
    method: config.method,
    url: config.url,
    sortOrder,
    updatedAt: now,
    config,
  };
}

/** A config as it's saved: without `network`, which holds the host's settings (and secrets), not the request's. */
export function storableConfig(config: RequestConfig): RequestConfig {
  if (!('network' in config)) return config;
  const { network: _network, ...stored } = config;
  return stored;
}

export function updateRequest(db: Database.Database, id: string, config: RequestConfig): void {
  db.prepare(
    'UPDATE requests SET name = ?, protocol = ?, method = ?, url = ?, config_json = ?, updated_at = ? WHERE id = ?',
  ).run(
    config.name,
    config.protocol ?? 'http',
    config.method,
    config.url,
    JSON.stringify(storableConfig(config)),
    Date.now(),
    id,
  );
}

export function deleteRequest(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM requests WHERE id = ?').run(id);
}

/** Renames a saved request, keeping the row's `name` column and the embedded config's `name` field in sync. */
export function renameRequest(db: Database.Database, id: string, name: string): void {
  const row = db.prepare('SELECT config_json FROM requests WHERE id = ?').get(id) as
    { config_json: string } | undefined;
  if (!row) return;
  const config = { ...(JSON.parse(row.config_json) as RequestConfig), name };
  db.prepare('UPDATE requests SET name = ?, config_json = ?, updated_at = ? WHERE id = ?').run(
    name,
    JSON.stringify(config),
    Date.now(),
    id,
  );
}

export function getRequest(db: Database.Database, id: string): SavedRequest | undefined {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!row) return undefined;
  return { ...toRequestSummary(row), config: JSON.parse(row.config_json) as RequestConfig };
}

/** Moves a request to a different collection/folder, appending it after its new siblings. */
export function moveRequest(db: Database.Database, id: string, newCollectionId: string): void {
  const sortOrder = nextSortOrder(db, 'requests', 'collection_id', newCollectionId);
  db.prepare('UPDATE requests SET collection_id = ?, sort_order = ? WHERE id = ?').run(newCollectionId, sortOrder, id);
}

/** Rewrites sort_order (0..n-1) for a set of sibling requests, in the given order. */
export function reorderRequests(db: Database.Database, orderedIds: string[]): void {
  const update = db.prepare('UPDATE requests SET sort_order = ? WHERE id = ?');
  db.transaction((ids: string[]) => {
    ids.forEach((id, index) => update.run(index, id));
  })(orderedIds);
}

// ---- Environments --------------------------------------------------------

interface EnvironmentRow {
  id: string;
  workspace_id: string;
  name: string;
  variables_json: string;
}

function toEnvironment(row: EnvironmentRow): Environment {
  return { id: row.id, workspaceId: row.workspace_id, name: row.name, variables: JSON.parse(row.variables_json) };
}

export function listEnvironments(db: Database.Database, workspaceId: string): Environment[] {
  const rows = db
    .prepare('SELECT * FROM environments WHERE workspace_id = ? ORDER BY name ASC')
    .all(workspaceId) as EnvironmentRow[];
  return rows.map(toEnvironment);
}

export function getEnvironment(db: Database.Database, id: string): Environment | undefined {
  const row = db.prepare('SELECT * FROM environments WHERE id = ?').get(id) as EnvironmentRow | undefined;
  return row ? toEnvironment(row) : undefined;
}

export function createEnvironment(db: Database.Database, workspaceId: string, name: string): Environment {
  const environment: Environment = { id: randomUUID(), workspaceId, name, variables: {} };
  db.prepare('INSERT INTO environments (id, workspace_id, name, variables_json) VALUES (?, ?, ?, ?)').run(
    environment.id,
    workspaceId,
    name,
    '{}',
  );
  return environment;
}

export function renameEnvironment(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE environments SET name = ? WHERE id = ?').run(name, id);
}

export function updateEnvironmentVariables(db: Database.Database, id: string, variables: Record<string, string>): void {
  db.prepare('UPDATE environments SET variables_json = ? WHERE id = ?').run(JSON.stringify(variables), id);
}

export function deleteEnvironment(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM environments WHERE id = ?').run(id);
}

/**
 * Loads every saved request nested under a collection/folder node
 * (including itself and arbitrarily deep subfolders), full config included
 * — this is what the collection runner runs. A recursive CTE keeps it to
 * one query regardless of nesting depth.
 */
export function listRequestsForNode(db: Database.Database, nodeId: string): SavedRequest[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE descendant_collections(id) AS (
         SELECT id FROM collections WHERE id = ?
         UNION ALL
         SELECT c.id FROM collections c JOIN descendant_collections dc ON c.parent_folder_id = dc.id
       )
       SELECT r.* FROM requests r
       WHERE r.collection_id IN (SELECT id FROM descendant_collections)
       ORDER BY r.collection_id, r.sort_order ASC`,
    )
    .all(nodeId) as RequestRow[];

  return rows.map((row) => ({ ...toRequestSummary(row), config: JSON.parse(row.config_json) as RequestConfig }));
}

// ---- WebSocket connections ------------------------------------------------

/** Connections can only live in a collection/folder of their own category. */
function assertCollectionCategory(
  db: Database.Database,
  collectionId: string,
  expected: CollectionCategory,
): { workspaceId: string } {
  const row = db.prepare('SELECT workspace_id, category FROM collections WHERE id = ?').get(collectionId) as
    { workspace_id: string; category: CollectionCategory } | undefined;
  if (!row) throw new Error(`Collection ${collectionId} does not exist.`);
  if (row.category !== expected) throw new Error(`Collection ${collectionId} is not a ${expected} collection.`);
  return { workspaceId: row.workspace_id };
}

function reorderConnectionRows(db: Database.Database, table: ConnectionTable, orderedIds: string[]): void {
  const update = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  db.transaction((ids: string[]) => {
    ids.forEach((id, index) => update.run(index, id));
  })(orderedIds);
}

interface WsConnectionRow {
  id: string;
  workspace_id: string;
  collection_id: string;
  sort_order: number;
  name: string;
  url: string;
  headers_json: string;
  subprotocols_json: string;
  auth_json: string;
  verify_tls: number;
  test_script: string | null;
  created_at: number;
  updated_at: number;
}

function toWebSocketConnection(row: WsConnectionRow): WebSocketConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    collectionId: row.collection_id,
    sortOrder: row.sort_order,
    name: row.name,
    url: row.url,
    headers: JSON.parse(row.headers_json) as KeyValue[],
    subprotocols: JSON.parse(row.subprotocols_json) as string[],
    auth: JSON.parse(row.auth_json) as AuthConfig,
    verifyTls: row.verify_tls !== 0,
    ...(row.test_script && { testScript: row.test_script }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listWebSocketConnections(db: Database.Database, workspaceId: string): WebSocketConnection[] {
  const rows = db
    .prepare('SELECT * FROM ws_connections WHERE workspace_id = ? ORDER BY sort_order ASC, name ASC')
    .all(workspaceId) as WsConnectionRow[];
  return rows.map(toWebSocketConnection);
}

export function getWebSocketConnection(db: Database.Database, id: string): WebSocketConnection | undefined {
  const row = db.prepare('SELECT * FROM ws_connections WHERE id = ?').get(id) as WsConnectionRow | undefined;
  return row ? toWebSocketConnection(row) : undefined;
}

export function createWebSocketConnection(
  db: Database.Database,
  input: { collectionId: string; name: string; url: string },
): WebSocketConnection {
  const { workspaceId } = assertCollectionCategory(db, input.collectionId, 'websocket');
  const now = Date.now();
  const connection: WebSocketConnection = {
    id: randomUUID(),
    workspaceId,
    collectionId: input.collectionId,
    sortOrder: nextSortOrder(db, 'ws_connections', 'collection_id', input.collectionId),
    name: input.name,
    url: input.url,
    headers: [],
    subprotocols: [],
    auth: { type: 'none' },
    verifyTls: true,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    'INSERT INTO ws_connections (id, workspace_id, collection_id, sort_order, name, url, headers_json, subprotocols_json, auth_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    connection.id,
    connection.workspaceId,
    connection.collectionId,
    connection.sortOrder,
    connection.name,
    connection.url,
    JSON.stringify(connection.headers),
    JSON.stringify(connection.subprotocols),
    JSON.stringify(connection.auth),
    connection.createdAt,
    connection.updatedAt,
  );
  return connection;
}

export function renameWebSocketConnection(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE ws_connections SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
}

/** Updates a connection's endpoint/headers/subprotocols/auth/TLS check/test script — everything but
 * its name (see renameWebSocketConnection). Leaving `verifyTls` or `testScript` out keeps the saved
 * value; an empty `testScript` removes it. */
export function updateWebSocketConnection(
  db: Database.Database,
  id: string,
  patch: {
    url: string;
    headers: KeyValue[];
    subprotocols: string[];
    auth: AuthConfig;
    verifyTls?: boolean;
    testScript?: string;
  },
): void {
  db.prepare(
    'UPDATE ws_connections SET url = ?, headers_json = ?, subprotocols_json = ?, auth_json = ?, verify_tls = COALESCE(?, verify_tls), test_script = COALESCE(?, test_script), updated_at = ? WHERE id = ?',
  ).run(
    patch.url,
    JSON.stringify(patch.headers),
    JSON.stringify(patch.subprotocols),
    JSON.stringify(patch.auth),
    patch.verifyTls === undefined ? null : Number(patch.verifyTls),
    patch.testScript ?? null,
    Date.now(),
    id,
  );
}

export function deleteWebSocketConnection(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM ws_connections WHERE id = ?').run(id);
}

/** Moves a connection to a different 'websocket' collection/folder, appending it after its new siblings. */
export function moveWebSocketConnection(db: Database.Database, id: string, newCollectionId: string): void {
  assertCollectionCategory(db, newCollectionId, 'websocket');
  const sortOrder = nextSortOrder(db, 'ws_connections', 'collection_id', newCollectionId);
  db.prepare('UPDATE ws_connections SET collection_id = ?, sort_order = ? WHERE id = ?').run(
    newCollectionId,
    sortOrder,
    id,
  );
}

/** Rewrites sort_order (0..n-1) for a set of sibling connections, in the given order. */
export function reorderWebSocketConnections(db: Database.Database, orderedIds: string[]): void {
  reorderConnectionRows(db, 'ws_connections', orderedIds);
}

// ---- MCP server connections -----------------------------------------------

interface McpConnectionRow {
  id: string;
  workspace_id: string;
  collection_id: string;
  sort_order: number;
  name: string;
  transport: string;
  command: string;
  args_json: string;
  env_json: string;
  headers_json: string;
  verify_tls: number;
  created_at: number;
  updated_at: number;
}

function toMcpServerConnection(row: McpConnectionRow): McpServerConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    collectionId: row.collection_id,
    sortOrder: row.sort_order,
    name: row.name,
    transport: row.transport as McpTransportKind,
    command: row.command,
    args: JSON.parse(row.args_json) as string[],
    env: JSON.parse(row.env_json) as KeyValue[],
    headers: JSON.parse(row.headers_json) as KeyValue[],
    verifyTls: row.verify_tls !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMcpServerConnections(db: Database.Database, workspaceId: string): McpServerConnection[] {
  const rows = db
    .prepare('SELECT * FROM mcp_connections WHERE workspace_id = ? ORDER BY sort_order ASC, name ASC')
    .all(workspaceId) as McpConnectionRow[];
  return rows.map(toMcpServerConnection);
}

export function getMcpServerConnection(db: Database.Database, id: string): McpServerConnection | undefined {
  const row = db.prepare('SELECT * FROM mcp_connections WHERE id = ?').get(id) as McpConnectionRow | undefined;
  return row ? toMcpServerConnection(row) : undefined;
}

export function createMcpServerConnection(
  db: Database.Database,
  input: { collectionId: string; name: string; transport: McpTransportKind; command: string },
): McpServerConnection {
  const { workspaceId } = assertCollectionCategory(db, input.collectionId, 'mcp');
  const now = Date.now();
  const connection: McpServerConnection = {
    id: randomUUID(),
    workspaceId,
    collectionId: input.collectionId,
    sortOrder: nextSortOrder(db, 'mcp_connections', 'collection_id', input.collectionId),
    name: input.name,
    transport: input.transport,
    command: input.command,
    args: [],
    env: [],
    headers: [],
    verifyTls: true,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    'INSERT INTO mcp_connections (id, workspace_id, collection_id, sort_order, name, transport, command, args_json, env_json, headers_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    connection.id,
    connection.workspaceId,
    connection.collectionId,
    connection.sortOrder,
    connection.name,
    connection.transport,
    connection.command,
    JSON.stringify(connection.args),
    JSON.stringify(connection.env),
    JSON.stringify(connection.headers),
    connection.createdAt,
    connection.updatedAt,
  );
  return connection;
}

export function renameMcpServerConnection(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE mcp_connections SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
}

/** Updates everything but the name (see renameMcpServerConnection). Leaving `verifyTls` out keeps the saved value. */
export function updateMcpServerConnection(
  db: Database.Database,
  id: string,
  patch: {
    transport: McpTransportKind;
    command: string;
    args: string[];
    env: KeyValue[];
    headers: KeyValue[];
    verifyTls?: boolean;
  },
): void {
  db.prepare(
    'UPDATE mcp_connections SET transport = ?, command = ?, args_json = ?, env_json = ?, headers_json = ?, verify_tls = COALESCE(?, verify_tls), updated_at = ? WHERE id = ?',
  ).run(
    patch.transport,
    patch.command,
    JSON.stringify(patch.args),
    JSON.stringify(patch.env),
    JSON.stringify(patch.headers),
    patch.verifyTls === undefined ? null : Number(patch.verifyTls),
    Date.now(),
    id,
  );
}

export function deleteMcpServerConnection(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM mcp_connections WHERE id = ?').run(id);
}

/** Moves a server to a different 'mcp' collection/folder, appending it after its new siblings. */
export function moveMcpServerConnection(db: Database.Database, id: string, newCollectionId: string): void {
  assertCollectionCategory(db, newCollectionId, 'mcp');
  const sortOrder = nextSortOrder(db, 'mcp_connections', 'collection_id', newCollectionId);
  db.prepare('UPDATE mcp_connections SET collection_id = ?, sort_order = ? WHERE id = ?').run(
    newCollectionId,
    sortOrder,
    id,
  );
}

/** Rewrites sort_order (0..n-1) for a set of sibling servers, in the given order. */
export function reorderMcpServerConnections(db: Database.Database, orderedIds: string[]): void {
  reorderConnectionRows(db, 'mcp_connections', orderedIds);
}

// ---- Trees ---------------------------------------------------------------

/** Nests one category's collection rows (already sorted by sort_order)
 * under their parents, in memory. */
function assembleTree<TNode extends CollectionNode & { children: TNode[] }>(
  rows: CollectionRow[],
  makeNode: (node: CollectionNode) => TNode,
): { roots: TNode[]; nodesById: Map<string, TNode> } {
  const nodesById = new Map<string, TNode>();
  for (const row of rows) nodesById.set(row.id, makeNode(toCollectionNode(row)));

  const roots: TNode[] = [];
  for (const row of rows) {
    const node = nodesById.get(row.id)!;
    if (row.parent_folder_id && nodesById.has(row.parent_folder_id)) {
      nodesById.get(row.parent_folder_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return { roots, nodesById };
}

function listCategoryCollections(
  db: Database.Database,
  workspaceId: string,
  category: CollectionCategory,
): CollectionRow[] {
  return db
    .prepare('SELECT * FROM collections WHERE workspace_id = ? AND category = ? ORDER BY sort_order ASC')
    .all(workspaceId, category) as CollectionRow[];
}

/**
 * Loads the full 'api' collection/folder/request tree for a workspace in
 * exactly two indexed queries (not one query per node), then assembles it in
 * memory — this is what keeps a 10,000-request tree load under the
 * budget instead of degrading to O(n) round-trips.
 */
export function getCollectionTree(db: Database.Database, workspaceId: string): CollectionTreeNode[] {
  const requestRows = db
    .prepare(
      `SELECT r.* FROM requests r
       JOIN collections c ON c.id = r.collection_id
       WHERE c.workspace_id = ? AND c.category = 'api'
       ORDER BY r.sort_order ASC`,
    )
    .all(workspaceId) as RequestRow[];

  const { roots, nodesById } = assembleTree<CollectionTreeNode>(
    listCategoryCollections(db, workspaceId, 'api'),
    (node) => ({
      ...node,
      children: [],
      requests: [],
    }),
  );
  for (const row of requestRows) {
    nodesById.get(row.collection_id)?.requests.push(toRequestSummary(row));
  }
  return roots;
}

// ---- Messaging connections -------------------------------------------------

interface MessagingConnectionRow {
  id: string;
  workspace_id: string;
  collection_id: string;
  sort_order: number;
  name: string;
  protocol: string;
  url: string;
  headers_json: string;
  auth_json: string;
  settings_json: string;
  subscriptions_json: string;
  verify_tls: number;
  test_script: string | null;
  created_at: number;
  updated_at: number;
}

function toMessagingConnection(row: MessagingConnectionRow): MessagingConnection {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    collectionId: row.collection_id,
    sortOrder: row.sort_order,
    name: row.name,
    protocol: row.protocol as MessagingProtocol,
    url: row.url,
    headers: JSON.parse(row.headers_json) as KeyValue[],
    auth: JSON.parse(row.auth_json) as AuthConfig,
    settings: JSON.parse(row.settings_json) as Record<string, unknown>,
    subscriptions: JSON.parse(row.subscriptions_json) as MessagingSubscription[],
    verifyTls: row.verify_tls !== 0,
    ...(row.test_script && { testScript: row.test_script }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMessagingConnections(db: Database.Database, workspaceId: string): MessagingConnection[] {
  const rows = db
    .prepare('SELECT * FROM messaging_connections WHERE workspace_id = ? ORDER BY sort_order ASC, name ASC')
    .all(workspaceId) as MessagingConnectionRow[];
  return rows.map(toMessagingConnection);
}

export function getMessagingConnection(db: Database.Database, id: string): MessagingConnection | undefined {
  const row = db.prepare('SELECT * FROM messaging_connections WHERE id = ?').get(id) as
    MessagingConnectionRow | undefined;
  return row ? toMessagingConnection(row) : undefined;
}

export function createMessagingConnection(
  db: Database.Database,
  input: { collectionId: string; name: string; protocol: MessagingProtocol; url: string },
): MessagingConnection {
  const { workspaceId } = assertCollectionCategory(db, input.collectionId, 'messaging');
  const now = Date.now();
  const connection: MessagingConnection = {
    id: randomUUID(),
    workspaceId,
    collectionId: input.collectionId,
    sortOrder: nextSortOrder(db, 'messaging_connections', 'collection_id', input.collectionId),
    name: input.name,
    protocol: input.protocol,
    url: input.url,
    headers: [],
    auth: { type: 'none' },
    settings: {},
    subscriptions: [],
    verifyTls: true,
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    'INSERT INTO messaging_connections (id, workspace_id, collection_id, sort_order, name, protocol, url, headers_json, auth_json, settings_json, subscriptions_json, verify_tls, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    connection.id,
    connection.workspaceId,
    connection.collectionId,
    connection.sortOrder,
    connection.name,
    connection.protocol,
    connection.url,
    JSON.stringify(connection.headers),
    JSON.stringify(connection.auth),
    JSON.stringify(connection.settings),
    JSON.stringify(connection.subscriptions),
    1,
    connection.createdAt,
    connection.updatedAt,
  );
  return connection;
}

export function renameMessagingConnection(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE messaging_connections SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
}

/** Updates everything but the name (see renameMessagingConnection). Leaving `verifyTls` or
 * `testScript` out keeps the saved value; an empty `testScript` removes it. */
export function updateMessagingConnection(
  db: Database.Database,
  id: string,
  patch: {
    protocol: MessagingProtocol;
    url: string;
    headers: KeyValue[];
    auth: AuthConfig;
    settings: Record<string, unknown>;
    subscriptions: MessagingSubscription[];
    verifyTls?: boolean;
    testScript?: string;
  },
): void {
  db.prepare(
    'UPDATE messaging_connections SET protocol = ?, url = ?, headers_json = ?, auth_json = ?, settings_json = ?, subscriptions_json = ?, verify_tls = COALESCE(?, verify_tls), test_script = COALESCE(?, test_script), updated_at = ? WHERE id = ?',
  ).run(
    patch.protocol,
    patch.url,
    JSON.stringify(patch.headers),
    JSON.stringify(patch.auth),
    JSON.stringify(patch.settings),
    JSON.stringify(patch.subscriptions),
    patch.verifyTls === undefined ? null : Number(patch.verifyTls),
    patch.testScript ?? null,
    Date.now(),
    id,
  );
}

export function deleteMessagingConnection(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM messaging_connections WHERE id = ?').run(id);
}

/** Moves a connection to a different 'messaging' collection/folder, appending it after its new siblings. */
export function moveMessagingConnection(db: Database.Database, id: string, newCollectionId: string): void {
  assertCollectionCategory(db, newCollectionId, 'messaging');
  const sortOrder = nextSortOrder(db, 'messaging_connections', 'collection_id', newCollectionId);
  db.prepare('UPDATE messaging_connections SET collection_id = ?, sort_order = ? WHERE id = ?').run(
    newCollectionId,
    sortOrder,
    id,
  );
}

/** Rewrites sort_order (0..n-1) for a set of sibling connections, in the given order. */
export function reorderMessagingConnections(db: Database.Database, orderedIds: string[]): void {
  reorderConnectionRows(db, 'messaging_connections', orderedIds);
}

/** The 'messaging' category's collection/folder/connection tree. */
export function getMessagingTree(
  db: Database.Database,
  workspaceId: string,
): ConnectionTreeNode<MessagingConnection>[] {
  const { roots, nodesById } = assembleTree<ConnectionTreeNode<MessagingConnection>>(
    listCategoryCollections(db, workspaceId, 'messaging'),
    (node) => ({ ...node, children: [], connections: [] }),
  );
  for (const connection of listMessagingConnections(db, workspaceId)) {
    nodesById.get(connection.collectionId)?.connections.push(connection);
  }
  return roots;
}

/** The 'websocket' category's collection/folder/connection tree. */
export function getWebSocketTree(
  db: Database.Database,
  workspaceId: string,
): ConnectionTreeNode<WebSocketConnection>[] {
  const { roots, nodesById } = assembleTree<ConnectionTreeNode<WebSocketConnection>>(
    listCategoryCollections(db, workspaceId, 'websocket'),
    (node) => ({ ...node, children: [], connections: [] }),
  );
  for (const connection of listWebSocketConnections(db, workspaceId)) {
    nodesById.get(connection.collectionId)?.connections.push(connection);
  }
  return roots;
}

/** The 'mcp' category's collection/folder/server tree. */
export function getMcpTree(db: Database.Database, workspaceId: string): ConnectionTreeNode<McpServerConnection>[] {
  const { roots, nodesById } = assembleTree<ConnectionTreeNode<McpServerConnection>>(
    listCategoryCollections(db, workspaceId, 'mcp'),
    (node) => ({ ...node, children: [], connections: [] }),
  );
  for (const connection of listMcpServerConnections(db, workspaceId)) {
    nodesById.get(connection.collectionId)?.connections.push(connection);
  }
  return roots;
}
