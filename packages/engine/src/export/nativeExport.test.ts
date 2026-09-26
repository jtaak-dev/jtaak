import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import {
  createCollectionNode,
  createEnvironment,
  createMcpServerConnection,
  createRequest,
  createWebSocketConnection,
  getCollectionTree,
  getMcpTree,
  getOrCreateDefaultWorkspace,
  getWebSocketTree,
  updateEnvironmentVariables,
  updateMcpServerConnection,
  updateWebSocketConnection,
} from '../storage/repository';
import { DEFAULT_ENGINE_PROFILE, type RequestConfig } from '../types';
import { exportNative, isSecretName, serializeNativeExport } from './nativeExport';

function baseConfig(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'x',
    name: 'x',
    method: 'GET',
    url: 'https://example.com',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

/** A workspace with one item of each category (in the seeded default
 * collections), a nested folder under the API collection, and two environments. */
function fixture(db: Database.Database) {
  const { workspace } = getOrCreateDefaultWorkspace(db);
  const apiId = getCollectionTree(db, workspace.id)[0].id;
  const wsCollectionId = getWebSocketTree(db, workspace.id)[0].id;
  const mcpCollectionId = getMcpTree(db, workspace.id)[0].id;

  const folder = createCollectionNode(db, {
    workspaceId: workspace.id,
    parentFolderId: apiId,
    name: 'Admin',
    kind: 'folder',
  });
  createRequest(db, {
    collectionId: apiId,
    name: 'List users',
    config: baseConfig({
      url: '{{baseUrl}}/users',
      headers: [
        { key: 'Authorization', value: 'Bearer abc', enabled: true },
        { key: 'X-Trace', value: 'keep-me', enabled: true },
        { key: 'X-Api-Key', value: '{{apiKey}}', enabled: true },
      ],
      params: [{ key: 'access_token', value: 'qs-secret', enabled: true }],
      auth: { type: 'basic', basic: { username: 'alice', password: 'hunter2' } },
      testScript: 'jt.test("ok", () => {})',
    }),
  });
  createRequest(db, { collectionId: folder.id, name: 'Delete user', config: baseConfig({ method: 'DELETE' }) });

  const ws = createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'Echo', url: 'wss://echo.example' });
  updateWebSocketConnection(db, ws.id, {
    url: 'wss://echo.example',
    headers: [],
    subprotocols: ['json'],
    auth: { type: 'bearer', bearer: { token: 'ws-token' } },
  });
  const mcp = createMcpServerConnection(db, {
    collectionId: mcpCollectionId,
    name: 'FS',
    transport: 'stdio',
    command: 'npx',
  });
  updateMcpServerConnection(db, mcp.id, {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'server-fs'],
    env: [
      { key: 'GITHUB_TOKEN', value: 'ghp_x', enabled: true },
      { key: 'LOG_LEVEL', value: 'debug', enabled: true },
    ],
    headers: [],
  });

  const staging = createEnvironment(db, workspace.id, 'Staging');
  updateEnvironmentVariables(db, staging.id, { baseUrl: 'https://staging', apiKey: 'env-secret' });
  const prod = createEnvironment(db, workspace.id, 'Prod');

  return { workspaceId: workspace.id, apiId, folderId: folder.id, stagingId: staging.id, prodId: prod.id };
}

const noSecrets = { includeSecrets: false, environmentIds: [] };

describe('exportNative scopes', () => {
  it('exports one collection with its nested folders and items, in tree order', () => {
    const db = openDatabase(':memory:');
    const { workspaceId, apiId } = fixture(db);
    const doc = exportNative(db, workspaceId, { scope: 'collection', nodeId: apiId }, noSecrets);

    expect(doc).toMatchObject({
      format: 'jtaak-export',
      version: 1,
      scope: 'collection',
      secretsStripped: true,
      environments: [],
    });
    expect(doc.collections).toHaveLength(1);
    const [collection] = doc.collections;
    expect(collection).toMatchObject({ category: 'api', name: 'My Collection' });
    expect(collection.items.map((i) => i.name)).toEqual(['List users']);
    expect(collection.folders).toEqual([
      { name: 'Admin', folders: [], items: [expect.objectContaining({ name: 'Delete user' })] },
    ]);
    // No database ids leak into the file.
    expect(JSON.stringify(doc)).not.toContain(apiId);
  });

  it('exports a folder as a collection of its own', () => {
    const db = openDatabase(':memory:');
    const { workspaceId, folderId } = fixture(db);
    const doc = exportNative(db, workspaceId, { scope: 'collection', nodeId: folderId }, noSecrets);
    expect(doc.collections).toEqual([
      {
        category: 'api',
        name: 'Admin',
        folders: [],
        items: [expect.objectContaining({ type: 'request', name: 'Delete user' })],
      },
    ]);
  });

  it('exports a whole category', () => {
    const db = openDatabase(':memory:');
    const { workspaceId } = fixture(db);
    const doc = exportNative(db, workspaceId, { scope: 'category', category: 'websocket' }, noSecrets);
    expect(doc.collections.map((c) => c.category)).toEqual(['websocket']);
    expect(doc.collections[0].items[0]).toMatchObject({ type: 'websocket', name: 'Echo', subprotocols: ['json'] });
  });

  it('exports the workspace: every category and every environment', () => {
    const db = openDatabase(':memory:');
    const { workspaceId } = fixture(db);
    const doc = exportNative(db, workspaceId, { scope: 'workspace' }, noSecrets);
    expect(doc.collections.map((c) => c.category)).toEqual(['api', 'websocket', 'mcp']);
    expect(doc.environments.map((e) => e.name).sort()).toEqual(['Prod', 'Staging']);
  });

  it('includes only the chosen environments for collection/category exports', () => {
    const db = openDatabase(':memory:');
    const { workspaceId, apiId, stagingId } = fixture(db);
    const doc = exportNative(
      db,
      workspaceId,
      { scope: 'collection', nodeId: apiId },
      { includeSecrets: false, environmentIds: [stagingId] },
    );
    expect(doc.environments.map((e) => e.name)).toEqual(['Staging']);
  });

  it('rejects a node that does not exist', () => {
    const db = openDatabase(':memory:');
    const { workspaceId } = fixture(db);
    expect(() => exportNative(db, workspaceId, { scope: 'collection', nodeId: 'missing' }, noSecrets)).toThrow(
      /no longer exists/,
    );
  });

  it('is deterministic apart from exportedAt', () => {
    const db = openDatabase(':memory:');
    const { workspaceId } = fixture(db);
    const a = { ...exportNative(db, workspaceId, { scope: 'workspace' }, noSecrets), exportedAt: '' };
    const b = { ...exportNative(db, workspaceId, { scope: 'workspace' }, noSecrets), exportedAt: '' };
    expect(serializeNativeExport(a)).toBe(serializeNativeExport(b));
    expect(serializeNativeExport(a).endsWith('}\n')).toBe(true);
  });
});

describe('exportNative format id', () => {
  it("uses jtaak-export by default, or the profile's format id", () => {
    const db = openDatabase(':memory:');
    const workspaceId = getOrCreateDefaultWorkspace(db).workspace.id;
    const options = { includeSecrets: false, environmentIds: [] };
    expect(exportNative(db, workspaceId, { scope: 'workspace' }, options).format).toBe('jtaak-export');
    const acme = { ...DEFAULT_ENGINE_PROFILE, exportFormat: 'acme-export' };
    expect(exportNative(db, workspaceId, { scope: 'workspace' }, options, acme).format).toBe('acme-export');
  });
});

describe('exportNative secrets', () => {
  it('blanks credentials and secret-named values but keeps variable references and ordinary values', () => {
    const db = openDatabase(':memory:');
    const { workspaceId } = fixture(db);
    const doc = exportNative(db, workspaceId, { scope: 'workspace' }, noSecrets);
    const text = JSON.stringify(doc);
    for (const secret of ['hunter2', 'Bearer abc', 'qs-secret', 'ws-token', 'ghp_x', 'env-secret'])
      expect(text).not.toContain(secret);

    const request = doc.collections[0].items[0];
    if (request.type !== 'request') throw new Error('expected a request');
    expect(request.config.auth).toEqual({ type: 'basic', basic: { username: 'alice', password: '' } });
    expect(request.config.headers.map((h) => h.value)).toEqual(['', 'keep-me', '{{apiKey}}']);
    expect(request.config.testScript).toBe('jt.test("ok", () => {})');

    const mcp = doc.collections[2].items[0];
    if (mcp.type !== 'mcp') throw new Error('expected an MCP server');
    expect(mcp.env.map((e) => e.value)).toEqual(['', 'debug']);
    expect(doc.environments.find((e) => e.name === 'Staging')?.variables).toEqual({
      baseUrl: 'https://staging',
      apiKey: '',
    });
  });

  it('keeps everything when secrets are included', () => {
    const db = openDatabase(':memory:');
    const { workspaceId } = fixture(db);
    const doc = exportNative(db, workspaceId, { scope: 'workspace' }, { includeSecrets: true, environmentIds: [] });
    expect(doc.secretsStripped).toBe(false);
    const text = JSON.stringify(doc);
    for (const secret of ['hunter2', 'Bearer abc', 'ws-token', 'ghp_x', 'env-secret']) expect(text).toContain(secret);
  });

  it('recognises common secret names', () => {
    for (const n of [
      'Authorization',
      'Cookie',
      'X-Api-Key',
      'api_key',
      'client_secret',
      'PASSWORD',
      'AWS_ACCESS_KEY_ID',
    ]) {
      expect(isSecretName(n)).toBe(true);
    }
    for (const n of ['Content-Type', 'baseUrl', 'Accept', 'userId']) expect(isSecretName(n)).toBe(false);
  });
});
