import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import { createResponseExample, listResponseExamples } from './examples';
import { addHistoryEntry, listHistory } from './history';
import {
  createCollectionNode,
  createEnvironment,
  createMcpServerConnection,
  createMessagingConnection,
  createRequest,
  createWebSocketConnection,
  createWorkspace,
  getCollectionTree,
  getEnvironment,
  getMcpTree,
  getMessagingTree,
  getRequest,
  getWebSocketTree,
  getWorkspace,
  openWorkspace,
  reorderRequests,
  setEnvironmentSecrets,
  updateEnvironmentVariables,
  updateMessagingConnection,
  updateWebSocketConnection,
} from './repository';
import {
  WORKSPACE_FOLDER_VERSION,
  WorkspaceFolderError,
  applyWorkspaceFolder,
  findWorkspaceCredentials,
  readWorkspaceFolder,
  workspaceFolderFiles,
  writeWorkspaceFolder,
} from './workspaceFolder';
import type { RequestConfig, WorkspaceFolderFiles } from '../types';

function config(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: '',
    name: '',
    method: 'GET',
    url: '{{baseUrl}}/users',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

/** A workspace with something of every kind: collections and a folder in
 * every category, requests, connections, an environment with a secret, an
 * example, and a history entry (which stays out of the folder). */
function fixture(db: Database.Database) {
  const workspace = openWorkspace(db, createWorkspace(db, 'Team API').id)!;
  const api = getCollectionTree(db, workspace.id)[0];
  const folder = createCollectionNode(db, {
    workspaceId: workspace.id,
    parentFolderId: api.id,
    name: 'Users',
    kind: 'folder',
  });
  const list = createRequest(db, { collectionId: folder.id, name: 'List users', config: config() });
  const login = createRequest(db, {
    collectionId: api.id,
    name: 'Log in',
    config: config({
      method: 'POST',
      url: '{{baseUrl}}/login',
      headers: [{ key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }],
      auth: { type: 'bearer', bearer: { token: '{{token}}' } },
    }),
  });
  createResponseExample(db, login.id, {
    name: 'OK',
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=abc' },
    body: '{"ok":true}',
  });
  const ws = createWebSocketConnection(db, {
    collectionId: getWebSocketTree(db, workspace.id)[0].id,
    name: 'Chat',
    url: 'wss://chat',
  });
  updateWebSocketConnection(db, ws.id, {
    url: 'wss://chat',
    headers: [],
    subprotocols: ['v1'],
    auth: { type: 'none' },
    verifyTls: false,
    testScript: 'jt.test("ok", () => {});',
  });
  createMcpServerConnection(db, {
    collectionId: getMcpTree(db, workspace.id)[0].id,
    name: 'Files',
    transport: 'stdio',
    command: 'node server.js',
  });
  const broker = createMessagingConnection(db, {
    collectionId: getMessagingTree(db, workspace.id)[0].id,
    name: 'Events',
    protocol: 'mqtt',
    url: 'mqtt://broker',
  });
  updateMessagingConnection(db, broker.id, {
    protocol: 'mqtt',
    url: 'mqtt://broker',
    headers: [],
    auth: { type: 'none' },
    settings: { clientId: 'tests' },
    subscriptions: [{ channel: 'orders/#' }],
  });
  const env = createEnvironment(db, workspace.id, 'Staging');
  updateEnvironmentVariables(db, env.id, { baseUrl: 'https://staging', token: 'local-token-value' });
  setEnvironmentSecrets(db, env.id, ['token']);
  createEnvironment(db, null, 'Global one');
  addHistoryEntry(db, { workspaceId: workspace.id, requestId: list.id, config: config(), error: 'offline' });
  return { workspace, api, folder, list, login, ws, broker, env };
}

function parse(files: WorkspaceFolderFiles, file: string): Record<string, unknown> {
  return JSON.parse(files[file]) as Record<string, unknown>;
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-folder-'));
}

describe('workspaceFolderFiles', () => {
  it('writes one canonical file per item, keyed by id, without timestamps or secret values', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);

    expect(Object.keys(files).sort()).toEqual(
      [
        'workspace.json',
        ...[...getCollectionIdsOf(db, f.workspace.id)].map((id) => `collections/${id}.json`),
        `requests/${f.list.id}.json`,
        `requests/${f.login.id}.json`,
        `connections/websocket/${f.ws.id}.json`,
        `connections/mcp/${getMcpTree(db, f.workspace.id)[0].connections[0].id}.json`,
        `connections/messaging/${f.broker.id}.json`,
        `environments/${f.env.id}.json`,
        `examples/${listResponseExamples(db, f.login.id)[0].id}.json`,
      ].sort(),
    );
    expect(parse(files, 'workspace.json')).toEqual({
      formatVersion: WORKSPACE_FOLDER_VERSION,
      id: f.workspace.id,
      name: 'Team API',
    });
    expect(files[`collections/${f.folder.id}.json`]).toBe(
      `{\n  "category": "api",\n  "id": "${f.folder.id}",\n  "kind": "folder",\n  "name": "Users",\n  "order": 0,\n  "parentId": "${f.api.id}"\n}\n`,
    );
    expect(parse(files, `requests/${f.list.id}.json`)).toEqual({
      collectionId: f.folder.id,
      config: {
        auth: { type: 'none' },
        body: { mode: 'none' },
        headers: [],
        method: 'GET',
        params: [],
        url: '{{baseUrl}}/users',
      },
      id: f.list.id,
      name: 'List users',
      order: 0,
    });
    expect(parse(files, `environments/${f.env.id}.json`)).toEqual({
      id: f.env.id,
      name: 'Staging',
      variables: [
        { name: 'baseUrl', value: 'https://staging' },
        { name: 'token', value: '', secret: true },
      ],
    });
    const example = Object.keys(files).find((file) => file.startsWith('examples/'))!;
    expect(parse(files, example).headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Set-Cookie', value: '' },
    ]);
    const text = Object.values(files).join('');
    expect(text).not.toContain('local-token-value');
    expect(text).not.toContain('Global one');
    expect(text).not.toMatch(/createdAt|updatedAt|"workspaceId"/);
    for (const content of Object.values(files)) expect(content.endsWith('}\n')).toBe(true);
  });

  it('is the same bytes for the same data, whatever order things were saved in', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const before = workspaceFolderFiles(db, f.workspace.id);
    // The same config, its keys in another order.
    const saved = getRequest(db, f.list.id)!.config;
    const reversed = Object.fromEntries(Object.entries(saved).reverse()) as unknown as RequestConfig;
    db.prepare('UPDATE requests SET config_json = ? WHERE id = ?').run(JSON.stringify(reversed), f.list.id);
    expect(workspaceFolderFiles(db, f.workspace.id)).toEqual(before);
  });

  it('changes one file when one request moves among its siblings', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const extra = ['A', 'B', 'C'].map((name) =>
      createRequest(db, { collectionId: f.folder.id, name, config: config() }),
    );
    const before = workspaceFolderFiles(db, f.workspace.id);
    reorderRequests(db, [extra[2].id, f.list.id, extra[0].id, extra[1].id]);
    const after = workspaceFolderFiles(db, f.workspace.id);
    expect(Object.keys(after).filter((file) => after[file] !== before[file])).toEqual([`requests/${extra[2].id}.json`]);
  });
});

function getCollectionIdsOf(db: Database.Database, workspaceId: string): string[] {
  return (db.prepare('SELECT id FROM collections WHERE workspace_id = ?').all(workspaceId) as { id: string }[]).map(
    (row) => row.id,
  );
}

describe('applyWorkspaceFolder', () => {
  it('makes the same workspace in another database, ids and all: files → database → files is identical', () => {
    const source = openDatabase(':memory:');
    const f = fixture(source);
    const files = workspaceFolderFiles(source, f.workspace.id);

    const target = openDatabase(':memory:');
    const changes = applyWorkspaceFolder(target, files);
    expect(changes.added).toEqual(Object.keys(files).sort());
    expect(changes.updated).toEqual([]);
    expect(changes.removed).toEqual([]);
    expect(workspaceFolderFiles(target, f.workspace.id)).toEqual(files);

    expect(getWorkspace(target, f.workspace.id)!.name).toBe('Team API');
    expect(getRequest(target, f.login.id)!.config).toMatchObject({ id: f.login.id, name: 'Log in', method: 'POST' });
    // The secret's name came, not its value; nothing of this computer's came.
    expect(getEnvironment(target, f.env.id)).toMatchObject({ variables: { baseUrl: 'https://staging', token: '' } });
    expect(getEnvironment(target, f.env.id)!.secrets).toEqual(['token']);
    expect(listHistory(target, f.workspace.id)).toEqual([]);
    expect(getWebSocketTree(target, f.workspace.id)[0].connections[0]).toMatchObject({
      verifyTls: false,
      testScript: 'jt.test("ok", () => {});',
      subprotocols: ['v1'],
    });
  });

  it('seeds no default collections when the applied workspace is opened', () => {
    const source = openDatabase(':memory:');
    const workspace = createWorkspace(source, 'Bare');
    const files = workspaceFolderFiles(source, workspace.id);
    const target = openDatabase(':memory:');
    applyWorkspaceFolder(target, files);
    openWorkspace(target, workspace.id);
    expect(workspaceFolderFiles(target, workspace.id)).toEqual(files);
  });

  it('changes nothing when the folder is what the database has', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    expect(applyWorkspaceFolder(db, files)).toEqual({ added: [], updated: [], removed: [] });
    expect(getEnvironment(db, f.env.id)!.variables.token).toBe('local-token-value');
  });

  it('adds, updates, moves and removes items by id, keeping what is unchanged', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    const exampleFile = Object.keys(files).find((file) => file.startsWith('examples/'))!;
    const next = { ...files };

    // Log in moves into the folder and changes its URL; its example comes with it.
    const login = parse(files, `requests/${f.login.id}.json`);
    next[`requests/${f.login.id}.json`] = JSON.stringify({
      ...login,
      collectionId: f.folder.id,
      order: 1,
      config: { ...(login.config as object), url: '{{baseUrl}}/sign-in' },
    });
    // A new request; the WebSocket connection and the workspace's name change hands.
    next['requests/new-request.json'] = JSON.stringify({
      id: 'new-request',
      collectionId: f.api.id,
      name: 'Health',
      order: 5,
      config: {
        method: 'GET',
        url: '{{baseUrl}}/health',
        params: [],
        headers: [],
        body: { mode: 'none' },
        auth: { type: 'none' },
      },
    });
    delete next[`connections/websocket/${f.ws.id}.json`];
    next['workspace.json'] = JSON.stringify({ formatVersion: 1, id: f.workspace.id, name: 'Team API v2' });

    const changes = applyWorkspaceFolder(db, next);
    expect(changes).toEqual({
      added: ['requests/new-request.json'],
      updated: [`requests/${f.login.id}.json`, 'workspace.json'],
      removed: [`connections/websocket/${f.ws.id}.json`],
    });
    expect(getRequest(db, f.login.id)).toMatchObject({ collectionId: f.folder.id, url: '{{baseUrl}}/sign-in' });
    expect(getRequest(db, 'new-request')).toMatchObject({ name: 'Health', collectionId: f.api.id });
    expect(listResponseExamples(db, f.login.id)).toHaveLength(1);
    expect(getWebSocketTree(db, f.workspace.id)[0].connections).toEqual([]);
    expect(getWorkspace(db, f.workspace.id)!.name).toBe('Team API v2');
    expect(workspaceFolderFiles(db, f.workspace.id)[exampleFile]).toBe(files[exampleFile]);
  });

  it('removes a folder with what is in it, and a request with its examples', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    const next = Object.fromEntries(
      Object.entries(files).filter(
        ([file]) =>
          file !== `collections/${f.folder.id}.json` &&
          file !== `requests/${f.list.id}.json` &&
          file !== `requests/${f.login.id}.json` &&
          !file.startsWith('examples/'),
      ),
    );
    const changes = applyWorkspaceFolder(db, next);
    expect(changes.removed).toHaveLength(4);
    expect(getRequest(db, f.list.id)).toBeUndefined();
    expect(getCollectionTree(db, f.workspace.id)[0].children).toEqual([]);
    expect(workspaceFolderFiles(db, f.workspace.id)).toEqual(next);
  });

  it("keeps this computer's value of a secret variable when the environment changes", () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    const file = `environments/${f.env.id}.json`;
    const env = parse(files, file);
    applyWorkspaceFolder(db, {
      ...files,
      [file]: JSON.stringify({
        ...env,
        variables: [
          ...(env.variables as object[]),
          { name: 'region', value: 'eu' },
          { name: 'pin', value: '', secret: true },
        ],
      }),
    });
    expect(getEnvironment(db, f.env.id)).toMatchObject({
      variables: { baseUrl: 'https://staging', token: 'local-token-value', region: 'eu', pin: '' },
      secrets: ['pin', 'token'],
    });
  });

  it('refuses a malformed folder and changes nothing', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    const before = JSON.stringify(files);
    const listFile = `requests/${f.list.id}.json`;
    const folderFile = `collections/${f.folder.id}.json`;
    const cases: [WorkspaceFolderFiles, RegExp][] = [
      [{ ...files, [listFile]: '{ not json' }, /not valid JSON/],
      [{ ...files, [listFile]: JSON.stringify({ ...parse(files, listFile), id: 'other' }) }, /match the file name/],
      [
        { ...files, [listFile]: JSON.stringify({ ...parse(files, listFile), collectionId: 'gone' }) },
        /collection is missing/,
      ],
      [
        {
          ...files,
          [listFile]: JSON.stringify({
            ...parse(files, listFile),
            collectionId: getWebSocketTree(db, f.workspace.id)[0].id,
          }),
        },
        /isn't in the api category/,
      ],
      [
        { ...files, [folderFile]: JSON.stringify({ ...parse(files, folderFile), parentId: f.folder.id }) },
        /contain each other/,
      ],
      [
        { ...files, [listFile]: JSON.stringify({ ...parse(files, listFile), order: 'first' }) },
        /"order" must be a number/,
      ],
      [
        Object.fromEntries(Object.entries(files).filter(([file]) => file !== 'workspace.json')),
        /workspace.json: missing/,
      ],
    ];
    for (const [broken, message] of cases) {
      expect(() => applyWorkspaceFolder(db, broken)).toThrow(message);
    }
    try {
      applyWorkspaceFolder(db, cases[0][0]);
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceFolderError);
      expect((error as WorkspaceFolderError).reason).toBe('invalid');
    }
    expect(JSON.stringify(workspaceFolderFiles(db, f.workspace.id))).toBe(before);
  });

  it('refuses a folder written by a newer version', () => {
    const db = openDatabase(':memory:');
    const files = {
      'workspace.json': JSON.stringify({ formatVersion: WORKSPACE_FOLDER_VERSION + 1, id: 'w', name: 'W' }),
    };
    expect(() => applyWorkspaceFolder(db, files)).toThrow(expect.objectContaining({ reason: 'tooNew' }));
    expect(getWorkspace(db, 'w')).toBeUndefined();
  });

  it("refuses ids that belong to another workspace in the database, so one isn't copied over another", () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    const copy = { ...files, 'workspace.json': JSON.stringify({ formatVersion: 1, id: 'another', name: 'Copy' }) };
    expect(() => applyWorkspaceFolder(db, copy)).toThrow(expect.objectContaining({ reason: 'foreign' }));
    expect(getWorkspace(db, 'another')).toBeUndefined();
  });

  it('ignores files the format does not use', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const files = workspaceFolderFiles(db, f.workspace.id);
    const changes = applyWorkspaceFolder(db, { ...files, 'README.md': '# Team', 'requests/notes.txt': 'x' });
    expect(changes).toEqual({ added: [], updated: [], removed: [] });
  });
});

describe('findWorkspaceCredentials', () => {
  it('lists literal credentials, not references or variables marked secret', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const leaky = createRequest(db, {
      collectionId: f.api.id,
      name: 'Leaky',
      config: config({
        params: [{ key: 'access_token', value: 'qs-secret', enabled: true }],
        headers: [
          { key: 'Authorization', value: 'Bearer abc', enabled: true },
          { key: 'Accept', value: 'application/json', enabled: true },
        ],
        auth: { type: 'basic', basic: { username: 'me', password: 'hunter2' } },
      }),
    });
    updateMessagingConnection(db, f.broker.id, {
      protocol: 'mqtt',
      url: 'mqtt://broker',
      headers: [],
      auth: { type: 'none' },
      settings: { clientId: 'tests', password: 'broker-pw' },
      subscriptions: [],
    });
    updateEnvironmentVariables(db, f.env.id, {
      baseUrl: 'https://staging',
      token: 'local-token-value',
      apiKey: 'plain-key',
      sessionRef: '{{vault.session}}',
    });

    const files = workspaceFolderFiles(db, f.workspace.id);
    expect(findWorkspaceCredentials(files)).toEqual(
      [
        { file: `connections/messaging/${f.broker.id}.json`, field: 'settings.password' },
        { file: `environments/${f.env.id}.json`, field: 'variables.apiKey' },
        { file: `requests/${leaky.id}.json`, field: 'params.access_token' },
        { file: `requests/${leaky.id}.json`, field: 'headers.Authorization' },
        { file: `requests/${leaky.id}.json`, field: 'auth.basic.password' },
      ].sort((a, b) => a.file.localeCompare(b.file)),
    );
  });

  it('finds nothing in a folder that keeps its secrets in variables', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    expect(findWorkspaceCredentials(workspaceFolderFiles(db, f.workspace.id))).toEqual([]);
  });
});

describe('readWorkspaceFolder and writeWorkspaceFolder', () => {
  it('writes only what changed, removes what went, and leaves other files alone', () => {
    const db = openDatabase(':memory:');
    const f = fixture(db);
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Team\n');

    const files = workspaceFolderFiles(db, f.workspace.id);
    expect(writeWorkspaceFolder(dir, files).written).toEqual(Object.keys(files).sort());
    expect(readWorkspaceFolder(dir)).toEqual(files);
    expect(writeWorkspaceFolder(dir, files)).toEqual({ written: [], removed: [] });

    const next: WorkspaceFolderFiles = {
      ...files,
      'workspace.json': files['workspace.json'].replace('Team API', 'Renamed'),
    };
    delete next[`requests/${f.list.id}.json`];
    expect(writeWorkspaceFolder(dir, next)).toEqual({
      written: ['workspace.json'],
      removed: [`requests/${f.list.id}.json`],
    });
    expect(readWorkspaceFolder(dir)).toEqual(next);
    expect(fs.readFileSync(path.join(dir, 'README.md'), 'utf8')).toBe('# Team\n');
    expect(fs.existsSync(path.join(dir, '.git', 'HEAD'))).toBe(true);
  });

  it("refuses to write a path that isn't the format's", () => {
    expect(() => writeWorkspaceFolder(tempDir(), { '../escape.json': '{}' })).toThrow(/not a path/);
    expect(() => writeWorkspaceFolder(tempDir(), { 'requests/../../x.json': '{}' })).toThrow(/not a path/);
  });
});
