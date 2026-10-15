import type Database from 'better-sqlite3';
import {
  COLLECTION_CATEGORIES,
  getCollectionTree,
  getMcpTree,
  getMessagingTree,
  getWebSocketTree,
  listEnvironments,
} from '../storage/repository.js';
import { listWorkspaceResponseExamplesFull } from '../storage/examples.js';
import {
  DEFAULT_ENGINE_PROFILE,
  NATIVE_EXPORT_VERSION,
  type ExampleRequest,
  type NativeExportCollection,
  type NativeExportExample,
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

export function blank(value: string): string {
  return VARIABLE_REFERENCE.test(value) ? value : '';
}

export function stripKeyValues(list: KeyValue[]): KeyValue[] {
  return list.map((kv) => (isSecretName(kv.key) ? { ...kv, value: blank(kv.value) } : kv));
}

export function stripAuth(auth: AuthConfig): AuthConfig {
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

/** Secret-named variables, and those marked secret, blanked. */
function stripVariables(variables: Record<string, string>, secrets: string[] = []): Record<string, string> {
  return Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, isSecretName(k) || secrets.includes(k) ? blank(v) : v]),
  );
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
  /** Each request's response examples, loaded in one query too. */
  examples: Map<string, NativeExportExample[]>;
}

function loadExamples(db: Database.Database, workspaceId: string): Map<string, NativeExportExample[]> {
  const byRequest = new Map<string, NativeExportExample[]>();
  for (const [requestId, examples] of listWorkspaceResponseExamplesFull(db, workspaceId)) {
    byRequest.set(
      requestId,
      examples.map(({ name, status, statusText, headers, body, request, isDefault }) => ({
        name,
        status,
        statusText,
        headers,
        body,
        ...(request && { request }),
        ...(isDefault && { isDefault }),
      })),
    );
  }
  return byRequest;
}

function stripHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, isSecretName(name) ? blank(value) : value]),
  );
}

function decodeOrKeep(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
}

/** A URL with its secret-named query parameters' values blanked; not parsed, since it may hold variables. */
function stripUrl(url: string): string {
  const hash = url.indexOf('#');
  const [base, fragment] = hash >= 0 ? [url.slice(0, hash), url.slice(hash)] : [url, ''];
  const at = base.indexOf('?');
  if (at < 0) return url;
  const query = base
    .slice(at + 1)
    .split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0 || !isSecretName(decodeOrKeep(part.slice(0, eq)))) return part;
      return `${part.slice(0, eq)}=${blank(decodeOrKeep(part.slice(eq + 1)))}`;
    })
    .join('&');
  return `${base.slice(0, at)}?${query}${fragment}`;
}

/** The request an example keeps, with its secret-named headers and query parameters blanked. */
export function stripExampleRequest(request: ExampleRequest): ExampleRequest {
  return { ...request, url: stripUrl(request.url), headers: stripHeaders(request.headers) };
}

/** An example with its secret-named headers (Set-Cookie, say) blanked, and its request's. */
function stripExample(example: NativeExportExample): NativeExportExample {
  return {
    ...example,
    headers: stripHeaders(example.headers),
    ...(example.request && { request: stripExampleRequest(example.request) }),
  };
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
  const examples = ctx.examples.get(requestId);
  return {
    type: 'request',
    name,
    config: out,
    ...(examples && { examples: ctx.includeSecrets ? examples : examples.map(stripExample) }),
  };
}

function wsItem(c: WebSocketConnection, includeSecrets: boolean): NativeExportItem {
  return {
    type: 'websocket',
    name: c.name,
    url: c.url,
    headers: includeSecrets ? c.headers : stripKeyValues(c.headers),
    subprotocols: c.subprotocols,
    auth: includeSecrets ? c.auth : stripAuth(c.auth),
    // Only when the connection sets it: unset, it follows the importer's default.
    ...(c.verifyTls !== undefined && { verifyTls: c.verifyTls }),
    ...(c.testScript && { testScript: c.testScript }),
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
    ...(c.verifyTls !== undefined && { verifyTls: c.verifyTls }),
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
    ...(c.verifyTls !== undefined && { verifyTls: c.verifyTls }),
    ...(c.testScript && { testScript: c.testScript }),
  };
}

/** A protocol's settings, with secret-named fields blanked, including inside
 * a nested object such as Socket.IO's `auth` payload. */
export function stripSettings(settings: Record<string, unknown>): Record<string, unknown> {
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
 * `exportFormat`, with a `generator` block naming the profile's product and
 * script namespace (and `options.appVersion`, when given). Output is deterministic for the same data (apart from
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

  const ctx: ExportContext = {
    includeSecrets,
    requestConfigs: loadRequestConfigs(db, workspaceId),
    examples: loadExamples(db, workspaceId),
  };
  const wanted = new Set(options.environmentIds);
  const environments = (
    target.scope === 'workspace'
      ? listEnvironments(db, workspaceId)
      : [...listEnvironments(db, workspaceId), ...listEnvironments(db, null)].filter((env) => wanted.has(env.id))
  ).map((env) => ({
    name: env.name,
    variables: includeSecrets ? env.variables : stripVariables(env.variables, env.secrets),
  }));

  return {
    format: profile.exportFormat,
    version: NATIVE_EXPORT_VERSION,
    scope: target.scope,
    exportedAt: new Date().toISOString(),
    secretsStripped: !includeSecrets,
    generator: {
      name: profile.productName,
      ...(options.appVersion !== undefined && { version: options.appVersion }),
      scriptNamespace: profile.scriptNamespace,
    },
    collections: roots.map((node) => toCollection(ctx, node)),
    environments,
  };
}

/** Pretty-printed, newline-terminated — the on-disk form. */
export function serializeNativeExport(doc: NativeExportDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}
