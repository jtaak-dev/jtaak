import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './db';
import {
  createRequest,
  getCollectionTree,
  getMcpTree,
  getOrCreateDefaultWorkspace,
  getRequest,
  getWebSocketTree,
} from './repository';
import type { RequestConfig } from '../types';

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'placeholder',
    name: 'placeholder',
    method: 'GET',
    url: 'https://example.com',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

describe('openDatabase', () => {
  it('is safe to reopen an existing database file (protocol column migration is idempotent)', () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-db-')), 'jtaak.db');

    const first = openDatabase(filePath);
    first.close();

    expect(() => openDatabase(filePath).close()).not.toThrow();
  });

  it('defaults protocol to "http" for requests saved without one', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const defaultCollectionId = getCollectionTree(db, workspace.id)[0].id;

    const saved = createRequest(db, { collectionId: defaultCollectionId, name: 'Ping', config: baseConfig() });

    expect(saved.protocol).toBe('http');
    expect(getRequest(db, saved.id)!.protocol).toBe('http');
  });

  it('migrates a pre-category database: collections become "api", connections are adopted into default collections', () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-db-')), 'jtaak.db');
    // The shapes of these tables before collection categories existed.
    const legacy = new Database(filePath);
    legacy.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE collections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, parent_folder_id TEXT, name TEXT NOT NULL,
        kind TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE ws_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL,
        headers_json TEXT NOT NULL DEFAULT '[]', subprotocols_json TEXT NOT NULL DEFAULT '[]',
        auth_json TEXT NOT NULL DEFAULT '{"type":"none"}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE mcp_connections (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, transport TEXT NOT NULL, command TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '[]', env_json TEXT NOT NULL DEFAULT '[]', headers_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES ('ws1', 'My Workspace', 0);
      INSERT INTO collections VALUES ('c1', 'ws1', NULL, 'Users API', 'collection', 0, 0);
      INSERT INTO ws_connections (id, workspace_id, name, url, created_at, updated_at) VALUES ('w1', 'ws1', 'Chat', 'wss://x', 0, 0);
      INSERT INTO mcp_connections (id, workspace_id, name, transport, command, created_at, updated_at) VALUES ('m1', 'ws1', 'Tools', 'stdio', 'npx', 0, 0);
    `);
    legacy.close();

    const db = openDatabase(filePath);
    getOrCreateDefaultWorkspace(db);

    expect(getCollectionTree(db, 'ws1').map((n) => n.name)).toEqual(['Users API']);
    const [wsRoot] = getWebSocketTree(db, 'ws1');
    expect(wsRoot.name).toBe('My Connections');
    expect(wsRoot.connections.map((c) => c.id)).toEqual(['w1']);
    const [mcpRoot] = getMcpTree(db, 'ws1');
    expect(mcpRoot.name).toBe('My MCPs');
    expect(mcpRoot.connections.map((c) => c.id)).toEqual(['m1']);
    db.close();
  });
});
