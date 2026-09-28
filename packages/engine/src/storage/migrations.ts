import type Database from 'better-sqlite3';
import { MESSAGING_CONNECTIONS_SQL, SCHEMA_SQL } from './schema.js';

/**
 * Schema migrations, tracked in SQLite's `PRAGMA user_version`.
 *
 * To change the schema, append a migration with the next version number.
 * Never edit or reorder a migration that has shipped: users' databases have
 * already recorded it as applied. Each migration runs in a transaction with
 * its version bump, so a failure leaves the database as it was.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  /**
   * Runs with foreign keys off, for rebuilding a table other tables refer to
   * (SQLite can't change a CHECK in place). With them on, dropping the old
   * table would cascade-delete every row that refers to it. They go back on
   * afterwards, and the migration only commits if `foreign_key_check` finds
   * nothing broken.
   */
  foreignKeysOff?: boolean;
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export const MIGRATIONS: Migration[] = [
  {
    // Every database created before versioning existed has user_version 0 and
    // could be at any earlier shape, so the baseline is idempotent: create
    // missing tables, then add the columns that later versions introduced
    // (`CREATE TABLE IF NOT EXISTS` doesn't change an existing table).
    version: 1,
    name: 'baseline',
    up(db) {
      db.exec(SCHEMA_SQL);
      // Requests gained a protocol.
      ensureColumn(db, 'requests', 'protocol', "TEXT NOT NULL DEFAULT 'http'");
      // Sidebar categories: collections gain a category (existing
      // ones are all 'api'), and saved connections gain a collection and a
      // sort order. Existing connections keep a NULL collection_id here and
      // are adopted into their category's default collection by
      // getOrCreateDefaultWorkspace (repository.ts). The indexes live here,
      // not in schema.ts, because on an older database they'd otherwise be
      // created before their columns exist.
      ensureColumn(
        db,
        'collections',
        'category',
        "TEXT NOT NULL DEFAULT 'api' CHECK (category IN ('api', 'websocket', 'mcp'))",
      );
      for (const table of ['ws_connections', 'mcp_connections']) {
        ensureColumn(db, table, 'collection_id', 'TEXT REFERENCES collections(id) ON DELETE CASCADE');
        ensureColumn(db, table, 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_collections_category ON collections(workspace_id, category);
        CREATE INDEX IF NOT EXISTS idx_ws_connections_collection ON ws_connections(collection_id);
        CREATE INDEX IF NOT EXISTS idx_mcp_connections_collection ON mcp_connections(collection_id);
      `);
    },
  },
  {
    // request_history existed from the start, unused. It gains what a history
    // list needs (storage/history.ts): its workspace (deleting the workspace
    // deletes its history), what was sent, the test results, whether the
    // stored body was truncated, and a send error. Newest-first listing per
    // workspace is indexed.
    version: 2,
    name: 'request history',
    up(db) {
      ensureColumn(db, 'request_history', 'workspace_id', 'TEXT REFERENCES workspaces(id) ON DELETE CASCADE');
      ensureColumn(db, 'request_history', 'name', 'TEXT');
      ensureColumn(db, 'request_history', 'protocol', 'TEXT');
      ensureColumn(db, 'request_history', 'method', 'TEXT');
      ensureColumn(db, 'request_history', 'url', 'TEXT');
      ensureColumn(db, 'request_history', 'request_json', 'TEXT');
      ensureColumn(db, 'request_history', 'size_bytes', 'INTEGER');
      ensureColumn(db, 'request_history', 'tests_passed', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'request_history', 'tests_total', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'request_history', 'response_truncated', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'request_history', 'error', 'TEXT');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_history_workspace ON request_history(workspace_id, executed_at DESC, id DESC)',
      );
    },
  },
  {
    // Saved connections gain the TLS certificate check setting
    // (RequestConfig.verifyTls), on for every existing connection. Saved
    // requests carry it in config_json, so they need no change.
    version: 3,
    name: 'connection TLS verification',
    up(db) {
      ensureColumn(db, 'ws_connections', 'verify_tls', 'INTEGER NOT NULL DEFAULT 1');
      ensureColumn(db, 'mcp_connections', 'verify_tls', 'INTEGER NOT NULL DEFAULT 1');
    },
  },
  {
    // The 'messaging' category and its connections table. Collections gain
    // the category by rebuilding the table (its CHECK lists the categories),
    // following SQLite's procedure: foreign keys off, copy, drop, rename,
    // indexes back. A database created with the current schema already
    // allows it and keeps its table.
    version: 4,
    name: 'messaging connections',
    foreignKeysOff: true,
    up(db) {
      const { sql } = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'collections'")
        .get() as {
        sql: string;
      };
      if (!sql.includes("'messaging'")) {
        db.exec(`
          CREATE TABLE collections_new (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            parent_folder_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (kind IN ('collection', 'folder')),
            category TEXT NOT NULL DEFAULT 'api' CHECK (category IN ('api', 'websocket', 'mcp', 'messaging')),
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
          );
          INSERT INTO collections_new (id, workspace_id, parent_folder_id, name, kind, category, sort_order, created_at)
            SELECT id, workspace_id, parent_folder_id, name, kind, category, sort_order, created_at FROM collections;
          DROP TABLE collections;
          ALTER TABLE collections_new RENAME TO collections;
          CREATE INDEX IF NOT EXISTS idx_collections_workspace ON collections(workspace_id);
          CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_folder_id);
          CREATE INDEX IF NOT EXISTS idx_collections_category ON collections(workspace_id, category);
        `);
      }
      // The table and its index, as in schema.ts (a no-op where they exist).
      db.exec(MESSAGING_CONNECTIONS_SQL);
    },
  },
  {
    // A cookie jar per workspace (storage/cookies.ts): what responses set,
    // one row per domain, path and name, deleted with the workspace.
    version: 5,
    name: 'cookies',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cookies (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          domain TEXT NOT NULL,
          path TEXT NOT NULL,
          name TEXT NOT NULL,
          value TEXT NOT NULL,
          host_only INTEGER NOT NULL,
          expires_at INTEGER,
          secure INTEGER NOT NULL,
          http_only INTEGER NOT NULL,
          same_site TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, domain, path, name)
        );
      `);
    },
  },
  {
    // OAuth 2.0 tokens per workspace (storage/oauth2Tokens.ts), by
    // oauth2TokenKey, so requests with the same client share one.
    version: 6,
    name: 'OAuth 2.0 tokens',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth2_tokens (
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          key TEXT NOT NULL,
          token_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, key)
        );
      `);
    },
  },
];

export class DatabaseTooNewError extends Error {
  constructor(
    readonly databaseVersion: number,
    readonly supportedVersion: number,
  ) {
    super(
      `This database was created by a newer version of the app (schema v${databaseVersion}; ` +
        `this version supports up to v${supportedVersion}). Update the app to open it.`,
    );
    this.name = 'DatabaseTooNewError';
  }
}

export function schemaVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/** Applies every migration newer than the database's recorded version, in order. */
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  const latest = migrations.at(-1)?.version ?? 0;
  const current = schemaVersion(db);
  if (current > latest) throw new DatabaseTooNewError(current, latest);

  for (const migration of migrations) {
    if (migration.version <= current) continue;
    // The pragma has no effect inside a transaction, so it's set around it.
    const foreignKeysWereOn = migration.foreignKeysOff && db.pragma('foreign_keys', { simple: true }) === 1;
    if (migration.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        migration.up(db);
        if (migration.foreignKeysOff) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0)
            throw new Error(`Migration ${migration.version} would break ${broken.length} reference(s).`);
        }
        db.pragma(`user_version = ${migration.version}`);
      })();
    } finally {
      if (foreignKeysWereOn) db.pragma('foreign_keys = ON');
    }
  }
}
