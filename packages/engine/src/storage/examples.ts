import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ResponseExample, ResponseExampleSummary } from '../types.js';

// Response examples (migration 8): responses saved under a name as
// examples of their request, deleted with it.

interface ExampleRow {
  id: string;
  request_id: string;
  name: string;
  status: number;
  status_text: string;
  headers_json: string;
  body: string;
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
    createdAt: row.created_at,
  };
}

export type ResponseExampleInput = Pick<ResponseExample, 'name' | 'status' | 'statusText' | 'headers' | 'body'>;

/** Saves an example of a request, after its others. */
export function createResponseExample(
  db: Database.Database,
  requestId: string,
  input: ResponseExampleInput,
): ResponseExample {
  const id = randomUUID();
  const createdAt = Date.now();
  const { next } = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM response_examples WHERE request_id = ?')
    .get(requestId) as { next: number };
  db.prepare(
    `INSERT INTO response_examples (id, request_id, name, status, status_text, headers_json, body, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    requestId,
    input.name,
    input.status,
    input.statusText,
    JSON.stringify(input.headers),
    input.body,
    next,
    createdAt,
  );
  return { id, requestId, ...input, createdAt };
}

/** A request's examples, in the order they were saved. */
export function listResponseExamples(db: Database.Database, requestId: string): ResponseExample[] {
  const rows = db
    .prepare('SELECT * FROM response_examples WHERE request_id = ? ORDER BY sort_order')
    .all(requestId) as ExampleRow[];
  return rows.map(toExample);
}

/** Every example in a workspace, without headers and bodies: for listing them under their requests. */
export function listWorkspaceResponseExamples(db: Database.Database, workspaceId: string): ResponseExampleSummary[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.request_id, e.name, e.status, e.status_text, e.created_at
       FROM response_examples e
       JOIN requests r ON r.id = e.request_id
       JOIN collections c ON c.id = r.collection_id
       WHERE c.workspace_id = ?
       ORDER BY e.request_id, e.sort_order`,
    )
    .all(workspaceId) as Omit<ExampleRow, 'headers_json' | 'body'>[];
  return rows.map((row) => ({
    id: row.id,
    requestId: row.request_id,
    name: row.name,
    status: row.status,
    statusText: row.status_text,
    createdAt: row.created_at,
  }));
}

export function getResponseExample(db: Database.Database, id: string): ResponseExample | undefined {
  const row = db.prepare('SELECT * FROM response_examples WHERE id = ?').get(id) as ExampleRow | undefined;
  return row && toExample(row);
}

export function renameResponseExample(db: Database.Database, id: string, name: string): void {
  db.prepare('UPDATE response_examples SET name = ? WHERE id = ?').run(name, id);
}

export function deleteResponseExample(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM response_examples WHERE id = ?').run(id);
}
