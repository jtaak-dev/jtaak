import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import {
  createCollectionNode,
  createMessagingConnection,
  createRequest,
  createWorkspace,
  getCollectionTree,
  getMcpTree,
  getMessagingTree,
  getOrCreateDefaultWorkspace,
  getRequest,
  getWebSocketTree,
  listEnvironments,
  updateMessagingConnection,
} from '../storage/repository';
import { exportNative } from '../export/nativeExport';
import { DEFAULT_ENGINE_PROFILE, type NativeExportDocument, type RequestConfig } from '../types';
import { importNative, isNativeExport, previewNativeImport, validateNativeExport } from './nativeImport';

function doc(overrides: Partial<NativeExportDocument> = {}): NativeExportDocument {
  return {
    format: 'jtaak-export',
    version: 1,
    scope: 'workspace',
    exportedAt: '2026-09-24T00:00:00.000Z',
    secretsStripped: true,
    collections: [
      {
        category: 'api',
        name: 'Users API',
        folders: [
          {
            name: 'Admin',
            folders: [],
            items: [
              {
                type: 'request',
                name: 'Upload',
                config: {
                  method: 'POST',
                  url: '/upload',
                  params: [],
                  headers: [],
                  body: { mode: 'binary', binaryPath: 'C:/tmp/a.bin' },
                  auth: { type: 'none' },
                },
              },
            ],
          },
        ],
        items: [
          {
            type: 'request',
            name: 'List users',
            config: {
              method: 'GET',
              url: '{{baseUrl}}/users',
              params: [],
              headers: [],
              body: { mode: 'none' },
              auth: { type: 'none' },
              preRequestScript: 'jt.variables.set("a", "b")',
            },
          },
        ],
      },
      {
        category: 'websocket',
        name: 'Sockets',
        folders: [],
        items: [
          {
            type: 'websocket',
            name: 'Echo',
            url: 'wss://echo',
            headers: [],
            subprotocols: ['json'],
            auth: { type: 'none' },
          },
        ],
      },
      {
        category: 'mcp',
        name: 'Servers',
        folders: [],
        items: [
          { type: 'mcp', name: 'FS', transport: 'stdio', command: 'npx', args: ['-y', 'fs'], env: [], headers: [] },
        ],
      },
    ],
    environments: [{ name: 'Staging', variables: { baseUrl: 'https://staging' } }],
    ...overrides,
  };
}

function workspace(db: Database.Database) {
  return getOrCreateDefaultWorkspace(db).workspace.id;
}

describe('validateNativeExport', () => {
  it('accepts a well-formed document and fills in optional fields', () => {
    const minimal = {
      format: 'jtaak-export',
      version: 1,
      scope: 'collection',
      collections: [{ category: 'api', name: 'C', items: [{ type: 'request', name: 'R', config: { url: '/x' } }] }],
    };
    const valid = validateNativeExport(minimal);
    expect(valid.environments).toEqual([]);
    expect(valid.collections[0].folders).toEqual([]);
    expect(valid.collections[0].items[0]).toEqual({
      type: 'request',
      name: 'R',
      config: { method: 'GET', url: '/x', params: [], headers: [], body: { mode: 'none' }, auth: { type: 'none' } },
    });
  });

  it('rejects files that are not jtaak exports', () => {
    expect(isNativeExport({ info: {}, item: [] })).toBe(false);
    expect(() => validateNativeExport({ info: {} })).toThrow(/format: this is not a jtaak export file/);
    expect(() => validateNativeExport([])).toThrow(/file: expected an object/);
  });

  it("uses the profile's format id and product name", () => {
    const acme = { ...DEFAULT_ENGINE_PROFILE, productName: 'Acme', exportFormat: 'acme-export' };
    const acmeDoc = { ...doc(), format: 'acme-export' };
    expect(isNativeExport(acmeDoc, acme)).toBe(true);
    expect(isNativeExport(acmeDoc)).toBe(false);
    expect(validateNativeExport(acmeDoc, acme).format).toBe('acme-export');
    expect(() => validateNativeExport(doc(), acme)).toThrow(
      /Invalid Acme export — format: this is not a Acme export file/,
    );
    expect(() => validateNativeExport({ ...acmeDoc, version: 2 }, acme)).toThrow(/newer version of Acme/);
  });

  it('asks for an update when the file is from a newer format version', () => {
    expect(() => validateNativeExport({ ...doc(), version: 2 })).toThrow(/newer version of jtaak/);
  });

  it('names the exact field that is wrong', () => {
    const bad = doc();
    (bad.collections[0].items[0] as { config: { method: string } }).config.method = 'FETCH';
    expect(() => validateNativeExport(bad)).toThrow(/collections\[0\]\.items\[0\]\.config\.method: expected one of/);
  });

  it('rejects an item in a collection of the wrong category', () => {
    const bad = doc();
    bad.collections[1].items.push(bad.collections[0].items[0]);
    expect(() => validateNativeExport(bad)).toThrow(
      /collections\[1\]\.items\[1\]\.type: a websocket collection can only hold "websocket"/,
    );
  });

  it('drops unknown fields instead of carrying them into storage', () => {
    const withExtra = doc();
    (withExtra.collections[0].items[0] as unknown as Record<string, unknown>).evil = 'x';
    expect(JSON.stringify(validateNativeExport(withExtra))).not.toContain('evil');
  });
});

describe('previewNativeImport', () => {
  it('counts what will be created and flags scripts, local files and stdio commands', () => {
    expect(previewNativeImport(validateNativeExport(doc()))).toEqual({
      scope: 'workspace',
      exportedAt: '2026-09-24T00:00:00.000Z',
      secretsStripped: true,
      collections: [
        { name: 'Users API', category: 'api', folderCount: 1, itemCount: 2 },
        { name: 'Sockets', category: 'websocket', folderCount: 0, itemCount: 1 },
        { name: 'Servers', category: 'mcp', folderCount: 0, itemCount: 1 },
      ],
      environments: ['Staging'],
      scriptRequestCount: 1,
      mcpStdioCommands: ['npx -y fs'],
      localFileRequestCount: 1,
    });
  });
});

describe('importNative', () => {
  it('creates new collections in each category, plus environments', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    const result = importNative(db, workspaceId, validateNativeExport(doc()), {
      includeScripts: true,
      includeEnvironments: true,
    });

    expect(result).toMatchObject({ folderCount: 1, itemCount: 4, environmentCount: 1 });
    expect(result.collections.map((c) => [c.name, c.category])).toEqual([
      ['Users API', 'api'],
      ['Sockets', 'websocket'],
      ['Servers', 'mcp'],
    ]);

    const api = getCollectionTree(db, workspaceId).find((c) => c.name === 'Users API')!;
    expect(api.requests.map((r) => r.name)).toEqual(['List users']);
    expect(api.children[0].requests.map((r) => r.name)).toEqual(['Upload']);
    expect(getRequest(db, api.requests[0].id)?.config.preRequestScript).toBe('jt.variables.set("a", "b")');

    expect(getWebSocketTree(db, workspaceId).find((c) => c.name === 'Sockets')?.connections[0]).toMatchObject({
      subprotocols: ['json'],
    });
    expect(getMcpTree(db, workspaceId).find((c) => c.name === 'Servers')?.connections[0]).toMatchObject({
      args: ['-y', 'fs'],
    });
    expect(listEnvironments(db, workspaceId).map((e) => e.variables)).toEqual([{ baseUrl: 'https://staging' }]);
  });

  it('drops scripts and environments when the user opts out', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    const result = importNative(db, workspaceId, validateNativeExport(doc()), {
      includeScripts: false,
      includeEnvironments: false,
    });
    const api = getCollectionTree(db, workspaceId).find((c) => c.id === result.collections[0].id)!;
    expect(getRequest(db, api.requests[0].id)?.config.preRequestScript).toBeUndefined();
    expect(listEnvironments(db, workspaceId)).toEqual([]);
  });

  it('always adds a copy, suffixing names that are taken', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    const file = validateNativeExport(doc());
    const opts = { includeScripts: false, includeEnvironments: true };
    importNative(db, workspaceId, file, opts);
    importNative(db, workspaceId, file, opts);
    importNative(db, workspaceId, file, opts);
    expect(getCollectionTree(db, workspaceId).map((c) => c.name)).toEqual([
      'My Collection',
      'Users API',
      'Users API (imported)',
      'Users API (imported 2)',
    ]);
    expect(
      listEnvironments(db, workspaceId)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['Staging', 'Staging (imported)', 'Staging (imported 2)'].sort());
  });

  it('rolls back everything if any write fails part-way', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    const before = getCollectionTree(db, workspaceId).length;
    // A document that skipped validation: the second collection's item is
    // missing required fields, so the insert throws after the first
    // collection has already been written inside the transaction.
    const broken = doc();
    (broken.collections[1].items[0] as unknown as Record<string, unknown>).url = null;
    expect(() => importNative(db, workspaceId, broken, { includeScripts: false, includeEnvironments: true })).toThrow();
    expect(getCollectionTree(db, workspaceId)).toHaveLength(before);
    expect(listEnvironments(db, workspaceId)).toEqual([]);
  });

  it('round-trips: export → import into a fresh workspace → export gives the same file', () => {
    const source = openDatabase(':memory:');
    const sourceWs = workspace(source);
    importNative(source, sourceWs, validateNativeExport(doc()), { includeScripts: true, includeEnvironments: true });
    const first = exportNative(source, sourceWs, { scope: 'workspace' }, { includeSecrets: true, environmentIds: [] });

    const target = openDatabase(':memory:');
    // A bare workspace (no seeded default collections), so the only
    // collections in it are the imported ones.
    const targetWs = createWorkspace(target, 'Target').id;
    importNative(target, targetWs, validateNativeExport(JSON.parse(JSON.stringify(first))), {
      includeScripts: true,
      includeEnvironments: true,
    });
    const second = exportNative(target, targetWs, { scope: 'workspace' }, { includeSecrets: true, environmentIds: [] });

    expect({ ...second, exportedAt: '' }).toEqual({ ...first, exportedAt: '' });
  });

  it('imports 5,000 requests well within the import budget', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    const root = createCollectionNode(db, {
      workspaceId,
      parentFolderId: null,
      name: 'Big',
      kind: 'collection',
      category: 'api',
    });
    const config: RequestConfig = {
      id: '',
      name: 'r',
      method: 'GET',
      url: 'https://example.com',
      params: [],
      headers: [],
      body: { mode: 'none' },
      auth: { type: 'none' },
    };
    for (let f = 0; f < 50; f++) {
      const folder = createCollectionNode(db, { workspaceId, parentFolderId: root.id, name: `F${f}`, kind: 'folder' });
      for (let r = 0; r < 100; r++) createRequest(db, { collectionId: folder.id, name: `R${r}`, config });
    }
    const file = JSON.parse(
      JSON.stringify(
        exportNative(
          db,
          workspaceId,
          { scope: 'collection', nodeId: root.id },
          { includeSecrets: true, environmentIds: [] },
        ),
      ),
    );

    const target = openDatabase(':memory:');
    const start = performance.now();
    const result = importNative(target, workspace(target), validateNativeExport(file), {
      includeScripts: true,
      includeEnvironments: false,
    });
    const elapsed = performance.now() - start;

    expect(result.itemCount).toBe(5000);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('request auth and settings', () => {
  it('keeps Digest and OAuth 2.0 auth and the cookie jar setting, but no OAuth token', () => {
    const d = doc();
    const request = d.collections.flatMap((c) => c.items).find((i) => i.type === 'request')!;
    if (request.type !== 'request') throw new Error('expected a request');
    request.config.useCookies = false;
    request.config.auth = {
      type: 'oauth2',
      oauth2: {
        grantType: 'authorization_code',
        authUrl: 'https://id/auth',
        tokenUrl: 'https://id/token',
        clientId: 'app',
        usePkce: false,
        addTo: 'query',
        token: { accessToken: 'stale', obtainedAt: 1 },
      },
    };
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    importNative(db, workspaceId, validateNativeExport(d), { includeScripts: true, includeEnvironments: false });
    const api = getCollectionTree(db, workspaceId).find((c) => c.name === 'Users API')!;
    const config = getRequest(db, api.requests[0].id)!.config;
    expect(config.useCookies).toBe(false);
    expect(config.auth).toEqual({
      type: 'oauth2',
      oauth2: {
        grantType: 'authorization_code',
        tokenUrl: 'https://id/token',
        clientId: 'app',
        authUrl: 'https://id/auth',
        usePkce: false,
        addTo: 'query',
      },
    });

    request.config.auth = { type: 'digest', digest: { username: 'u', password: 'p' } };
    expect(validateNativeExport(d).collections[0].items[0]).toMatchObject({
      config: { auth: { type: 'digest', digest: { username: 'u', password: 'p' } } },
    });
    request.config.auth = { type: 'oauth2', oauth2: { grantType: 'implicit' } } as never;
    expect(() => validateNativeExport(d)).toThrow('grantType: expected one of');
  });
});

describe('form-data file rows', () => {
  function withFileRow(): NativeExportDocument {
    const d = doc();
    const upload = d.collections[0].folders[0].items[0];
    if (upload.type === 'request') {
      upload.config.body = {
        mode: 'form-data',
        formData: [
          { key: 'note', value: 'hi', enabled: true },
          { key: 'photo', value: '', enabled: true, type: 'file', src: 'C:/tmp/photo.png' },
        ],
      };
    }
    return d;
  }

  it('keeps their type and path through an import and a re-export', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    importNative(db, workspaceId, validateNativeExport(withFileRow()), {
      includeScripts: false,
      includeEnvironments: false,
    });
    const api = getCollectionTree(db, workspaceId).find((c) => c.name === 'Users API')!;
    expect(getRequest(db, api.children[0].requests[0].id)?.config.body.formData).toEqual([
      { key: 'note', value: 'hi', enabled: true },
      { key: 'photo', value: '', enabled: true, type: 'file', src: 'C:/tmp/photo.png' },
    ]);
    const exported = exportNative(
      db,
      workspaceId,
      { scope: 'workspace' },
      { includeSecrets: false, environmentIds: [] },
    );
    const nested = exported.collections.find((c) => c.name === 'Users API')!.folders[0].items[0];
    expect(nested.type === 'request' && nested.config.body.formData?.[1]).toEqual({
      key: 'photo',
      value: '',
      enabled: true,
      type: 'file',
      src: 'C:/tmp/photo.png',
    });
  });

  it('count as sending a local file, and reject an unknown row type', () => {
    expect(previewNativeImport(validateNativeExport(withFileRow())).localFileRequestCount).toBe(1);
    const bad = withFileRow();
    const upload = bad.collections[0].folders[0].items[0];
    if (upload.type === 'request') (upload.config.body.formData![1] as { type: string }).type = 'blob';
    expect(() => validateNativeExport(bad)).toThrow(/formData\[1\]\.type: expected one of/);
  });
});

describe('the TLS certificate check setting', () => {
  // The fixture's request, WebSocket and MCP items with the check turned off.
  function insecureDoc(): NativeExportDocument {
    const d = doc();
    for (const collection of d.collections) {
      for (const i of collection.items) {
        if (i.type === 'request') i.config.verifyTls = false;
        else i.verifyTls = false;
      }
    }
    return d;
  }

  it('survives an import and a re-export, and is only written when off', () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    importNative(db, workspaceId, validateNativeExport(insecureDoc()), {
      includeScripts: true,
      includeEnvironments: false,
    });

    const api = getCollectionTree(db, workspaceId).find((c) => c.name === 'Users API')!;
    expect(getRequest(db, api.requests[0].id)?.config.verifyTls).toBe(false);
    expect(getRequest(db, api.children[0].requests[0].id)?.config.verifyTls).toBeUndefined();
    expect(getWebSocketTree(db, workspaceId).find((c) => c.name === 'Sockets')?.connections[0].verifyTls).toBe(false);
    expect(getMcpTree(db, workspaceId).find((c) => c.name === 'Servers')?.connections[0].verifyTls).toBe(false);

    const exported = exportNative(
      db,
      workspaceId,
      { scope: 'workspace' },
      { includeSecrets: true, environmentIds: [] },
    );
    const imported = exported.collections.filter((c) => ['Users API', 'Sockets', 'Servers'].includes(c.name));
    const items = imported.flatMap((c) => c.items);
    expect(items.map((i) => (i.type === 'request' ? i.config.verifyTls : i.verifyTls))).toEqual([false, false, false]);
    // The nested request kept the check on, so its export has no verifyTls at all.
    const nested = imported[0].folders[0].items[0];
    expect(nested.type === 'request' && 'verifyTls' in nested.config).toBe(false);
  });

  it("leaves the check unset for items without it, so they follow the importer's default", () => {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    importNative(db, workspaceId, validateNativeExport(doc()), { includeScripts: true, includeEnvironments: false });
    const socket = getWebSocketTree(db, workspaceId).find((c) => c.name === 'Sockets')?.connections[0];
    const server = getMcpTree(db, workspaceId).find((c) => c.name === 'Servers')?.connections[0];
    expect(socket).toBeDefined();
    expect(socket).not.toHaveProperty('verifyTls');
    expect(server).not.toHaveProperty('verifyTls');
  });

  it('keeps an item that turns the check on, through an export and back', () => {
    const d = doc();
    const [echo] = d.collections[1].items as Array<Record<string, unknown>>;
    echo.verifyTls = true;
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    importNative(db, workspaceId, validateNativeExport(d), { includeScripts: true, includeEnvironments: false });
    const socket = getWebSocketTree(db, workspaceId).find((c) => c.name === 'Sockets')?.connections[0];
    expect(socket?.verifyTls).toBe(true);
    const exported = exportNative(
      db,
      workspaceId,
      { scope: 'workspace' },
      { includeSecrets: true, environmentIds: [] },
    );
    const items = exported.collections.flatMap((c) => c.items) as Array<Record<string, unknown>>;
    expect(items.find((i) => i.name === echo.name)).toMatchObject({ verifyTls: true });
  });

  it('rejects a value that is not true or false', () => {
    const d = doc();
    const [echo] = d.collections[1].items as Array<Record<string, unknown>>;
    echo.verifyTls = 'no';
    expect(() => validateNativeExport(d)).toThrow(/verifyTls.*expected true or false/);
  });
});

describe('messaging connections in export files', () => {
  function workspaceWithBroker() {
    const db = openDatabase(':memory:');
    const workspaceId = workspace(db);
    const rootId = getMessagingTree(db, workspaceId)[0].id;
    const created = createMessagingConnection(db, {
      collectionId: rootId,
      name: 'Chat server',
      protocol: 'socketio',
      url: 'https://chat.example/rooms',
    });
    updateMessagingConnection(db, created.id, {
      protocol: 'socketio',
      url: 'https://chat.example/rooms',
      headers: [{ key: 'X-Api-Key', value: 'k-123', enabled: true }],
      auth: { type: 'bearer', bearer: { token: 'tok' } },
      settings: { path: '/ws', auth: { room: 'lobby', password: 'p4ss' } },
      subscriptions: [{ channel: 'message' }, { channel: '*', options: { note: 'all' } }],
      verifyTls: false,
    });
    return { db, workspaceId };
  }

  it('exports and imports a connection with its settings and subscriptions', () => {
    const { db, workspaceId } = workspaceWithBroker();
    const file = exportNative(
      db,
      workspaceId,
      { scope: 'category', category: 'messaging' },
      { includeSecrets: true, environmentIds: [] },
    );
    expect(file.collections[0].items[0]).toEqual({
      type: 'messaging',
      name: 'Chat server',
      protocol: 'socketio',
      url: 'https://chat.example/rooms',
      headers: [{ key: 'X-Api-Key', value: 'k-123', enabled: true }],
      auth: { type: 'bearer', bearer: { token: 'tok' } },
      settings: { path: '/ws', auth: { room: 'lobby', password: 'p4ss' } },
      subscriptions: [{ channel: 'message' }, { channel: '*', options: { note: 'all' } }],
      verifyTls: false,
    });

    const target = openDatabase(':memory:');
    const targetWorkspace = workspace(target);
    importNative(target, targetWorkspace, validateNativeExport(JSON.parse(JSON.stringify(file))), {
      includeScripts: false,
      includeEnvironments: false,
    });
    // Import adds a collection of its own next to the seeded one.
    const imported = getMessagingTree(target, targetWorkspace).find((c) => c.connections.length > 0);
    expect(imported?.connections[0]).toMatchObject({
      protocol: 'socketio',
      settings: { path: '/ws', auth: { room: 'lobby', password: 'p4ss' } },
      subscriptions: [{ channel: 'message' }, { channel: '*', options: { note: 'all' } }],
      verifyTls: false,
    });
  });

  it('blanks secrets, including secret-named settings, unless asked not to', () => {
    const { db, workspaceId } = workspaceWithBroker();
    const [item] = exportNative(
      db,
      workspaceId,
      { scope: 'category', category: 'messaging' },
      { includeSecrets: false, environmentIds: [] },
    ).collections[0].items;
    expect(item).toMatchObject({
      headers: [{ key: 'X-Api-Key', value: '' }],
      settings: { path: '/ws', auth: { room: 'lobby', password: '' } },
    });
    expect(item.type === 'messaging' && item.auth.bearer?.token).toBe('');
  });

  it('refuses an unknown protocol or a malformed subscription', () => {
    const base = {
      format: 'jtaak-export',
      version: 1,
      scope: 'category',
      exportedAt: '2026-09-28T00:00:00.000Z',
      secretsStripped: false,
      environments: [],
    };
    const withItem = (item: Record<string, unknown>) => ({
      ...base,
      collections: [
        {
          category: 'messaging',
          name: 'B',
          folders: [],
          items: [{ type: 'messaging', name: 'x', url: 'u', headers: [], auth: { type: 'none' }, ...item }],
        },
      ],
    });
    expect(() => validateNativeExport(withItem({ protocol: 'smtp' }))).toThrow(/protocol: expected one of mqtt, kafka/);
    expect(() => validateNativeExport(withItem({ protocol: 'mqtt', subscriptions: [{ nope: 1 }] }))).toThrow(
      /subscriptions\[0\]\.channel/,
    );
    expect(validateNativeExport(withItem({ protocol: 'nats' })).collections[0].items[0]).toMatchObject({
      settings: {},
      subscriptions: [],
    });
  });
});
