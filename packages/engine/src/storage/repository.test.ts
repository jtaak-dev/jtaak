import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import {
  createCollectionNode,
  createEnvironment,
  createMcpServerConnection,
  createRequest,
  createWebSocketConnection,
  createWorkspace,
  deleteCollectionNode,
  deleteEnvironment,
  deleteMcpServerConnection,
  deleteRequest,
  deleteWebSocketConnection,
  getCollectionTree,
  getEnvironment,
  getMcpServerConnection,
  getMcpTree,
  getOrCreateDefaultWorkspace,
  getRequest,
  getWebSocketConnection,
  getWebSocketTree,
  listEnvironments,
  listMcpServerConnections,
  listRequestsForNode,
  listWebSocketConnections,
  listWorkspaces,
  moveCollectionNode,
  moveMcpServerConnection,
  moveRequest,
  moveWebSocketConnection,
  renameEnvironment,
  renameMcpServerConnection,
  renameWebSocketConnection,
  reorderCollectionNodes,
  reorderRequests,
  reorderWebSocketConnections,
  updateEnvironmentVariables,
  updateMcpServerConnection,
  updateRequest,
  updateWebSocketConnection,
} from './repository';
import type { CollectionCategory, RequestConfig } from '../types';

function freshDb(): Database.Database {
  return openDatabase(':memory:');
}

/** The default workspace plus the id of each category's seeded default collection. */
function seededWorkspace(db: Database.Database) {
  const { workspace } = getOrCreateDefaultWorkspace(db);
  return {
    workspace,
    apiCollectionId: getCollectionTree(db, workspace.id)[0].id,
    wsCollectionId: getWebSocketTree(db, workspace.id)[0].id,
    mcpCollectionId: getMcpTree(db, workspace.id)[0].id,
  };
}

function rootCollection(db: Database.Database, workspaceId: string, category: CollectionCategory, name = 'Collection') {
  return createCollectionNode(db, { workspaceId, parentFolderId: null, name, kind: 'collection', category });
}

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

describe('workspaces', () => {
  it('creates one on first access and reuses it after', () => {
    const db = freshDb();
    const first = getOrCreateDefaultWorkspace(db);
    const second = getOrCreateDefaultWorkspace(db);
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(listWorkspaces(db)).toHaveLength(1);
  });

  it('seeds one default collection per category, exactly once', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    getOrCreateDefaultWorkspace(db);

    expect(getCollectionTree(db, workspace.id).map((n) => n.name)).toEqual(['My Collection']);
    expect(getWebSocketTree(db, workspace.id).map((n) => n.name)).toEqual(['My Connections']);
    expect(getMcpTree(db, workspace.id).map((n) => n.name)).toEqual(['My MCPs']);
  });

  it('does not re-create a default collection the user deleted', () => {
    const db = freshDb();
    const { workspace, apiCollectionId, wsCollectionId, mcpCollectionId } = seededWorkspace(db);
    deleteCollectionNode(db, apiCollectionId);
    deleteCollectionNode(db, wsCollectionId);
    deleteCollectionNode(db, mcpCollectionId);

    getOrCreateDefaultWorkspace(db);

    expect(getCollectionTree(db, workspace.id)).toEqual([]);
    expect(getWebSocketTree(db, workspace.id)).toEqual([]);
    expect(getMcpTree(db, workspace.id)).toEqual([]);
  });

  it('lets callers create additional workspaces', () => {
    const db = freshDb();
    createWorkspace(db, 'Team A');
    createWorkspace(db, 'Team B');
    expect(listWorkspaces(db).map((w) => w.name)).toEqual(['Team A', 'Team B']);
  });
});

describe('collection tree CRUD', () => {
  it('nests folders and requests correctly and sorts by sort_order', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const collection = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: 'Users API',
      kind: 'collection',
    });
    const folder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: collection.id,
      name: 'Admin',
      kind: 'folder',
    });
    createRequest(db, {
      collectionId: collection.id,
      name: 'List users',
      config: baseConfig({ url: 'https://api/users' }),
    });
    createRequest(db, { collectionId: folder.id, name: 'Ban user', config: baseConfig({ method: 'POST' }) });

    const tree = getCollectionTree(db, workspace.id);
    const usersApi = tree.find((n) => n.id === collection.id)!;
    expect(usersApi.requests.map((r) => r.name)).toEqual(['List users']);
    expect(usersApi.children).toHaveLength(1);
    expect(usersApi.children[0].requests.map((r) => r.name)).toEqual(['Ban user']);
  });

  it('renames, moves, and deletes nodes', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const folderA = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: 'A',
      kind: 'folder',
    });
    const folderB = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: null,
      name: 'B',
      kind: 'folder',
    });
    const request = createRequest(db, { collectionId: folderA.id, name: 'Ping', config: baseConfig() });

    moveRequest(db, request.id, folderB.id);
    expect(getRequest(db, request.id)!.collectionId).toBe(folderB.id);

    moveCollectionNode(db, folderA.id, folderB.id);
    const tree = getCollectionTree(db, workspace.id);
    expect(tree.map((n) => n.id)).not.toContain(folderA.id);
    expect(tree.find((n) => n.id === folderB.id)!.children.map((n) => n.id)).toContain(folderA.id);

    deleteCollectionNode(db, folderB.id);
    const remainingIds = getCollectionTree(db, workspace.id).map((n) => n.id);
    expect(remainingIds).not.toContain(folderB.id);
    expect(remainingIds).not.toContain(folderA.id);
  });

  it('reorders siblings', () => {
    const db = freshDb();
    const { apiCollectionId: defaultCollectionId } = seededWorkspace(db);
    const r1 = createRequest(db, { collectionId: defaultCollectionId, name: 'One', config: baseConfig() });
    const r2 = createRequest(db, { collectionId: defaultCollectionId, name: 'Two', config: baseConfig() });
    const r3 = createRequest(db, { collectionId: defaultCollectionId, name: 'Three', config: baseConfig() });

    reorderRequests(db, [r3.id, r1.id, r2.id]);

    const { workspace } = getOrCreateDefaultWorkspace(db);
    const tree = getCollectionTree(db, workspace.id);
    const names = tree.find((n) => n.id === defaultCollectionId)!.requests.map((r) => r.name);
    expect(names).toEqual(['Three', 'One', 'Two']);
  });

  it('updates and deletes a saved request', () => {
    const db = freshDb();
    const { apiCollectionId: defaultCollectionId } = seededWorkspace(db);
    const saved = createRequest(db, { collectionId: defaultCollectionId, name: 'Ping', config: baseConfig() });

    updateRequest(db, saved.id, { ...saved.config, name: 'Ping v2', url: 'https://api/ping' });
    expect(getRequest(db, saved.id)!.name).toBe('Ping v2');
    expect(getRequest(db, saved.id)!.url).toBe('https://api/ping');

    deleteRequest(db, saved.id);
    expect(getRequest(db, saved.id)).toBeUndefined();
  });

  it('reorderCollectionNodes rewrites sibling order', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const a = createCollectionNode(db, { workspaceId: workspace.id, parentFolderId: null, name: 'A', kind: 'folder' });
    const b = createCollectionNode(db, { workspaceId: workspace.id, parentFolderId: null, name: 'B', kind: 'folder' });

    reorderCollectionNodes(db, [b.id, a.id]);
    const tree = getCollectionTree(db, workspace.id);
    // default collection created by getOrCreateDefaultWorkspace comes first (sort_order 0);
    // check relative order of a/b instead of absolute index.
    const order = tree.map((n) => n.id);
    expect(order.indexOf(b.id)).toBeLessThan(order.indexOf(a.id));
  });

  it("keeps each category in its own tree, and folders inherit their parent collection's category", () => {
    const db = freshDb();
    const { workspace, wsCollectionId } = seededWorkspace(db);
    const folder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: wsCollectionId,
      name: 'Chat',
      kind: 'folder',
    });

    expect(folder.category).toBe('websocket');
    expect(getCollectionTree(db, workspace.id).map((n) => n.name)).toEqual(['My Collection']);
    expect(getWebSocketTree(db, workspace.id)[0].children.map((n) => n.id)).toEqual([folder.id]);
  });

  it('refuses to move a folder into a different category', () => {
    const db = freshDb();
    const { workspace, apiCollectionId, wsCollectionId } = seededWorkspace(db);
    const folder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: apiCollectionId,
      name: 'F',
      kind: 'folder',
    });

    expect(() => moveCollectionNode(db, folder.id, wsCollectionId)).toThrow();
  });
});

describe('environments', () => {
  it('creates, lists, and reads back an environment with empty variables', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const env = createEnvironment(db, workspace.id, 'Staging');

    expect(env.variables).toEqual({});
    expect(listEnvironments(db, workspace.id).map((e) => e.name)).toEqual(['Staging']);
    expect(getEnvironment(db, env.id)).toEqual(env);
  });

  it('updates variables and renames', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const env = createEnvironment(db, workspace.id, 'Staging');

    updateEnvironmentVariables(db, env.id, { baseUrl: 'https://staging.example.com', token: 'abc' });
    renameEnvironment(db, env.id, 'Staging v2');

    const updated = getEnvironment(db, env.id)!;
    expect(updated.name).toBe('Staging v2');
    expect(updated.variables).toEqual({ baseUrl: 'https://staging.example.com', token: 'abc' });
  });

  it('deletes an environment', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const env = createEnvironment(db, workspace.id, 'Staging');

    deleteEnvironment(db, env.id);

    expect(getEnvironment(db, env.id)).toBeUndefined();
    expect(listEnvironments(db, workspace.id)).toHaveLength(0);
  });

  it('scopes environments to their workspace', () => {
    const db = freshDb();
    const { workspace: wsA } = getOrCreateDefaultWorkspace(db);
    const wsB = createWorkspace(db, 'Other workspace');
    createEnvironment(db, wsA.id, 'A env');
    createEnvironment(db, wsB.id, 'B env');

    expect(listEnvironments(db, wsA.id).map((e) => e.name)).toEqual(['A env']);
    expect(listEnvironments(db, wsB.id).map((e) => e.name)).toEqual(['B env']);
  });
});

describe('WebSocket connections', () => {
  it('creates one with empty headers/subprotocols/auth and reads it back', () => {
    const db = freshDb();
    const { workspace, wsCollectionId } = seededWorkspace(db);
    const connection = createWebSocketConnection(db, {
      collectionId: wsCollectionId,
      name: 'Chat',
      url: 'wss://example.com/chat',
    });

    expect(connection.workspaceId).toBe(workspace.id);
    expect(connection.collectionId).toBe(wsCollectionId);
    expect(connection.headers).toEqual([]);
    expect(connection.subprotocols).toEqual([]);
    expect(connection.auth).toEqual({ type: 'none' });
    expect(getWebSocketConnection(db, connection.id)).toEqual(connection);
  });

  it('lists connections scoped to their workspace, in sort order', () => {
    const db = freshDb();
    const { workspace: wsA, wsCollectionId } = seededWorkspace(db);
    const wsB = createWorkspace(db, 'Other workspace');
    const otherCollection = rootCollection(db, wsB.id, 'websocket');
    createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'B conn', url: 'wss://a.example.com' });
    createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'A conn', url: 'wss://a.example.com' });
    createWebSocketConnection(db, { collectionId: otherCollection.id, name: 'Other conn', url: 'wss://b.example.com' });

    expect(listWebSocketConnections(db, wsA.id).map((c) => c.name)).toEqual(['B conn', 'A conn']);
    expect(listWebSocketConnections(db, wsB.id).map((c) => c.name)).toEqual(['Other conn']);
  });

  it('only creates/moves connections into websocket collections', () => {
    const db = freshDb();
    const { apiCollectionId, wsCollectionId } = seededWorkspace(db);
    expect(() => createWebSocketConnection(db, { collectionId: apiCollectionId, name: 'X', url: 'wss://x' })).toThrow();

    const connection = createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'X', url: 'wss://x' });
    expect(() => moveWebSocketConnection(db, connection.id, apiCollectionId)).toThrow();
  });

  it('nests connections in folders, moves and reorders them', () => {
    const db = freshDb();
    const { workspace, wsCollectionId } = seededWorkspace(db);
    const folder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: wsCollectionId,
      name: 'Chat',
      kind: 'folder',
    });
    const a = createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'A', url: 'wss://a' });
    const b = createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'B', url: 'wss://b' });
    const c = createWebSocketConnection(db, { collectionId: wsCollectionId, name: 'C', url: 'wss://c' });

    moveWebSocketConnection(db, a.id, folder.id);
    reorderWebSocketConnections(db, [c.id, b.id]);

    const [root] = getWebSocketTree(db, workspace.id);
    expect(root.connections.map((x) => x.name)).toEqual(['C', 'B']);
    expect(root.children[0].connections.map((x) => x.name)).toEqual(['A']);
  });

  it('deletes connections along with their collection', () => {
    const db = freshDb();
    const { wsCollectionId } = seededWorkspace(db);
    const connection = createWebSocketConnection(db, {
      collectionId: wsCollectionId,
      name: 'Chat',
      url: 'wss://example.com',
    });

    deleteCollectionNode(db, wsCollectionId);

    expect(getWebSocketConnection(db, connection.id)).toBeUndefined();
  });

  it('updates endpoint/headers/subprotocols/auth without touching the name, and renames independently', () => {
    const db = freshDb();
    const { wsCollectionId } = seededWorkspace(db);
    const connection = createWebSocketConnection(db, {
      collectionId: wsCollectionId,
      name: 'Chat',
      url: 'wss://old.example.com',
    });

    updateWebSocketConnection(db, connection.id, {
      url: 'wss://new.example.com',
      headers: [{ key: 'X-Test', value: '1', enabled: true }],
      subprotocols: ['chat.v1'],
      auth: { type: 'bearer', bearer: { token: 'abc' } },
    });
    renameWebSocketConnection(db, connection.id, 'Chat v2');

    const updated = getWebSocketConnection(db, connection.id)!;
    expect(updated.name).toBe('Chat v2');
    expect(updated.url).toBe('wss://new.example.com');
    expect(updated.headers).toEqual([{ key: 'X-Test', value: '1', enabled: true }]);
    expect(updated.subprotocols).toEqual(['chat.v1']);
    expect(updated.auth).toEqual({ type: 'bearer', bearer: { token: 'abc' } });
  });

  it('deletes a connection', () => {
    const db = freshDb();
    const { workspace, wsCollectionId } = seededWorkspace(db);
    const connection = createWebSocketConnection(db, {
      collectionId: wsCollectionId,
      name: 'Chat',
      url: 'wss://example.com',
    });

    deleteWebSocketConnection(db, connection.id);

    expect(getWebSocketConnection(db, connection.id)).toBeUndefined();
    expect(listWebSocketConnections(db, workspace.id)).toHaveLength(0);
  });
});

describe('MCP server connections', () => {
  it('creates one with empty args/env/headers and reads it back', () => {
    const db = freshDb();
    const { mcpCollectionId } = seededWorkspace(db);
    const connection = createMcpServerConnection(db, {
      collectionId: mcpCollectionId,
      name: 'Local tools',
      transport: 'stdio',
      command: 'npx',
    });

    expect(connection.collectionId).toBe(mcpCollectionId);
    expect(connection.args).toEqual([]);
    expect(connection.env).toEqual([]);
    expect(connection.headers).toEqual([]);
    expect(getMcpServerConnection(db, connection.id)).toEqual(connection);
  });

  it('lists connections scoped to their workspace, in sort order', () => {
    const db = freshDb();
    const { workspace: wsA, mcpCollectionId } = seededWorkspace(db);
    const wsB = createWorkspace(db, 'Other workspace');
    const otherCollection = rootCollection(db, wsB.id, 'mcp');
    createMcpServerConnection(db, {
      collectionId: mcpCollectionId,
      name: 'B server',
      transport: 'stdio',
      command: 'npx',
    });
    createMcpServerConnection(db, {
      collectionId: mcpCollectionId,
      name: 'A server',
      transport: 'stdio',
      command: 'npx',
    });
    createMcpServerConnection(db, {
      collectionId: otherCollection.id,
      name: 'Other server',
      transport: 'http',
      command: 'https://example.com/mcp',
    });

    expect(listMcpServerConnections(db, wsA.id).map((c) => c.name)).toEqual(['B server', 'A server']);
    expect(listMcpServerConnections(db, wsB.id).map((c) => c.name)).toEqual(['Other server']);
  });

  it('only creates/moves servers into mcp collections, and nests them in folders', () => {
    const db = freshDb();
    const { workspace, wsCollectionId, mcpCollectionId } = seededWorkspace(db);
    expect(() =>
      createMcpServerConnection(db, { collectionId: wsCollectionId, name: 'X', transport: 'stdio', command: 'npx' }),
    ).toThrow();

    const folder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: mcpCollectionId,
      name: 'Local',
      kind: 'folder',
    });
    const server = createMcpServerConnection(db, {
      collectionId: mcpCollectionId,
      name: 'X',
      transport: 'stdio',
      command: 'npx',
    });
    expect(() => moveMcpServerConnection(db, server.id, wsCollectionId)).toThrow();
    moveMcpServerConnection(db, server.id, folder.id);

    expect(getMcpTree(db, workspace.id)[0].children[0].connections.map((c) => c.name)).toEqual(['X']);
  });

  it('updates transport/command/args/env/headers without touching the name, and renames independently', () => {
    const db = freshDb();
    const { mcpCollectionId } = seededWorkspace(db);
    const connection = createMcpServerConnection(db, {
      collectionId: mcpCollectionId,
      name: 'Local tools',
      transport: 'stdio',
      command: 'npx',
    });

    updateMcpServerConnection(db, connection.id, {
      transport: 'http',
      command: 'https://example.com/mcp',
      args: [],
      env: [],
      headers: [{ key: 'Authorization', value: 'Bearer abc', enabled: true }],
    });
    renameMcpServerConnection(db, connection.id, 'Local tools v2');

    const updated = getMcpServerConnection(db, connection.id)!;
    expect(updated.name).toBe('Local tools v2');
    expect(updated.transport).toBe('http');
    expect(updated.command).toBe('https://example.com/mcp');
    expect(updated.headers).toEqual([{ key: 'Authorization', value: 'Bearer abc', enabled: true }]);
  });

  it('deletes a connection', () => {
    const db = freshDb();
    const { workspace, mcpCollectionId } = seededWorkspace(db);
    const connection = createMcpServerConnection(db, {
      collectionId: mcpCollectionId,
      name: 'Local tools',
      transport: 'stdio',
      command: 'npx',
    });

    deleteMcpServerConnection(db, connection.id);

    expect(getMcpServerConnection(db, connection.id)).toBeUndefined();
    expect(listMcpServerConnections(db, workspace.id)).toHaveLength(0);
  });
});

describe('listRequestsForNode', () => {
  it('collects requests from nested subfolders, not just the node itself', () => {
    const db = freshDb();
    const { workspace, apiCollectionId: defaultCollectionId } = seededWorkspace(db);
    const subfolder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: defaultCollectionId,
      name: 'Sub',
      kind: 'folder',
    });
    const deeperFolder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: subfolder.id,
      name: 'Deeper',
      kind: 'folder',
    });

    createRequest(db, { collectionId: defaultCollectionId, name: 'Top', config: baseConfig() });
    createRequest(db, { collectionId: subfolder.id, name: 'Nested', config: baseConfig() });
    createRequest(db, { collectionId: deeperFolder.id, name: 'Deepest', config: baseConfig() });

    const names = listRequestsForNode(db, defaultCollectionId).map((r) => r.name);
    expect(names.sort()).toEqual(['Deepest', 'Nested', 'Top']);
  });

  it('scopes to only the given node when it is a subfolder', () => {
    const db = freshDb();
    const { workspace, apiCollectionId: defaultCollectionId } = seededWorkspace(db);
    const subfolder = createCollectionNode(db, {
      workspaceId: workspace.id,
      parentFolderId: defaultCollectionId,
      name: 'Sub',
      kind: 'folder',
    });

    createRequest(db, { collectionId: defaultCollectionId, name: 'Top', config: baseConfig() });
    createRequest(db, { collectionId: subfolder.id, name: 'Nested', config: baseConfig() });

    expect(listRequestsForNode(db, subfolder.id).map((r) => r.name)).toEqual(['Nested']);
  });

  it('returns full RequestConfig, not just a summary', () => {
    const db = freshDb();
    const { apiCollectionId: defaultCollectionId } = seededWorkspace(db);
    createRequest(db, {
      collectionId: defaultCollectionId,
      name: 'Ping',
      config: baseConfig({ testScript: 'jt.test("x", () => {});' }),
    });

    const [request] = listRequestsForNode(db, defaultCollectionId);
    expect(request.config.testScript).toBe('jt.test("x", () => {});');
  });
});

describe('performance budget: 10,000-request collection tree', () => {
  it('loads a 10,000-request tree across 100 folders in under 1 second', () => {
    const db = freshDb();
    const { workspace, apiCollectionId: defaultCollectionId } = seededWorkspace(db);

    const insertFolder = db.prepare(
      'INSERT INTO collections (id, workspace_id, parent_folder_id, name, kind, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const insertRequest = db.prepare(
      'INSERT INTO requests (id, collection_id, name, method, url, config_json, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );

    const seed = db.transaction(() => {
      const folderIds: string[] = [];
      for (let f = 0; f < 100; f++) {
        const id = `folder-${f}`;
        insertFolder.run(id, workspace.id, defaultCollectionId, `Folder ${f}`, 'folder', f, Date.now());
        folderIds.push(id);
      }
      for (let i = 0; i < 10_000; i++) {
        const collectionId = folderIds[i % folderIds.length];
        insertRequest.run(
          `req-${i}`,
          collectionId,
          `Request ${i}`,
          'GET',
          `https://api.example.com/resource/${i}`,
          JSON.stringify(baseConfig({ id: `req-${i}` })),
          i,
          Date.now(),
        );
      }
    });
    seed();

    const start = performance.now();
    const tree = getCollectionTree(db, workspace.id);
    const durationMs = performance.now() - start;

    const totalRequests = tree.reduce(
      (sum, node) => sum + node.requests.length + node.children.reduce((s, c) => s + c.requests.length, 0),
      0,
    );
    expect(totalRequests).toBe(10_000);
    expect(durationMs).toBeLessThan(1000);
  });
});
