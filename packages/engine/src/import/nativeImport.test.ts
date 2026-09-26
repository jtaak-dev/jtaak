import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import {
  createCollectionNode,
  createRequest,
  createWorkspace,
  getCollectionTree,
  getMcpTree,
  getOrCreateDefaultWorkspace,
  getRequest,
  getWebSocketTree,
  listEnvironments,
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
