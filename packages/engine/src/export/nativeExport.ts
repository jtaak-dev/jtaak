import type Database from 'better-sqlite3';
import {
  COLLECTION_CATEGORIES,
  getCollectionTree,
  getMcpTree,
  getMessagingTree,
  getWebSocketTree,
  listEnvironments,
} from '../storage/repository.js';
import {
  DEFAULT_ENGINE_PROFILE,
  NATIVE_EXPORT_VERSION,
  type NativeExportCollection,
  type NativeExportDocument,
  type NativeExportFolder,
  type NativeExportItem,
  type NativeExportOptions,
  type NativeExportTarget,
  type AuthConfig,
  type EngineProfile,
  type CollectionCategory,
  type CollectionNode,
  type CollectionTreeNode,
  type ConnectionTreeNode,
  type KeyValue,
  type McpServerConnection,
  type MessagingConnection,
  type RequestConfig,
  type WebSocketConnection,
} from '../types.js';

// ---- Secret stripping ------------------------------------------------------

// Header/param/variable names that usually hold credentials. Deliberately a
// name heuristic, not "blank everything": blanking every environment value
// would also wipe `baseUrl` and friends, making a shared environment useless.
const SECRET_NAME =
  /authorization|cookie|token|secret|passw(or)?d|api[-_]?key|access[-_]?key|private[-_]?key|credential|session/i;

// A value that is only a `{{variable}}` reference holds no secret itself —
// keeping it is what lets a teammate plug in their own environment.
const VARIABLE_REFERENCE = /^\s*\{\{[^{}]+\}\}\s*$/;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

function blank(value: string): string {
  return VARIABLE_REFERENCE.test(value) ? value : '';
}

function stripKeyValues(list: KeyValue[]): KeyValue[] {
  return list.map((kv) => (isSecretName(kv.key) ? { ...kv, value: blank(kv.value) } : kv));
}

function stripAuth(auth: AuthConfig): AuthConfig {
  return {
    ...auth,
    ...(auth.basic && { basic: { ...auth.basic, password: blank(auth.basic.password) } }),
    ...(auth.bearer && { bearer: { token: blank(auth.bearer.token) } }),
    ...(auth.apiKey && { apiKey: { ...auth.apiKey, value: blank(auth.apiKey.value) } }),
    ...(auth.digest && { digest: { ...auth.digest, password: blank(auth.digest.password) } }),
    ...(auth.oauth2 && { oauth2: stripOAuth2(auth.oauth2) }),
  };
}

/** An OAuth 2.0 client secret and password are blanked, and a token the request carries is left out. */
function stripOAuth2({
  token: _token,
  ...oauth2
}: NonNullable<AuthConfig['oauth2']>): NonNullable<AuthConfig['oauth2']> {
  return {
    ...oauth2,
    ...(oauth2.clientSecret !== undefined && { clientSecret: blank(oauth2.clientSecret) }),
    ...(oauth2.password !== undefined && { password: blank(oauth2.password) }),
  };
}

function stripVariables(variables: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(variables).map(([k, v]) => [k, isSecretName(k) ? blank(v) : v]));
}

// ---- Tree → export shape ---------------------------------------------------

type AnyTreeNode =
  | CollectionTreeNode
  | ConnectionTreeNode<WebSocketConnection>
  | ConnectionTreeNode<McpServerConnection>
  | ConnectionTreeNode<MessagingConnection>;

interface ExportContext {
  includeSecrets: boolean;
  /** Full request configs for the workspace, loaded in one query — the tree
   * itself only carries summaries (see getCollectionTree). */
  requestConfigs: Map<string, RequestConfig>;
}

function loadRequestConfigs(db: Database.Database, workspaceId: string): Map<string, RequestConfig> {
  const rows = db
    .prepare(
      'SELECT r.id, r.config_json FROM requests r JOIN collections c ON c.id = r.collection_id WHERE c.workspace_id = ?',
    )
    .all(workspaceId) as { id: string; config_json: string }[];
  return new Map(rows.map((row) => [row.id, JSON.parse(row.config_json) as RequestConfig]));
}

function requestItem(ctx: ExportContext, requestId: string, name: string): NativeExportItem | undefined {
  const saved = ctx.requestConfigs.get(requestId);
  if (!saved) return undefined;
  const { id: _id, name: _name, ...config } = saved;
  const out: Omit<RequestConfig, 'id' | 'name'> = ctx.includeSecrets
    ? config
    : {
        ...config,
        params: stripKeyValues(config.params),
        headers: stripKeyValues(config.headers),
        auth: stripAuth(config.auth),
      };
  return { type: 'request', name, config: out };
}

function wsItem(c: WebSocketConnection, includeSecrets: boolean): NativeExportItem {
  return {
    type: 'websocket',
    name: c.name,
    url: c.url,
    headers: includeSecrets ? c.headers : stripKeyValues(c.headers),
    subprotocols: c.subprotocols,
    auth: includeSecrets ? c.auth : stripAuth(c.auth),
    // Only when off, so files for the usual case don't change.
    ...(!c.verifyTls && { verifyTls: false }),
  };
}

function mcpItem(c: McpServerConnection, includeSecrets: boolean): NativeExportItem {
  return {
    type: 'mcp',
    name: c.name,
    transport: c.transport,
    command: c.command,
    args: c.args,
    env: includeSecrets ? c.env : stripKeyValues(c.env),
    headers: includeSecrets ? c.headers : stripKeyValues(c.headers),
    ...(!c.verifyTls && { verifyTls: false }),
  };
}

function messagingItem(c: MessagingConnection, includeSecrets: boolean): NativeExportItem {
  return {
    type: 'messaging',
    name: c.name,
    protocol: c.protocol,
    url: c.url,
    headers: includeSecrets ? c.headers : stripKeyValues(c.headers),
    auth: includeSecrets ? c.auth : stripAuth(c.auth),
    settings: includeSecrets ? c.settings : stripSettings(c.settings),
    subscriptions: c.subscriptions,
    ...(!c.verifyTls && { verifyTls: false }),
  };
}

/** A protocol's settings, with secret-named fields blanked, including inside
 * a nested object such as Socket.IO's `auth` payload. */
function stripSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).map(([key, value]) => {
      if (typeof value === 'string' && isSecretName(key)) return [key, blank(value)];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return [key, stripSettings(value as Record<string, unknown>)];
      }
      return [key, value];
    }),
  );
}

function toFolder(ctx: ExportContext, node: AnyTreeNode): NativeExportFolder {
  let items: NativeExportItem[];
  if ('requests' in node) {
    items = node.requests.flatMap((r) => requestItem(ctx, r.id, r.name) ?? []);
  } else if (node.category === 'websocket') {
    items = (node.connections as WebSocketConnection[]).map((c) => wsItem(c, ctx.includeSecrets));
  } else if (node.category === 'messaging') {
    items = (node.connections as MessagingConnection[]).map((c) => messagingItem(c, ctx.includeSecrets));
  } else {
    items = (node.connections as McpServerConnection[]).map((c) => mcpItem(c, ctx.includeSecrets));
  }
  return {
    name: node.name,
    folders: (node.children as AnyTreeNode[]).map((child) => toFolder(ctx, child)),
    items,
  };
}

function toCollection(ctx: ExportContext, node: AnyTreeNode): NativeExportCollection {
  // `category` first so it reads naturally at the top of each collection.
  return { category: node.category, ...toFolder(ctx, node) };
}

function categoryTree(db: Database.Database, workspaceId: string, category: CollectionCategory): AnyTreeNode[] {
  if (category === 'api') return getCollectionTree(db, workspaceId);
  if (category === 'websocket') return getWebSocketTree(db, workspaceId);
  if (category === 'messaging') return getMessagingTree(db, workspaceId);
  return getMcpTree(db, workspaceId);
}

function findNode(nodes: AnyTreeNode[], id: string): AnyTreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children as AnyTreeNode[], id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Builds a native export document, identified by the profile's
 * `exportFormat`. Output is deterministic for the same data (apart from
 * `exportedAt`): fixed key order, tree order from sort_order, no ids or
 * timestamps — so exports can live in Git.
 */
export function exportNative(
  db: Database.Database,
  workspaceId: string,
  target: NativeExportTarget,
  options: NativeExportOptions,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): NativeExportDocument {
  const { includeSecrets } = options;
  let roots: AnyTreeNode[];

  if (target.scope === 'collection') {
    const row = db
      .prepare('SELECT category FROM collections WHERE id = ? AND workspace_id = ?')
      .get(target.nodeId, workspaceId) as Pick<CollectionNode, 'category'> | undefined;
    if (!row) throw new Error('That collection or folder no longer exists.');
    const node = findNode(categoryTree(db, workspaceId, row.category), target.nodeId);
    if (!node) throw new Error('That collection or folder no longer exists.');
    roots = [node];
  } else if (target.scope === 'category') {
    roots = categoryTree(db, workspaceId, target.category);
  } else {
    roots = COLLECTION_CATEGORIES.flatMap((category) => categoryTree(db, workspaceId, category));
  }

  const ctx: ExportContext = { includeSecrets, requestConfigs: loadRequestConfigs(db, workspaceId) };
  const wanted = new Set(options.environmentIds);
  const environments = listEnvironments(db, workspaceId)
    .filter((env) => target.scope === 'workspace' || wanted.has(env.id))
    .map((env) => ({ name: env.name, variables: includeSecrets ? env.variables : stripVariables(env.variables) }));

  return {
    format: profile.exportFormat,
    version: NATIVE_EXPORT_VERSION,
    scope: target.scope,
    exportedAt: new Date().toISOString(),
    secretsStripped: !includeSecrets,
    collections: roots.map((node) => toCollection(ctx, node)),
    environments,
  };
}

/** Pretty-printed, newline-terminated — the on-disk form. */
export function serializeNativeExport(doc: NativeExportDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
