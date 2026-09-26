import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { clearGraphQlSchemaCache, fetchGraphQlSchema } from './introspection';

let server: http.Server;
let baseUrl: string;
let requestCount: number;
let lastHeaders: http.IncomingHttpHeaders;

// A trimmed-but-realistic __schema payload: a Query type, a User type with
// a required id, an optional name, and a required list of required friends
// (exercises NON_NULL/LIST unwrapping), plus scalar types and one
// introspection meta-type (__Type) that must be filtered out of the summary.
const CANNED_SCHEMA_RESPONSE = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          description: null,
          fields: [{ name: 'user', description: 'Get a user', type: { kind: 'OBJECT', name: 'User', ofType: null } }],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          description: null,
          fields: [
            {
              name: 'id',
              description: null,
              type: { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name: 'ID', ofType: null } },
            },
            { name: 'name', description: null, type: { kind: 'SCALAR', name: 'String', ofType: null } },
            {
              name: 'friends',
              description: null,
              type: {
                kind: 'NON_NULL',
                name: null,
                ofType: {
                  kind: 'LIST',
                  name: null,
                  ofType: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'User', ofType: null } },
                },
              },
            },
          ],
        },
        { kind: 'SCALAR', name: 'ID', description: null, fields: null },
        { kind: 'SCALAR', name: 'String', description: null, fields: null },
        { kind: 'OBJECT', name: '__Type', description: null, fields: [] },
      ],
    },
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requestCount += 1;
    lastHeaders = req.headers;
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CANNED_SCHEMA_RESPONSE));
      void body;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/graphql`;
});

afterAll(() => server.close());

afterEach(() => {
  clearGraphQlSchemaCache();
  requestCount = 0;
});

describe('fetchGraphQlSchema', () => {
  it('flattens introspection into a type/field summary, unwrapping NON_NULL/LIST', async () => {
    const schema = await fetchGraphQlSchema(baseUrl);

    expect(schema.queryType).toBe('Query');
    expect(schema.mutationType).toBeUndefined();
    expect(schema.types.map((t) => t.name).sort()).toEqual(['ID', 'Query', 'String', 'User']);

    const user = schema.types.find((t) => t.name === 'User')!;
    expect(user.fields.find((f) => f.name === 'id')!.typeName).toBe('ID!');
    expect(user.fields.find((f) => f.name === 'name')!.typeName).toBe('String');
    expect(user.fields.find((f) => f.name === 'friends')!.typeName).toBe('[User!]!');
  });

  it('sends caller-provided headers (e.g. auth) with the introspection request', async () => {
    await fetchGraphQlSchema(baseUrl, { headers: { Authorization: 'Bearer abc123' } });
    expect(lastHeaders.authorization).toBe('Bearer abc123');
  });

  it('caches by URL and only re-fetches when forceRefresh is set', async () => {
    await fetchGraphQlSchema(baseUrl);
    await fetchGraphQlSchema(baseUrl);
    expect(requestCount).toBe(1);

    await fetchGraphQlSchema(baseUrl, { forceRefresh: true });
    expect(requestCount).toBe(2);
  });
});

describe('performance budget: introspection fetch+parse', () => {
  it('completes in under 100ms for a typical schema', async () => {
    const start = performance.now();
    await fetchGraphQlSchema(baseUrl);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
