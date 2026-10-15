import { describe, expect, it } from 'vitest';
import { openDatabase } from './db';
import {
  createCollectionNode,
  createMcpServerConnection,
  createWebSocketConnection,
  getCollectionTree,
  getMcpServerConnection,
  getOrCreateDefaultWorkspace,
  getRequest,
  getWebSocketConnection,
  getMcpTree,
  getWebSocketTree,
  setMcpServerMock,
  setWebSocketMock,
} from './repository';
import { listApiSpecs, saveApiSpec } from './specs';
import { applyWorkspaceFolder, workspaceFolderFiles } from './workspaceFolder';
import { mergeWorkspaceFolders } from './workspaceMerge';
import { exportNative } from '../export/nativeExport';
import { importNative, validateNativeExport } from '../import/nativeImport';
import { importOpenApi } from '../import/openApi';
import type { McpServerMock, WebSocketMock } from '../types';

// What mock servers serve travels with a workspace (docs: mock servers):
// specs, a WebSocket connection's rules, an MCP server's saved results and
// contract, in native exports and in workspace folders.

const wsMock: WebSocketMock = {
  onConnect: [{ message: 'hello', delayMs: 10 }],
  rules: [{ match: 'ping', reply: 'pong', delayMs: 0 }],
};
const mcpMock: McpServerMock = {
  calls: [{ tool: 'forecast', arguments: { city: 'Oslo' }, result: { content: [{ type: 'text', text: 'snow' }] } }],
  contract: { version: 1, kind: 'mcp', tools: [{ name: 'forecast' }] },
};

const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Shop' },
  paths: { '/orders': { get: { responses: { '200': { description: 'ok' } } } } },
});

function setUp() {
  const db = openDatabase(':memory:');
  const { workspace } = getOrCreateDefaultWorkspace(db);
  const imported = importOpenApi(db, workspace.id, SPEC, { location: 'shop.json' });
  saveApiSpec(db, {
    workspaceId: workspace.id,
    kind: 'graphql',
    name: 'Schema',
    location: 'https://g.test/graphql',
    source: '{}',
  });
  const ws = createCollectionNode(db, {
    workspaceId: workspace.id,
    parentFolderId: null,
    name: 'Sockets',
    kind: 'collection',
    category: 'websocket',
  });
  const mcp = createCollectionNode(db, {
    workspaceId: workspace.id,
    parentFolderId: null,
    name: 'Servers',
    kind: 'collection',
    category: 'mcp',
  });
  const socket = createWebSocketConnection(db, { collectionId: ws.id, name: 'Chat', url: 'ws://chat.test/' });
  setWebSocketMock(db, socket.id, wsMock);
  const server = createMcpServerConnection(db, {
    collectionId: mcp.id,
    name: 'Weather',
    transport: 'http',
    command: 'http://w.test/mcp',
  });
  setMcpServerMock(db, server.id, mcpMock);
  return { db, workspaceId: workspace.id, imported, socket, server };
}

describe('connection mocks', () => {
  it('are kept with their connection, and removed with null', () => {
    const { db, socket, server } = setUp();
    expect(getWebSocketConnection(db, socket.id)?.mock).toEqual(wsMock);
    expect(getMcpServerConnection(db, server.id)?.mock).toEqual(mcpMock);
    setWebSocketMock(db, socket.id, null);
    expect(getWebSocketConnection(db, socket.id)).not.toHaveProperty('mock');
  });
});

describe('native exports', () => {
  it('carry specs (their requests linked by key), and connections’ mocks, and import them back', () => {
    const { db, workspaceId } = setUp();
    const doc = exportNative(db, workspaceId, { scope: 'workspace' }, { includeSecrets: false, environmentIds: [] });
    expect(doc.specs?.map((s) => [s.kind, s.name, s.location])).toEqual([
      ['graphql', 'Schema', 'https://g.test/graphql'],
      ['openapi', 'Shop', 'shop.json'],
    ]);
    const target = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(target);
    importNative(target, workspace.id, validateNativeExport(JSON.parse(JSON.stringify(doc))), {
      includeScripts: false,
      includeEnvironments: false,
    });
    const specs = listApiSpecs(target, workspace.id);
    expect(specs.map((s) => s.name).sort()).toEqual(['Schema', 'Shop']);
    const shop = specs.find((s) => s.name === 'Shop')!;
    const collection = getCollectionTree(target, workspace.id).find((c) => c.name === 'Shop')!;
    expect(getRequest(target, collection.requests[0].id)?.config.source).toEqual({
      specId: shop.id,
      operation: 'GET /orders',
    });
    expect(getWebSocketTree(target, workspace.id).find((c) => c.name === 'Sockets')!.connections[0].mock).toEqual(
      wsMock,
    );
    expect(getMcpTree(target, workspace.id).find((c) => c.name === 'Servers')!.connections[0].mock).toEqual(mcpMock);
  });

  it('of a collection carry only the specs its requests name; an unknown spec key is dropped', () => {
    const { db, workspaceId, imported } = setUp();
    const doc = exportNative(
      db,
      workspaceId,
      { scope: 'collection', nodeId: imported.collectionId },
      { includeSecrets: false, environmentIds: [] },
    );
    expect(doc.specs?.map((s) => s.name)).toEqual(['Shop']);
    delete doc.specs;
    const target = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(target);
    const result = importNative(target, workspace.id, validateNativeExport(JSON.parse(JSON.stringify(doc))), {
      includeScripts: false,
      includeEnvironments: false,
    });
    const collection = getCollectionTree(target, workspace.id).find((c) => c.id === result.collections[0].id)!;
    expect(getRequest(target, collection.requests[0].id)?.config).not.toHaveProperty('source');
  });

  it('refuse a malformed mock or spec', () => {
    const { db, workspaceId } = setUp();
    const doc = JSON.parse(
      JSON.stringify(
        exportNative(db, workspaceId, { scope: 'workspace' }, { includeSecrets: false, environmentIds: [] }),
      ),
    );
    doc.specs[0].kind = 'raml';
    expect(() => validateNativeExport(doc)).toThrow(/specs\[0\]\.kind/);
    const again = JSON.parse(
      JSON.stringify(
        exportNative(db, workspaceId, { scope: 'workspace' }, { includeSecrets: false, environmentIds: [] }),
      ),
    );
    const sockets = again.collections.find((c: { name: string }) => c.name === 'Sockets');
    sockets.items[0].mock.rules[0].reply = 7;
    expect(() => validateNativeExport(again)).toThrow(/mock\.rules\[0\]\.reply/);
  });
});

describe('workspace folders', () => {
  it('keep specs as files of their own and connections with their mocks, and apply them back', () => {
    const { db, workspaceId, server } = setUp();
    const files = workspaceFolderFiles(db, workspaceId);
    const specFiles = Object.keys(files).filter((f) => f.startsWith('specs/'));
    expect(specFiles).toHaveLength(2);
    expect(JSON.parse(files[`connections/mcp/${server.id}.json`]).mock).toEqual(mcpMock);

    const copy = openDatabase(':memory:');
    applyWorkspaceFolder(copy, files);
    expect(
      listApiSpecs(copy, workspaceId)
        .map((s) => s.name)
        .sort(),
    ).toEqual(['Schema', 'Shop']);
    expect(getMcpServerConnection(copy, server.id)?.mock).toEqual(mcpMock);
    expect(workspaceFolderFiles(copy, workspaceId)).toEqual(files);

    // A spec the folder drops is removed.
    const fewer = { ...files };
    delete fewer[specFiles[0]];
    expect(applyWorkspaceFolder(copy, fewer).removed).toEqual([specFiles[0]]);
  });

  it('merge specs as items: both sides changing one is a conflict', () => {
    const { db, workspaceId } = setUp();
    const base = workspaceFolderFiles(db, workspaceId);
    const file = Object.keys(base).find((f) => f.startsWith('specs/'))!;
    const edit = (source: string) => ({ ...base, [file]: JSON.stringify({ ...JSON.parse(base[file]), source }) });
    const result = mergeWorkspaceFolders(base, edit('{"ours":1}'), edit('{"theirs":1}'));
    expect(result.conflicts.map((c) => [c.file, c.kind])).toEqual([[file, 'spec']]);
    const one = mergeWorkspaceFolders(base, edit('{"ours":1}'), base);
    expect(JSON.parse(one.files[file]).source).toBe('{"ours":1}');
  });
});
