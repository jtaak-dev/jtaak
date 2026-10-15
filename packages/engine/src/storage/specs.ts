import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ApiSpec, ApiSpecKind, ApiSpecSummary } from '../types.js';

// API descriptions kept in a workspace (migration 13): imported OpenAPI and
// WSDL documents and introspected GraphQL schemas, deleted with it. Requests
// made from one name it (RequestConfig.source).

interface SpecRow {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  location: string | null;
  source: string;
  imported_at: number;
}

function toSummary(row: Omit<SpecRow, 'source'>): ApiSpecSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as ApiSpecKind,
    name: row.name,
    location: row.location,
    importedAt: row.imported_at,
  };
}

const toSpec = (row: SpecRow): ApiSpec => ({ ...toSummary(row), source: row.source });

export interface ApiSpecInput {
  workspaceId: string;
  kind: ApiSpecKind;
  name: string;
  location?: string | null;
  source: string;
}

/**
 * Keeps a spec. One with the same kind and location in the workspace is
 * replaced, keeping its id (an introspected schema fetched again, a WSDL
 * imported again), so requests linked to it stay linked.
 */
export function saveApiSpec(db: Database.Database, input: ApiSpecInput): ApiSpec {
  const importedAt = Date.now();
  const location = input.location?.trim() || null;
  const existing = location
    ? (db
        .prepare('SELECT id FROM api_specs WHERE workspace_id = ? AND kind = ? AND location = ?')
        .get(input.workspaceId, input.kind, location) as { id: string } | undefined)
    : undefined;
  const id = existing?.id ?? randomUUID();
  db.prepare(
    `INSERT INTO api_specs (id, workspace_id, kind, name, location, source, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = excluded.source, imported_at = excluded.imported_at`,
  ).run(id, input.workspaceId, input.kind, input.name, location, input.source, importedAt);
  return {
    id,
    workspaceId: input.workspaceId,
    kind: input.kind,
    name: input.name,
    location,
    source: input.source,
    importedAt,
  };
}

/** A workspace's specs without their text, newest first. */
export function listApiSpecs(db: Database.Database, workspaceId: string): ApiSpecSummary[] {
  const rows = db
    .prepare(
      'SELECT id, workspace_id, kind, name, location, imported_at FROM api_specs WHERE workspace_id = ? ORDER BY imported_at DESC, rowid DESC',
    )
    .all(workspaceId) as Omit<SpecRow, 'source'>[];
  return rows.map(toSummary);
}

/** A workspace's specs, whole, by id: what a mock server generates answers from. */
export function listWorkspaceApiSpecs(db: Database.Database, workspaceId: string): Map<string, ApiSpec> {
  const rows = db.prepare('SELECT * FROM api_specs WHERE workspace_id = ?').all(workspaceId) as SpecRow[];
  return new Map(rows.map((row) => [row.id, toSpec(row)]));
}

export function getApiSpec(db: Database.Database, id: string): ApiSpec | undefined {
  const row = db.prepare('SELECT * FROM api_specs WHERE id = ?').get(id) as SpecRow | undefined;
  return row && toSpec(row);
}

/** The spec of a kind kept for a location in a workspace (a GraphQL endpoint's schema, say). */
export function findApiSpec(
  db: Database.Database,
  workspaceId: string,
  kind: ApiSpecKind,
  location: string,
): ApiSpec | undefined {
  const row = db
    .prepare('SELECT * FROM api_specs WHERE workspace_id = ? AND kind = ? AND location = ?')
    .get(workspaceId, kind, location.trim()) as SpecRow | undefined;
  return row && toSpec(row);
}

/** Deletes a spec; requests made from it keep their link, which then names nothing. */
export function deleteApiSpec(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM api_specs WHERE id = ?').run(id);
}
