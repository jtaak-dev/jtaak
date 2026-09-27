import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './db';
import { MIGRATIONS, migrate, schemaVersion } from './migrations';
import {
  createCollectionNode,
  createMessagingConnection,
  createRequest,
  createWebSocketConnection,
  createWorkspace,
  deleteCollectionNode,
  getMessagingConnection,
  getMessagingTree,
  getOrCreateDefaultWorkspace,
  getRequest,
  moveMessagingConnection,
  renameMessagingConnection,
  reorderMessagingConnections,
  updateMessagingConnection,
} from './repository';

function messagingRoot(db: Database.Database) {
  const { workspace } = getOrCreateDefaultWorkspace(db);
  return { workspaceId: workspace.id, rootId: getMessagingTree(db, workspace.id)[0].id };
}

describe('messaging connections', () => {
  it('seeds a "My Brokers" collection in the messaging category', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    expect(getMessagingTree(db, workspace.id).map((c) => [c.name, c.category])).toEqual([['My Brokers', 'messaging']]);
  });

  it('creates, updates, renames and reads back a connection', () => {
    const db = openDatabase(':memory:');
    const { rootId } = messagingRoot(db);
    const created = createMessagingConnection(db, {
      collectionId: rootId,
      name: 'Sensors',
      protocol: 'mqtt',
      url: 'mqtt://localhost:1883',
    });
    expect(created).toMatchObject({ settings: {}, subscriptions: [], verifyTls: true, auth: { type: 'none' } });

    updateMessagingConnection(db, created.id, {
      protocol: 'mqtt',
      url: 'mqtts://broker:8883',
      headers: [{ key: 'x', value: '1', enabled: true }],
      auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } },
      settings: { protocolVersion: 5, clientId: 'c1' },
      subscriptions: [{ channel: 'sensors/#', options: { qos: 1 } }],
      verifyTls: false,
    });
    renameMessagingConnection(db, created.id, 'Sensors (TLS)');

    expect(getMessagingConnection(db, created.id)).toMatchObject({
      name: 'Sensors (TLS)',
      url: 'mqtts://broker:8883',
      settings: { protocolVersion: 5, clientId: 'c1' },
      subscriptions: [{ channel: 'sensors/#', options: { qos: 1 } }],
      auth: { type: 'basic', basic: { username: 'alice', password: 'secret' } },
      verifyTls: false,
    });
  });

  it('keeps verifyTls when an update leaves it out', () => {
    const db = openDatabase(':memory:');
    const { rootId } = messagingRoot(db);
    const c = createMessagingConnection(db, {
      collectionId: rootId,
      name: 'k',
      protocol: 'kafka',
      url: 'kafka://h:9092',
    });
    const patch = {
      protocol: 'kafka' as const,
      url: 'kafka://h:9092',
      headers: [],
      auth: { type: 'none' as const },
      settings: {},
      subscriptions: [],
    };
    updateMessagingConnection(db, c.id, { ...patch, verifyTls: false });
    updateMessagingConnection(db, c.id, patch);
    expect(getMessagingConnection(db, c.id)?.verifyTls).toBe(false);
  });

  it('only lives in messaging collections, and moves and reorders within them', () => {
    const db = openDatabase(':memory:');
    const { workspaceId, rootId } = messagingRoot(db);
    const apiRoot = createCollectionNode(db, { workspaceId, parentFolderId: null, name: 'API', kind: 'collection' });
    expect(() =>
      createMessagingConnection(db, { collectionId: apiRoot.id, name: 'x', protocol: 'nats', url: 'nats://h' }),
    ).toThrow();

    const folder = createCollectionNode(db, { workspaceId, parentFolderId: rootId, name: 'Prod', kind: 'folder' });
    const a = createMessagingConnection(db, { collectionId: rootId, name: 'a', protocol: 'nats', url: 'nats://a' });
    const b = createMessagingConnection(db, { collectionId: rootId, name: 'b', protocol: 'amqp', url: 'amqp://b' });
    reorderMessagingConnections(db, [b.id, a.id]);
    expect(getMessagingTree(db, workspaceId)[0].connections.map((c) => c.name)).toEqual(['b', 'a']);

    moveMessagingConnection(db, a.id, folder.id);
    expect(getMessagingTree(db, workspaceId)[0].children[0].connections.map((c) => c.name)).toEqual(['a']);
    expect(() => moveMessagingConnection(db, a.id, apiRoot.id)).toThrow();
  });

  it('is deleted with its collection', () => {
    const db = openDatabase(':memory:');
    const { rootId } = messagingRoot(db);
    const c = createMessagingConnection(db, { collectionId: rootId, name: 'x', protocol: 'socketio', url: 'http://h' });
    deleteCollectionNode(db, rootId);
    expect(getMessagingConnection(db, c.id)).toBeUndefined();
  });
});

describe('migration 4', () => {
  /** A database from schema v3: collections without the 'messaging' category, and no messaging table. */
  function versionThreeDatabase(): string {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-m4-')), 'jtaak.db');
    const db = openDatabase(file);
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE messaging_connections;
      CREATE TABLE collections_v3 (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_folder_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('collection', 'folder')),
        category TEXT NOT NULL DEFAULT 'api' CHECK (category IN ('api', 'websocket', 'mcp')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      INSERT INTO collections_v3 SELECT * FROM collections WHERE category != 'messaging';
      DELETE FROM workspace_seeds WHERE category = 'messaging';
      DROP TABLE collections;
      ALTER TABLE collections_v3 RENAME TO collections;
    `);
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 3');
    db.close();
    return file;
  }

  it('lets collections be messaging ones, keeping every row and every reference', () => {
    const file = versionThreeDatabase();
    // Some data at v3, written with the migrations only up to 3.
    // (Not getOrCreateDefaultWorkspace: it would seed the messaging category, which v3 can't hold.)
    const v3 = openDatabaseAt(file, 3);
    const workspace = createWorkspace(v3, 'Old');
    const api = createCollectionNode(v3, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: 'API',
      kind: 'collection',
    });
    const folder = createCollectionNode(v3, {
      workspaceId: workspace.id,
      parentFolderId: api.id,
      name: 'Admin',
      kind: 'folder',
    });
    const request = createRequest(v3, {
      collectionId: folder.id,
      name: 'List',
      config: {
        id: '',
        name: 'List',
        method: 'GET',
        url: '/x',
        params: [],
        headers: [],
        body: { mode: 'none' },
        auth: { type: 'none' },
      },
    });
    const wsRoot = createCollectionNode(v3, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: 'Sockets',
      kind: 'collection',
      category: 'websocket',
    });
    const ws = createWebSocketConnection(v3, { collectionId: wsRoot.id, name: 'Chat', url: 'wss://x' });
    const before = v3.prepare('SELECT count(*) AS n FROM collections').get() as { n: number };
    v3.close();

    const db = openDatabase(file);
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(db.prepare('SELECT count(*) AS n FROM collections').get()).toEqual(before);
    expect(getRequest(db, request.id)?.name).toBe('List');
    expect(db.prepare('SELECT collection_id FROM ws_connections WHERE id = ?').get(ws.id)).toEqual({
      collection_id: wsRoot.id,
    });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // The messaging category works, and is seeded on the next open.
    getOrCreateDefaultWorkspace(db);
    const { rootId } = messagingRoot(db);
    createMessagingConnection(db, { collectionId: rootId, name: 'm', protocol: 'mqtt', url: 'mqtt://h' });

    // References still cascade after the rebuild.
    deleteCollectionNode(db, api.id);
    expect(getRequest(db, request.id)).toBeUndefined();
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'collections'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_collections_workspace', 'idx_collections_parent', 'idx_collections_category']),
    );
    db.close();
  });
});

/** Opens a database file with the migrations only up to `version`. */
function openDatabaseAt(file: string, version: number): Database.Database {
  // openDatabase always migrates to the latest, so the file is opened directly.
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  migrate(
    raw,
    MIGRATIONS.filter((m) => m.version <= version),
  );
  return raw;
}
