import type { GraphQlFieldSummary, GraphQlSchemaSummary, GraphQlTypeSummary, NetworkSettings } from '../types.js';
import { fetchFor } from '../request/tls.js';

// Standard GraphQL introspection query (per the GraphQL spec), trimmed to
// just what a schema browser/autocomplete UI needs: type names/kinds/
// descriptions and each field's name + type. Four levels of `ofType` covers
// realistic wrapper nesting (e.g. `[User!]!`) without introspecting args,
// enums, or interfaces, which no caller needs yet.
const INTROSPECTION_QUERY = `
  query IntrospectionSchema {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        kind
        name
        description
        fields(includeDeprecated: true) {
          name
          description
          type { ...TypeRef }
        }
      }
    }
  }
  fragment TypeRef on __Type {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
        }
      }
    }
  }
`;

interface RawTypeRef {
  kind: string;
  name: string | null;
  ofType: RawTypeRef | null;
}

interface RawField {
  name: string;
  description: string | null;
  type: RawTypeRef;
}

interface RawSchemaType {
  kind: string;
  name: string;
  description: string | null;
  fields: RawField[] | null;
}

interface RawSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  subscriptionType: { name: string } | null;
  types: RawSchemaType[];
}

function formatTypeRef(type: RawTypeRef): string {
  if (type.kind === 'NON_NULL') return `${formatTypeRef(type.ofType!)}!`;
  if (type.kind === 'LIST') return `[${formatTypeRef(type.ofType!)}]`;
  return type.name ?? 'Unknown';
}

function toFieldSummary(field: RawField): GraphQlFieldSummary {
  return { name: field.name, description: field.description ?? undefined, typeName: formatTypeRef(field.type) };
}

function toTypeSummary(type: RawSchemaType): GraphQlTypeSummary {
  return {
    name: type.name,
    kind: type.kind,
    description: type.description ?? undefined,
    fields: (type.fields ?? []).map(toFieldSummary),
  };
}

// Keyed by endpoint URL — introspecting the same endpoint twice in a session
// (e.g. reopening the schema browser) shouldn't re-hit the network every
// time. `forceRefresh` is the escape hatch for "the API changed, re-fetch."
const schemaCache = new Map<string, GraphQlSchemaSummary>();

export interface FetchGraphQlSchemaOptions {
  headers?: Record<string, string>;
  forceRefresh?: boolean;
  /** As the request's own (`RequestConfig.verifyTls`, `RequestConfig.network`). */
  verifyTls?: boolean;
  network?: NetworkSettings;
}

/**
 * Introspects a GraphQL endpoint and returns a flattened summary of its
 * types/fields for the schema browser and (later) query autocomplete.
 * `headers` should mirror whatever auth headers the real request would send
 * — most GraphQL APIs require the same auth for introspection as for any
 * other query.
 */
export async function fetchGraphQlSchema(
  url: string,
  options: FetchGraphQlSchemaOptions = {},
): Promise<GraphQlSchemaSummary> {
  if (!options.forceRefresh) {
    const cached = schemaCache.get(url);
    if (cached) return cached;
  }

  const response = await fetchFor(options)(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    body: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'IntrospectionSchema' }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL introspection request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as { data?: { __schema?: RawSchema }; errors?: Array<{ message: string }> };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`GraphQL introspection returned errors: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  const rawSchema = json.data?.__schema;
  if (!rawSchema) {
    throw new Error('GraphQL introspection response had no __schema field — is this a GraphQL endpoint?');
  }

  const summary: GraphQlSchemaSummary = {
    queryType: rawSchema.queryType?.name,
    mutationType: rawSchema.mutationType?.name ?? undefined,
    subscriptionType: rawSchema.subscriptionType?.name ?? undefined,
    // Introspection's own __-prefixed meta-types (__Schema, __Type, ...)
    // are never useful to browse or autocomplete against.
    types: rawSchema.types.filter((type) => !type.name.startsWith('__')).map(toTypeSummary),
    fetchedAt: Date.now(),
  };

  schemaCache.set(url, summary);
  return summary;
}

/** Clears the cached schema for one endpoint, or every endpoint if omitted. */
export function clearGraphQlSchemaCache(url?: string): void {
  if (url) schemaCache.delete(url);
  else schemaCache.clear();
}
