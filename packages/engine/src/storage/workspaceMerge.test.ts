import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import { createResponseExample } from './examples';
import {
  createCollectionNode,
  createEnvironment,
  createRequest,
  createWorkspace,
  deleteCollectionNode,
  deleteRequest,
  getCollectionTree,
  moveCollectionNode,
  moveRequest,
  openWorkspace,
  renameRequest,
  renameWorkspace,
  reorderRequests,
} from './repository';
import { WORKSPACE_FOLDER_VERSION, applyWorkspaceFolder, workspaceFolderFiles } from './workspaceFolder';
import { mergeWorkspaceFolders, resolveWorkspaceMerge } from './workspaceMerge';
import type { RequestConfig, WorkspaceFolderFiles, WorkspaceMergeChoices } from '../types';

function config(url = 'https://api.test'): RequestConfig {
  return {
    id: '',
    name: '',
    method: 'GET',
    url,
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
  };
}

/**
 * A base workspace (an API collection with folder F holding folder G,
 * requests r1 in F, r2 in G and r3 at the top with an example, and an
 * environment), and two databases that start from it: ours and theirs.
 */
function setup() {
  const db = openDatabase(':memory:');
  const workspace = openWorkspace(db, createWorkspace(db, 'Team').id)!;
  const api = getCollectionTree(db, workspace.id)[0];
  const f = createCollectionNode(db, { workspaceId: workspace.id, parentFolderId: api.id, name: 'F', kind: 'folder' });
  const g = createCollectionNode(db, { workspaceId: workspace.id, parentFolderId: f.id, name: 'G', kind: 'folder' });
  const r1 = createRequest(db, { collectionId: f.id, name: 'r1', config: config() });
  const r2 = createRequest(db, { collectionId: g.id, name: 'r2', config: config() });
  const r3 = createRequest(db, { collectionId: api.id, name: 'r3', config: config() });
  createResponseExample(db, r3.id, { name: 'OK', status: 200, statusText: 'OK', headers: {}, body: '' });
  createEnvironment(db, workspace.id, 'Staging');
  const base = workspaceFolderFiles(db, workspace.id);
  const ours = openDatabase(':memory:');
  const theirs = openDatabase(':memory:');
  applyWorkspaceFolder(ours, base);
  applyWorkspaceFolder(theirs, base);
  const files = (side: Database.Database) => workspaceFolderFiles(side, workspace.id);
  const merge = () => mergeWorkspaceFolders(base, files(ours), files(theirs));
  return { base, ours, theirs, files, merge, workspaceId: workspace.id, api, f, g, r1, r2, r3 };
}

function json(files: WorkspaceFolderFiles, file: string): Record<string, unknown> {
  return JSON.parse(files[file]) as Record<string, unknown>;
}

/** The merged folder can be applied over ours and into an empty database. */
function expectApplies(files: WorkspaceFolderFiles, ours: Database.Database) {
  expect(() => applyWorkspaceFolder(openDatabase(':memory:'), files)).not.toThrow();
  expect(() => applyWorkspaceFolder(ours, files)).not.toThrow();
}

describe('mergeWorkspaceFolders', () => {
  it('takes each side’s own changes, deletes included', () => {
    const s = setup();
    renameRequest(s.ours, s.r1.id, 'r1 ours');
    renameRequest(s.theirs, s.r2.id, 'r2 theirs');
    deleteRequest(s.theirs, s.r3.id);

    const result = s.merge();
    expect(result.conflicts).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(json(result.files, `requests/${s.r1.id}.json`).name).toBe('r1 ours');
    expect(json(result.files, `requests/${s.r2.id}.json`).name).toBe('r2 theirs');
    expect(result.files[`requests/${s.r3.id}.json`]).toBeUndefined();
    expect(Object.keys(result.files).some((file) => file.startsWith('examples/'))).toBe(false);
    expectApplies(result.files, s.ours);
  });

  it('accepts the same change made on both sides', () => {
    const s = setup();
    renameRequest(s.ours, s.r1.id, 'Same');
    renameRequest(s.theirs, s.r1.id, 'Same');
    const result = s.merge();
    expect(result.conflicts).toEqual([]);
    expect(json(result.files, `requests/${s.r1.id}.json`).name).toBe('Same');
  });

  it('keeps what each side added', () => {
    const s = setup();
    const mine = createRequest(s.ours, { collectionId: s.f.id, name: 'mine', config: config() });
    const yours = createRequest(s.theirs, { collectionId: s.f.id, name: 'yours', config: config() });
    const result = s.merge();
    expect(result.conflicts).toEqual([]);
    expect(result.files[`requests/${mine.id}.json`]).toBeDefined();
    expect(result.files[`requests/${yours.id}.json`]).toBeDefined();
    expectApplies(result.files, s.ours);
  });

  it('makes an item both sides changed differently a conflict, resolved by choosing a side', () => {
    const s = setup();
    renameRequest(s.ours, s.r1.id, 'A');
    renameRequest(s.theirs, s.r1.id, 'B');
    const file = `requests/${s.r1.id}.json`;

    const result = s.merge();
    expect(result.conflicts).toEqual([
      {
        file,
        kind: 'request',
        id: s.r1.id,
        ours: { name: 'A', text: s.files(s.ours)[file] },
        theirs: { name: 'B', text: s.files(s.theirs)[file] },
      },
    ]);
    // Until chosen, ours stands in, and the folder can still be applied.
    expect(json(result.files, file).name).toBe('A');
    expectApplies(result.files, s.ours);

    expect(json(resolveWorkspaceMerge(result, { [file]: 'ours' }).files, file).name).toBe('A');
    expect(json(resolveWorkspaceMerge(result, { [file]: 'theirs' }).files, file).name).toBe('B');
    expect(() => resolveWorkspaceMerge(result, {})).toThrow(/Choose ours or theirs/);
  });

  it('keeps an item one side changed and the other deleted, either way round', () => {
    const s = setup();
    renameRequest(s.ours, s.r1.id, 'edited here');
    deleteRequest(s.theirs, s.r1.id);
    renameRequest(s.theirs, s.r2.id, 'edited there');
    deleteRequest(s.ours, s.r2.id);

    const result = s.merge();
    expect(result.conflicts).toEqual([]);
    expect(json(result.files, `requests/${s.r1.id}.json`).name).toBe('edited here');
    expect(json(result.files, `requests/${s.r2.id}.json`).name).toBe('edited there');
    expect(result.notes).toHaveLength(2);
    expect(result.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: s.r1.id, kind: 'request', change: 'keptEdit', side: 'theirs' }),
        expect.objectContaining({ id: s.r2.id, kind: 'request', change: 'keptEdit', side: 'ours' }),
      ]),
    );
  });

  it("moves what one side put in a folder the other deleted to the category's first collection, nested folders included", () => {
    const s = setup();
    deleteCollectionNode(s.theirs, s.f.id); // with G, r1 and r2
    const added = createRequest(s.ours, { collectionId: s.g.id, name: 'added in G', config: config() });
    const h = createCollectionNode(s.ours, {
      workspaceId: s.workspaceId,
      parentFolderId: s.g.id,
      name: 'H',
      kind: 'folder',
    });
    const deep = createRequest(s.ours, { collectionId: h.id, name: 'in H', config: config() });
    moveRequest(s.ours, s.r3.id, s.f.id);

    const result = s.merge();
    expect(result.conflicts).toEqual([]);
    const files = result.files;
    for (const gone of [s.f.id, s.g.id]) expect(files[`collections/${gone}.json`]).toBeUndefined();
    for (const gone of [s.r1.id, s.r2.id]) expect(files[`requests/${gone}.json`]).toBeUndefined();
    expect(json(files, `requests/${added.id}.json`).collectionId).toBe(s.api.id);
    expect(json(files, `requests/${s.r3.id}.json`).collectionId).toBe(s.api.id);
    // H moves; what's in H stays in it.
    expect(json(files, `collections/${h.id}.json`).parentId).toBe(s.api.id);
    expect(json(files, `requests/${deep.id}.json`).collectionId).toBe(h.id);
    expect(result.notes.map((n) => [n.name, n.change])).toEqual(
      expect.arrayContaining([
        ['H', 'moved'],
        ['added in G', 'moved'],
        ['r3', 'moved'],
      ]),
    );
    expectApplies(files, s.ours);
  });

  it('brings back the root collection when an item has no other collection of its category to go to', () => {
    const s = setup();
    deleteCollectionNode(s.theirs, s.api.id); // the only API collection
    const added = createRequest(s.ours, { collectionId: s.g.id, name: 'added', config: config() });

    const result = s.merge();
    expect(json(result.files, `collections/${s.api.id}.json`)).toMatchObject({ parentId: null, kind: 'collection' });
    expect(json(result.files, `requests/${added.id}.json`).collectionId).toBe(s.api.id);
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: s.api.id, kind: 'collection', change: 'restored' })]),
    );
    expectApplies(result.files, s.ours);
  });

  it('drops an example whose request the other side deleted', () => {
    const s = setup();
    const example = createResponseExample(s.ours, s.r1.id, {
      name: 'New',
      status: 201,
      statusText: 'Created',
      headers: {},
      body: '',
    });
    deleteRequest(s.theirs, s.r1.id);

    const result = s.merge();
    expect(result.files[`examples/${example.id}.json`]).toBeUndefined();
    expect(result.notes).toEqual([expect.objectContaining({ id: example.id, kind: 'example', change: 'dropped' })]);
    expectApplies(result.files, s.ours);
  });

  it('separates folders each side moved into the other', () => {
    const s = setup();
    const p = createCollectionNode(s.ours, {
      workspaceId: s.workspaceId,
      parentFolderId: s.api.id,
      name: 'P',
      kind: 'folder',
    });
    const q = createCollectionNode(s.ours, {
      workspaceId: s.workspaceId,
      parentFolderId: s.api.id,
      name: 'Q',
      kind: 'folder',
    });
    const base = s.files(s.ours);
    applyWorkspaceFolder(s.theirs, base);
    moveCollectionNode(s.ours, p.id, q.id);
    moveCollectionNode(s.theirs, q.id, p.id);

    const result = mergeWorkspaceFolders(base, s.files(s.ours), s.files(s.theirs));
    const lower = [p.id, q.id].sort()[0];
    expect(json(result.files, `collections/${lower}.json`).parentId).toBe(s.api.id);
    expect(result.notes).toEqual([expect.objectContaining({ id: lower, change: 'moved' })]);
    expectApplies(result.files, s.ours);
  });

  it('makes renaming the workspace on both sides a conflict', () => {
    const s = setup();
    renameWorkspace(s.ours, s.workspaceId, 'Ours');
    renameWorkspace(s.theirs, s.workspaceId, 'Theirs');
    const result = s.merge();
    expect(result.conflicts).toEqual([
      expect.objectContaining({
        file: 'workspace.json',
        kind: 'workspace',
        id: s.workspaceId,
        ours: expect.objectContaining({ name: 'Ours' }),
        theirs: expect.objectContaining({ name: 'Theirs' }),
      }),
    ]);
    const resolved = resolveWorkspaceMerge(result, { 'workspace.json': 'theirs' });
    expect(json(resolved.files, 'workspace.json').name).toBe('Theirs');
  });

  it('merges folders with no common version: the same items agree, different ones conflict', () => {
    const s = setup();
    renameRequest(s.theirs, s.r1.id, 'different');
    const result = mergeWorkspaceFolders({}, s.files(s.ours), s.files(s.theirs));
    expect(result.conflicts.map((c) => c.id)).toEqual([s.r1.id]);
  });

  it('refuses a folder in a newer format, and leaves out files the format does not use', () => {
    const s = setup();
    const newer = {
      ...s.files(s.theirs),
      'workspace.json': JSON.stringify({ formatVersion: WORKSPACE_FOLDER_VERSION + 1, id: s.workspaceId, name: 'x' }),
    };
    expect(() => mergeWorkspaceFolders(s.base, s.files(s.ours), newer)).toThrow(
      expect.objectContaining({ reason: 'tooNew' }),
    );
    const result = mergeWorkspaceFolders(s.base, { ...s.files(s.ours), 'README.md': '# x' }, s.files(s.theirs));
    expect(result.files['README.md']).toBeUndefined();
  });
});

describe('mergeWorkspaceFolders and resolveWorkspaceMerge, on random changes', () => {
  it('always give a folder that can be applied', () => {
    let seed = 42;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const pick = <T>(list: T[]): T | undefined => list[Math.floor(random() * list.length)];

    const collections = (db: Database.Database) =>
      db.prepare("SELECT id, parent_folder_id AS parent FROM collections WHERE category = 'api'").all() as {
        id: string;
        parent: string | null;
      }[];
    const requests = (db: Database.Database) =>
      db.prepare('SELECT id, collection_id AS collection FROM requests').all() as { id: string; collection: string }[];
    const inside = (db: Database.Database, id: string, ancestor: string) => {
      const parents = new Map(collections(db).map((c) => [c.id, c.parent]));
      for (let at: string | null | undefined = id; at; at = parents.get(at)) if (at === ancestor) return true;
      return false;
    };

    const change = (db: Database.Database, workspaceId: string) => {
      const collection = pick(collections(db));
      const request = pick(requests(db));
      switch (Math.floor(random() * 10)) {
        case 0:
          if (collection) createRequest(db, { collectionId: collection.id, name: `n${random()}`, config: config() });
          break;
        case 1:
          if (request) deleteRequest(db, request.id);
          break;
        case 2:
          if (request) renameRequest(db, request.id, `r${Math.floor(random() * 3)}`);
          break;
        case 3:
          if (request && collection) moveRequest(db, request.id, collection.id);
          break;
        case 4:
          if (collection) {
            createCollectionNode(db, { workspaceId, parentFolderId: collection.id, name: 'new', kind: 'folder' });
          }
          break;
        case 5:
          if (collection && random() < 0.7) deleteCollectionNode(db, collection.id);
          break;
        case 6: {
          const target = pick(collections(db));
          if (collection && target && collection.parent && !inside(db, target.id, collection.id)) {
            moveCollectionNode(db, collection.id, target.id);
          }
          break;
        }
        case 7:
          if (request)
            createResponseExample(db, request.id, { name: 'e', status: 200, statusText: 'OK', headers: {}, body: '' });
          break;
        case 8:
          renameWorkspace(db, workspaceId, `w${Math.floor(random() * 2)}`);
          break;
        default:
          if (collection) {
            const ids = requests(db)
              .filter((r) => r.collection === collection.id)
              .map((r) => r.id);
            reorderRequests(db, ids.reverse());
          }
      }
    };

    const seen = { conflicts: 0, moved: 0, keptEdit: 0, dropped: 0 };
    for (let round = 0; round < 40; round += 1) {
      const s = setup();
      for (let i = 0; i < 6; i += 1) {
        change(s.ours, s.workspaceId);
        change(s.theirs, s.workspaceId);
      }
      const result = s.merge();
      expectApplies(result.files, s.ours);
      const choices: WorkspaceMergeChoices = Object.fromEntries(
        result.conflicts.map((c) => [c.file, random() < 0.5 ? 'ours' : 'theirs']),
      );
      const resolved = resolveWorkspaceMerge(result, choices);
      expectApplies(resolved.files, openDatabase(':memory:'));
      expect(() => applyWorkspaceFolder(s.theirs, resolved.files)).not.toThrow();
      if (result.conflicts.length === 0) expect(resolved.files).toEqual(result.files);
      seen.conflicts += result.conflicts.length;
      for (const note of resolved.notes) if (note.change in seen) seen[note.change as keyof typeof seen] += 1;
    }
    // The changes were enough to reach every rule.
    for (const count of Object.values(seen)) expect(count).toBeGreaterThan(0);
  }, 30_000);
});
