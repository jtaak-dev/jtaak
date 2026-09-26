import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import { getCollectionTree, getOrCreateDefaultWorkspace, getRequest } from '../storage/repository';
import { importPostmanCollection } from './postmanCollection';

function freshDb(): Database.Database {
  return openDatabase(':memory:');
}

describe('importPostmanCollection', () => {
  it('creates a new top-level collection named after the Postman collection', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const result = importPostmanCollection(db, workspace.id, { info: { name: 'My API' }, item: [] });

    const tree = getCollectionTree(db, workspace.id);
    const imported = tree.find((n) => n.id === result.collectionId)!;
    expect(imported.name).toBe('My API');
    expect(imported.kind).toBe('collection');
  });

  it('recreates nested folders and counts them', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const result = importPostmanCollection(db, workspace.id, {
      info: { name: 'API' },
      item: [
        {
          name: 'Users',
          item: [
            { name: 'List users', request: { method: 'GET', url: 'https://api.example.com/users' } },
            {
              name: 'Admin',
              item: [{ name: 'Ban user', request: { method: 'POST', url: 'https://api.example.com/users/1/ban' } }],
            },
          ],
        },
      ],
    });

    expect(result.folderCount).toBe(2);
    expect(result.requestCount).toBe(2);

    const tree = getCollectionTree(db, workspace.id);
    const root = tree.find((n) => n.id === result.collectionId)!;
    const users = root.children.find((n) => n.name === 'Users')!;
    expect(users.requests.map((r) => r.name)).toEqual(['List users']);
    const admin = users.children.find((n) => n.name === 'Admin')!;
    expect(admin.requests.map((r) => r.name)).toEqual(['Ban user']);
  });

  it('converts method, url, query params, headers, and raw JSON body', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const result = importPostmanCollection(db, workspace.id, {
      info: { name: 'API' },
      item: [
        {
          name: 'Create order',
          request: {
            method: 'post',
            url: { raw: 'https://api.example.com/orders?debug=true', query: [{ key: 'debug', value: 'true' }] },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', options: { raw: { language: 'json' } }, raw: '{"item":"widget"}' },
          },
        },
      ],
    });

    const [saved] = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!.requests;
    const full = getRequest(db, saved.id)!;
    expect(full.config.method).toBe('POST');
    expect(full.config.url).toBe('https://api.example.com/orders?debug=true');
    expect(full.config.params).toEqual([{ key: 'debug', value: 'true', enabled: true }]);
    expect(full.config.headers).toEqual([{ key: 'Content-Type', value: 'application/json', enabled: true }]);
    expect(full.config.body).toEqual({ mode: 'json', raw: '{"item":"widget"}' });
  });

  it('converts bearer, basic, and apiKey auth', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const result = importPostmanCollection(db, workspace.id, {
      info: { name: 'API' },
      item: [
        {
          name: 'a',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: { type: 'bearer', bearer: [{ key: 'token', value: 'abc' }] },
          },
        },
        {
          name: 'b',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: {
              type: 'basic',
              basic: [
                { key: 'username', value: 'u' },
                { key: 'password', value: 'p' },
              ],
            },
          },
        },
        {
          name: 'c',
          request: {
            method: 'GET',
            url: 'https://x',
            auth: {
              type: 'apikey',
              apikey: [
                { key: 'key', value: 'X-Key' },
                { key: 'value', value: 'secret' },
                { key: 'in', value: 'query' },
              ],
            },
          },
        },
      ],
    });

    const requests = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!.requests;
    const configs = requests.map((r) => getRequest(db, r.id)!.config.auth);
    expect(configs[0]).toEqual({ type: 'bearer', bearer: { token: 'abc' } });
    expect(configs[1]).toEqual({ type: 'basic', basic: { username: 'u', password: 'p' } });
    expect(configs[2]).toEqual({ type: 'apiKey', apiKey: { key: 'X-Key', value: 'secret', addTo: 'query' } });
  });

  it('imports pre-request and test scripts verbatim', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const result = importPostmanCollection(db, workspace.id, {
      info: { name: 'API' },
      item: [
        {
          name: 'a',
          request: { method: 'GET', url: 'https://x' },
          event: [
            { listen: 'prerequest', script: { exec: ['pm.variables.set("x", "1");'] } },
            { listen: 'test', script: { exec: ['pm.test("ok", () => {});', 'console.log("done");'] } },
          ],
        },
      ],
    });

    const [saved] = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!.requests;
    const full = getRequest(db, saved.id)!;
    expect(full.config.preRequestScript).toBe('pm.variables.set("x", "1");');
    expect(full.config.testScript).toBe('pm.test("ok", () => {});\nconsole.log("done");');
  });
});

describe('performance budget: 5,000-request Postman collection import', () => {
  it('imports in under 5 seconds', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);

    const folders = Array.from({ length: 50 }, (_, f) => ({
      name: `Folder ${f}`,
      item: Array.from({ length: 100 }, (_, r) => ({
        name: `Request ${f}-${r}`,
        request: {
          method: 'GET',
          url: `https://api.example.com/resource/${f}/${r}`,
          header: [{ key: 'Accept', value: 'application/json' }],
        },
      })),
    }));

    const start = performance.now();
    const result = importPostmanCollection(db, workspace.id, { info: { name: 'Huge API' }, item: folders });
    const durationMs = performance.now() - start;

    expect(result.requestCount).toBe(5000);
    expect(result.folderCount).toBe(50);
    expect(durationMs).toBeLessThan(5000);
  });
});
