// The schema as a string constant (not a separate .sql file read at runtime).
// This keeps the module free of import.meta/__dirname path resolution, which
// otherwise breaks depending on whether the consuming package compiles this
// file as ESM (Vitest, a browser bundle) or CommonJS (a Node host process) —
// and it sidesteps packaged-archive path issues once a host app is built.
/** The messaging_connections table and its index: part of SCHEMA_SQL, and
 * created on its own by migration 4 (migrations.ts) for older databases. */
export const MESSAGING_CONNECTIONS_SQL = `
-- Saved broker connections (MQTT, Kafka, Socket.IO, AMQP, NATS), in the
-- 'messaging' category. See types.ts's MessagingConnection: settings_json is
-- the protocol's protocolConfig, subscriptions_json what to subscribe to again
-- on each connect. Created by migration 4, which also let collections have the
-- 'messaging' category.
CREATE TABLE IF NOT EXISTS messaging_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('mqtt', 'kafka', 'socketio', 'amqp', 'nats')),
  url TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '[]',
  auth_json TEXT NOT NULL DEFAULT '{"type":"none"}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  subscriptions_json TEXT NOT NULL DEFAULT '[]',
  verify_tls INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messaging_connections_collection ON messaging_connections(collection_id);
`;

export const SCHEMA_SQL = `
-- MVP local-first schema. Everything the engine stores lives here — no server
-- round-trip required for any of it.

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_folder_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('collection', 'folder')),
  -- Which sidebar category this hierarchy belongs to (see types.ts's
  -- CollectionCategory); folders copy their root collection's category.
  -- Added later — see db.ts's migration for pre-existing tables.
  category TEXT NOT NULL DEFAULT 'api' CHECK (category IN ('api', 'websocket', 'mcp', 'messaging')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Records that a category's default collection ('My Collection' /
-- 'My Connections' / 'My MCPs') was created once for a workspace, so it
-- isn't silently re-created after the user deletes it.
CREATE TABLE IF NOT EXISTS workspace_seeds (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (workspace_id, category)
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Pulled out of config_json (which still carries the full RequestConfig,
  -- protocol included) alongside method/url so requests can be filtered/
  -- listed by protocol without deserializing every row. Defaulted for
  -- older rows — see db.ts's migration for tables that predate this column.
  protocol TEXT NOT NULL DEFAULT 'http',
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  config_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  variables_json TEXT NOT NULL DEFAULT '{}'
);

-- Saved WebSocket connections — deliberately its own table, not a row
-- in 'requests': a connection is a persistent session (message history, no
-- body/scripts/single response), not a request, so it gets its own storage
-- entity and its own place in a UI. See types.ts's WebSocketConnection.
CREATE TABLE IF NOT EXISTS ws_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The 'websocket'-category collection/folder holding it. Nullable only
  -- because pre-existing tables gain it via ALTER TABLE (see db.ts);
  -- the repository always sets it and backfills older rows.
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '[]',
  subprotocols_json TEXT NOT NULL DEFAULT '[]',
  auth_json TEXT NOT NULL DEFAULT '{"type":"none"}',
  -- 0 skips checking the server's TLS certificate (RequestConfig.verifyTls).
  verify_tls INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Saved MCP server connections — same rationale as ws_connections
-- above: a persistent session (tools/resources/prompts, call history), not
-- a request. See types.ts's McpServerConnection.
CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The 'mcp'-category collection/folder holding it — same caveat as
  -- ws_connections.collection_id above.
  collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
  command TEXT NOT NULL,
  args_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '[]',
  -- http only; see ws_connections.verify_tls.
  verify_tls INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_history (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES requests(id) ON DELETE SET NULL,
  executed_at INTEGER NOT NULL,
  status INTEGER,
  duration_ms REAL,
  response_json TEXT
);

-- Indexes matter early: the performance budget is a 10,000-request
-- collection tree loading in under a second, and the sidebar staying at
-- 60fps while scrolling. Both depend on the request/collection lookups
-- below being indexed, not scanned.
${MESSAGING_CONNECTIONS_SQL}

CREATE INDEX IF NOT EXISTS idx_collections_workspace ON collections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_folder_id);
CREATE INDEX IF NOT EXISTS idx_requests_collection ON requests(collection_id);
CREATE INDEX IF NOT EXISTS idx_history_request ON request_history(request_id);
CREATE INDEX IF NOT EXISTS idx_ws_connections_workspace ON ws_connections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_mcp_connections_workspace ON mcp_connections(workspace_id);
`;
