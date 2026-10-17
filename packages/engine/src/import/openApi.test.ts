import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../storage/db';
import { getCollectionTree, getOrCreateDefaultWorkspace, getRequest } from '../storage/repository';
import { importOpenApi, openApiOperation, parseOpenApiText, resolveOpenApiRefs } from './openApi';
import { listResponseExamples } from '../storage/examples';
import { getApiSpec, listApiSpecs } from '../storage/specs';

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

  it('reads YAML, resolves references, keeps the spec and links each request to its operation', () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const yaml = [
      'openapi: 3.0.3',
      'info: { title: Users }',
      'servers:',
      '  - url: https://{region}.api.test/v1',
      '    variables: { region: { default: eu } }',
      'paths:',
      '  /users/{id}:',
      '    parameters:',
      '      - { name: id, in: path }',
      '      - { name: verbose, in: query, schema: { default: "false" } }',
      '    get:',
      '      operationId: getUser',
      '      responses:',
      "        '200':",
      '          content:',
      '            application/json:',
      '              schema: { $ref: "#/components/schemas/User" }',
      '              examples:',
      '                ann: { value: { id: 1, name: Ann } }',
      '                bob: { value: { id: 2, name: Bob } }',
      "        '404':",
      '          content:',
      '            application/json: { example: { error: not found } }',
      '        default: { description: oops }',
      '    put:',
      '      requestBody:',
      '        content:',
      '          application/merge-patch+json:',
      '            schema: { $ref: "#/components/schemas/User" }',
      '      responses: {}',
      'components:',
      '  schemas:',
      '    User:',
      '      type: object',
      '      properties:',
      '        id: { type: integer }',
      '        name: { type: string, example: Ann }',
      '        friends: { type: array, items: { $ref: "#/components/schemas/User" } }',
    ].join('\n');
    const result = importOpenApi(db, workspace.id, yaml, { location: 'users.yaml' });
    expect(result).toMatchObject({ requestCount: 2, exampleCount: 3 });

    const spec = getApiSpec(db, result.specId!)!;
    expect(spec).toMatchObject({ kind: 'openapi', name: 'Users', location: 'users.yaml', source: yaml });
    expect(listApiSpecs(db, workspace.id)).toHaveLength(1);

    const root = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!;
    const [get, put] = root.requests.map((r) => getRequest(db, r.id)!);
    expect(get.config).toMatchObject({
      name: 'getUser',
      url: 'https://eu.api.test/v1/users/{{id}}',
      params: [{ key: 'verbose', value: 'false', enabled: true }],
      source: { specId: spec.id, operation: 'GET /users/{id}' },
    });
    // A reference into itself is cut at the second visit.
    expect(JSON.parse(put.config.body.raw!)).toEqual({ id: 0, name: 'Ann', friends: [null] });

    const examples = listResponseExamples(db, get.id);
    expect(examples.map((e) => [e.name, e.status, e.statusText, e.isDefault ?? false])).toEqual([
      ['200 application/json: ann', 200, 'OK', true],
      ['200 application/json: bob', 200, 'OK', false],
      ['404 application/json', 404, 'Not Found', false],
    ]);
    expect(JSON.parse(examples[0].body)).toEqual({ id: 1, name: 'Ann' });
    expect(examples[0].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(examples[0].request).toMatchObject({
      method: 'GET',
      url: 'https://eu.api.test/v1/users/{{id}}?verbose=false',
    });
    expect(examples[0].request).not.toHaveProperty('match');

    // Importing the same location again keeps the spec's id.
    expect(importOpenApi(db, workspace.id, yaml, { location: 'users.yaml' }).specId).toBe(spec.id);
  });

  it("takes a Swagger 2.0 document's host, body and examples", () => {
    const db = freshDb();
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importOpenApi(db, workspace.id, {
      swagger: '2.0',
      info: { title: 'Old' },
      host: 'old.test',
      basePath: '/api',
      schemes: ['http'],
      paths: {
        '/things': {
          post: {
            parameters: [
              { name: 'thing', in: 'body', schema: { type: 'object', properties: { n: { type: 'integer' } } } },
            ],
            responses: { '201': { examples: { 'application/json': { n: 1 } } } },
          },
        },
      },
    });
    const [request] = getCollectionTree(db, workspace.id).find((n) => n.id === result.collectionId)!.requests;
    const config = getRequest(db, request.id)!.config;
    expect(config.url).toBe('http://old.test/api/things');
    expect(JSON.parse(config.body.raw!)).toEqual({ n: 0 });
    expect(listResponseExamples(db, request.id)[0]).toMatchObject({
      status: 201,
      statusText: 'Created',
      body: '{\n  "n": 1\n}',
    });
  });

  it('refuses what is neither JSON nor YAML, nor an object', () => {
    expect(() => parseOpenApiText('a: [')).toThrow(/JSON or YAML/);
    expect(() => parseOpenApiText('- 1')).toThrow(/should be an object/);
  });

  it('finds an operation of a resolved document', () => {
    const doc = resolveOpenApiRefs(parseOpenApiText(JSON.stringify(spec)));
    expect(openApiOperation(doc, 'GET /pets/{petId}')?.summary).toBe('Get pet');
    expect(openApiOperation(doc, 'DELETE /pets')).toBeUndefined();
    expect(openApiOperation(doc, 'nonsense')).toBeUndefined();
  });
});
