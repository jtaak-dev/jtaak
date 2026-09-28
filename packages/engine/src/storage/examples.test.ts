import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './db';
import {
  createResponseExample,
  deleteResponseExample,
  getResponseExample,
  listResponseExamples,
  listWorkspaceResponseExamples,
  renameResponseExample,
} from './examples';
import { createRequest, deleteRequest, getCollectionTree, getOrCreateDefaultWorkspace } from './repository';
import { exportNative } from '../export/nativeExport';
import { importNative, validateNativeExport } from '../import/nativeImport';
import { importPostmanCollection } from '../import/postmanCollection';
import type { RequestConfig } from '../types';

function setup(): { db: Database.Database; workspaceId: string; requestId: string } {
  const db = openDatabase(':memory:');
  const { workspace } = getOrCreateDefaultWorkspace(db);
  const [collection] = getCollectionTree(db, workspace.id);
  const config: RequestConfig = {
    id: '',
    name: 'Get user',
    method: 'GET',
    url: 'https://api.test/users/1',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
  };
  const request = createRequest(db, { collectionId: collection.id, name: 'Get user', config });
  return { db, workspaceId: workspace.id, requestId: request.id };
}

const ok = {
  name: 'Found',
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json', 'set-cookie': 'session=abc' },
  body: '{"id":1}',
};

describe('response examples', () => {
  it('are kept per request, in the order saved, and can be renamed and deleted', () => {
    const { db, workspaceId, requestId } = setup();
    const found = createResponseExample(db, requestId, ok);
    const missing = createResponseExample(db, requestId, {
      ...ok,
      name: 'Not found',
      status: 404,
      statusText: 'Not Found',
    });
    expect(listResponseExamples(db, requestId).map((e) => e.name)).toEqual(['Found', 'Not found']);
    expect(getResponseExample(db, found.id)).toEqual({ ...ok, id: found.id, requestId, createdAt: found.createdAt });
    expect(listWorkspaceResponseExamples(db, workspaceId)).toEqual([
      { id: found.id, requestId, name: 'Found', status: 200, statusText: 'OK', createdAt: found.createdAt },
      expect.objectContaining({ id: missing.id, status: 404 }),
    ]);

    renameResponseExample(db, found.id, 'User found');
    deleteResponseExample(db, missing.id);
    expect(listResponseExamples(db, requestId).map((e) => e.name)).toEqual(['User found']);
  });

  it('are deleted with their request', () => {
    const { db, requestId } = setup();
    const example = createResponseExample(db, requestId, ok);
    deleteRequest(db, requestId);
    expect(getResponseExample(db, example.id)).toBeUndefined();
  });

  it('travel in exports, with secret-named headers blanked unless secrets are kept, and import back', () => {
    const { db, workspaceId, requestId } = setup();
    createResponseExample(db, requestId, ok);
    const stripped = exportNative(
      db,
      workspaceId,
      { scope: 'workspace' },
      { includeSecrets: false, environmentIds: [] },
    );
    const [item] = stripped.collections[0].items;
    expect(item.type === 'request' && item.examples).toEqual([
      { ...ok, headers: { 'content-type': 'application/json', 'set-cookie': '' } },
    ]);
    const kept = exportNative(db, workspaceId, { scope: 'workspace' }, { includeSecrets: true, environmentIds: [] });
    const [keptItem] = kept.collections[0].items;
    expect(keptItem.type === 'request' && keptItem.examples?.[0].headers['set-cookie']).toBe('session=abc');

    const target = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(target);
    const result = importNative(target, workspace.id, validateNativeExport(kept), {
      includeScripts: false,
      includeEnvironments: false,
    });
    const imported = getCollectionTree(target, workspace.id).find((c) => c.id === result.collections[0].id)!;
    expect(
      listResponseExamples(target, imported.requests[0].id).map(({ name, status, body }) => ({ name, status, body })),
    ).toEqual([{ name: 'Found', status: 200, body: '{"id":1}' }]);
  });

  it('writes no examples field for a request without any, and rejects a bad status', () => {
    const { db, workspaceId } = setup();
    const doc = exportNative(db, workspaceId, { scope: 'workspace' }, { includeSecrets: false, environmentIds: [] });
    expect(doc.collections[0].items[0]).not.toHaveProperty('examples');
    const [item] = doc.collections[0].items;
    if (item.type === 'request') item.examples = [{ ...ok, status: 42 }];
    expect(() => validateNativeExport(doc)).toThrow(/examples\[0\]\.status: expected an HTTP status code/);
  });

  it("come from a Postman collection's saved responses", () => {
    const { db, workspaceId } = setup();
    const result = importPostmanCollection(db, workspaceId, {
      info: { name: 'API' },
      item: [
        {
          name: 'Get user',
          request: { method: 'GET', url: 'https://api.test/users/1' },
          response: [
            {
              name: 'Found',
              code: 200,
              status: 'OK',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: '{}',
            },
            { code: 404, status: 'Not Found', header: null, body: null },
            { name: 'No status code' },
          ],
        },
      ],
    });
    const [request] = getCollectionTree(db, workspaceId).find((c) => c.id === result.collectionId)!.requests;
    expect(
      listResponseExamples(db, request.id).map(({ name, status, statusText, headers, body }) => ({
        name,
        status,
        statusText,
        headers,
        body,
      })),
    ).toEqual([
      { name: 'Found', status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      { name: '404 Not Found', status: 404, statusText: 'Not Found', headers: {}, body: '' },
    ]);
  });
});
