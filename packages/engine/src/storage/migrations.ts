import type Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

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
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
