import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import { getCollectionTree, getOrCreateDefaultWorkspace, getRequest } from '../storage/repository';
import { importOpenApi } from './openApi';

function freshDb(): Database.Database {
  return openDatabase(':memory:');
}

const spec = {
  info: { title: 'Pet Store' },
  servers: [{ url: 'https://api.petstore.example.com' }],
  paths: {
    '/pets': {
      get: { summary: 'List pets', tags: ['pets'] },
      post: {
        summary: 'Create pet',
        tags: ['pets'],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer' } } },
            },
          },
        },
      },
    },
    '/pets/{petId}': {
      get: {
        summary: 'Get pet',
        tags: ['pets'],
        parameters: [{ name: 'petId', in: 'path' }],
      },
    },
    '/health': {
      get: { summary: 'Health check' },
    },
  },
};

describe('importOpenApi', () => {
  it('creates a collection named after the spec title', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importOpenApi(db, workspace.id, spec);
    const tree = getCollectionTree(db, workspace.id);
    expect(tree.find((n) => n.id === result.collectionId)!.name).toBe('Pet Store');
  });

  it('groups tagged operations into a folder and counts requests/folders', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importOpenApi(db, workspace.id, spec);

    expect(result.requestCount).toBe(4);
    expect(result.folderCount).toBe(1);

    const root = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!;
    const petsFolder = root.children.find((n) => n.name === 'pets')!;
    expect(petsFolder.requests.map((r) => r.name).sort()).toEqual(['Create pet', 'Get pet', 'List pets']);
    expect(root.requests.map((r) => r.name)).toEqual(['Health check']);
  });

  it('prefixes the request URL with the base server URL and templates path params', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importOpenApi(db, workspace.id, spec);

    const root = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!;
    const petsFolder = root.children.find((n) => n.name === 'pets')!;
    const getPetSummary = petsFolder.requests.find((r) => r.name === 'Get pet')!;
    const getPet = getRequest(db, getPetSummary.id)!;
    expect(getPet.config.url).toBe('https://api.petstore.example.com/pets/{{petId}}');
  });

  it('generates an example JSON body from the request schema', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importOpenApi(db, workspace.id, spec);

    const root = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!;
    const petsFolder = root.children.find((n) => n.name === 'pets')!;
    const createPetSummary = petsFolder.requests.find((r) => r.name === 'Create pet')!;
    const createPet = getRequest(db, createPetSummary.id)!;
    expect(createPet.config.body.mode).toBe('json');
    expect(JSON.parse(createPet.config.body.raw!)).toEqual({ name: '', age: 0 });
  });
});
