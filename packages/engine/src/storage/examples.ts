import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ExampleRequest, ResponseExample, ResponseExampleSummary } from '../types.js';

// Response examples (migration 8): responses saved under a name as
// examples of their request, deleted with it. Each can keep the request it
// answers and be its request's default (migration 12), for a mock server.

interface ExampleRow {
  id: string;
  request_id: string;
  name: string;
  status: number;
  status_text: string;
  headers_json: string;
  body: string;
  request_json: string | null;
  is_default: number;
  created_at: number;
}

function toExample(row: ExampleRow): ResponseExample {
  return {
    id: row.id,
    requestId: row.request_id,
    name: row.name,
    status: row.status,
    statusText: row.status_text,
    headers: JSON.parse(row.headers_json) as Record<string, string>,
    body: row.body,
    ...(row.request_json && { request: JSON.parse(row.request_json) as ExampleRequest }),
    ...(row.is_default === 1 && { isDefault: true }),
    createdAt: row.created_at,
  };
}

export type ResponseExampleInput = Pick<
  ResponseExample,
  'name' | 'status' | 'statusText' | 'headers' | 'body' | 'request' | 'isDefault'
>;

/** What can change in a saved example. `request: null` drops the request it keeps. */
export interface ResponseExampleChanges {
  name?: string;
  /** Its body, replaced (a stream example's reply rules, say). */
  body?: string;
  request?: ExampleRequest | null;
  isDefault?: boolean;
}

/** Makes `id` its request's only default (other examples of that request stop being it). */
function makeDefault(db: Database.Database, requestId: string, id: string): void {
  db.prepare('UPDATE response_examples SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE request_id = ?').run(
    id,
    requestId,
  );
}

/** Saves an example of a request, after its others. */
export function createResponseExample(
  db: Database.Database,
  requestId: string,
  input: ResponseExampleInput,
): ResponseExample {
  const id = randomUUID();
  const createdAt = Date.now();
  db.transaction(() => {
    const { next } = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM response_examples WHERE request_id = ?')
      .get(requestId) as { next: number };
    db.prepare(
      `INSERT INTO response_examples
         (id, request_id, name, status, status_text, headers_json, body, request_json, is_default, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      id,
      requestId,
      input.name,
      input.status,
      input.statusText,
      JSON.stringify(input.headers),
      input.body,
      input.request ? JSON.stringify(input.request) : null,
      next,
      createdAt,
    );
    if (input.isDefault) makeDefault(db, requestId, id);
  })();
  const { request, isDefault, ...rest } = input;
  return {
    id,
    requestId,
    ...rest,
    ...(request && { request }),
    ...(isDefault && { isDefault: true }),
    createdAt,
  };
}

/** A request's examples, in the order they were saved. */
export function listResponseExamples(db: Database.Database, requestId: string): ResponseExample[] {
  const rows = db
    .prepare('SELECT * FROM response_examples WHERE request_id = ? ORDER BY sort_order')
    .all(requestId) as ExampleRow[];
  return rows.map(toExample);
}

/** Every example in a workspace, without headers, bodies and requests: for listing them under their requests. */
export function listWorkspaceResponseExamples(db: Database.Database, workspaceId: string): ResponseExampleSummary[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.request_id, e.name, e.status, e.status_text, e.is_default, e.created_at
       FROM response_examples e
       JOIN requests r ON r.id = e.request_id
       JOIN collections c ON c.id = r.collection_id
       WHERE c.workspace_id = ?
       ORDER BY e.request_id, e.sort_order`,
    )
    .all(workspaceId) as Pick<
    ExampleRow,
    'id' | 'request_id' | 'name' | 'status' | 'status_text' | 'is_default' | 'created_at'
  >[];
  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    name: row.name,
    status: row.status,
    statusText: row.status_text,
    ...(row.is_default === 1 && { isDefault: true }),
    createdAt: row.created_at,
  }));
}

/** Every example in a workspace, whole, by request: what a mock server serves. */
export function listWorkspaceResponseExamplesFull(
  db: Database.Database,
  workspaceId: string,
): Map<string, ResponseExample[]> {
  const rows = db
    .prepare(
      `SELECT e.*
       FROM response_examples e
       JOIN requests r ON r.id = e.request_id
       JOIN collections c ON c.id = r.collection_id
       WHERE c.workspace_id = ?
       ORDER BY e.request_id, e.sort_order`,
    )
    .all(workspaceId) as ExampleRow[];
  const byRequest = new Map<string, ResponseExample[]>();
  for (const row of rows) {
    const list = byRequest.get(row.request_id) ?? [];
    list.push(toExample(row));
    byRequest.set(row.request_id, list);
  }
  return byRequest;
}

export function getResponseExample(db: Database.Database, id: string): ResponseExample | undefined {
  const row = db.prepare('SELECT * FROM response_examples WHERE id = ?').get(id) as ExampleRow | undefined;
  return row && toExample(row);
}

export function renameResponseExample(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE response_examples SET name = ? WHERE id = ?').run(name, id);
}

/** Changes a saved example's name, request or whether it's its request's default; returns it as it is now. */
export function updateResponseExample(
  db: Database.Database,
  id: string,
  changes: ResponseExampleChanges,
): ResponseExample | undefined {
  return db.transaction(() => {
    const row = db.prepare('SELECT request_id FROM response_examples WHERE id = ?').get(id) as
      { request_id: string } | undefined;
    if (!row) return undefined;
    if (changes.name !== undefined) renameResponseExample(db, id, changes.name);
    if (changes.body !== undefined)
      db.prepare('UPDATE response_examples SET body = ? WHERE id = ?').run(changes.body, id);
    if (changes.request !== undefined) {
      db.prepare('UPDATE response_examples SET request_json = ? WHERE id = ?').run(
        changes.request ? JSON.stringify(changes.request) : null,
        id,
      );
    }
    if (changes.isDefault === true) makeDefault(db, row.request_id, id);
    else if (changes.isDefault === false)
      db.prepare('UPDATE response_examples SET is_default = 0 WHERE id = ?').run(id);
    return getResponseExample(db, id);
  })();
}

export function deleteResponseExample(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM response_examples WHERE id = ?').run(id);
}
