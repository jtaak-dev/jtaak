import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ExecutedResponse,
  HistoryEntry,
  HistoryEntryInput,
  HistoryEntrySummary,
  HistoryQuery,
  HttpMethod,
  Protocol,
  RequestConfig,
} from '../types.js';

/** The largest response body a history entry keeps; longer ones are cut. */
export const DEFAULT_HISTORY_BODY_LIMIT = 256 * 1024;

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1000;

interface HistoryRow {
  id: string;
  workspace_id: string;
  request_id: string | null;
  executed_at: number;
  name: string | null;
  protocol: string | null;
  method: string | null;
  url: string | null;
  status: number | null;
  duration_ms: number | null;
  size_bytes: number | null;
  tests_passed: number;
  tests_total: number;
  error: string | null;
  request_json: string | null;
  response_json: string | null;
  response_truncated: number;
}

const SUMMARY_COLUMNS =
  'id, workspace_id, request_id, executed_at, name, protocol, method, url, status, duration_ms, size_bytes, tests_passed, tests_total, error';

function toSummary(row: HistoryRow): HistoryEntrySummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    executedAt: row.executed_at,
    name: row.name ?? '',
    protocol: (row.protocol ?? 'http') as Protocol,
    method: (row.method ?? 'GET') as HttpMethod,
    url: row.url ?? '',
    status: row.status,
    durationMs: row.duration_ms,
    sizeBytes: row.size_bytes,
    testsPassed: row.tests_passed,
    testsTotal: row.tests_total,
    error: row.error,
  };
}

/** Cuts `body` to at most `maxBytes` of UTF-8, without splitting a character. */
function truncateBody(body: string, maxBytes: number): { body: string; truncated: boolean } {
  if (Buffer.byteLength(body, 'utf-8') <= maxBytes) return { body, truncated: false };
  // A cut through a multi-byte character decodes to a trailing U+FFFD; drop it.
  const cut = Buffer.from(body, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  return { body: cut.replace(/�$/, ''), truncated: true };
}

/**
 * Records a sent request, and its response or why it couldn't be sent. Bodies
 * longer than `maxBodyBytes` are cut (the entry says so, and keeps the full
 * size). What goes in `config` is the caller's decision (see HistoryEntryInput).
 */
export function addHistoryEntry(
  db: Database.Database,
  input: HistoryEntryInput,
  options: { maxBodyBytes?: number } = {},
): HistoryEntrySummary {
  const id = randomUUID();
  const executedAt = input.executedAt ?? Date.now();
  const config = input.config;
  const testResults = input.testResults ?? [];
  let response: ExecutedResponse | undefined = input.response;
  let truncated = false;
  if (response) {
    const cut = truncateBody(response.body, options.maxBodyBytes ?? DEFAULT_HISTORY_BODY_LIMIT);
    truncated = cut.truncated;
    if (truncated) response = { ...response, body: cut.body };
  }
  db.prepare(
    `INSERT INTO request_history (
      id, workspace_id, request_id, executed_at, name, protocol, method, url, status, duration_ms, size_bytes,
      tests_passed, tests_total, error, request_json, response_json, response_truncated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.workspaceId,
    input.requestId ?? null,
    executedAt,
    config.name,
    config.protocol ?? 'http',
    config.method,
    config.url,
    input.response?.status ?? null,
    input.response?.timings.durationMs ?? null,
    input.response?.sizeBytes ?? null,
    testResults.filter((r) => r.passed).length,
    testResults.length,
    input.error ?? null,
    JSON.stringify(config),
    response ? JSON.stringify(response) : null,
    truncated ? 1 : 0,
  );
  return toSummary(db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM request_history WHERE id = ?`).get(id) as HistoryRow);
}

/** A workspace's history, newest first, a page at a time. */
export function listHistory(
  db: Database.Database,
  workspaceId: string,
  query: HistoryQuery = {},
): HistoryEntrySummary[] {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? DEFAULT_LIST_LIMIT)), MAX_LIST_LIMIT);
  const conditions = ['workspace_id = ?'];
  const params: (string | number)[] = [workspaceId];
  if (query.before) {
    // The same millisecond can hold several entries; the id breaks the tie.
    conditions.push('(executed_at < ? OR (executed_at = ? AND id < ?))');
    params.push(query.before.executedAt, query.before.executedAt, query.before.id);
  }
  const search = query.search?.trim();
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push("(name LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }
  const rows = db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM request_history WHERE ${conditions.join(' AND ')}
       ORDER BY executed_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit) as HistoryRow[];
  return rows.map(toSummary);
}

/** One entry, with the request as recorded and its response. */
export function getHistoryEntry(db: Database.Database, id: string): HistoryEntry | undefined {
  const row = db.prepare('SELECT * FROM request_history WHERE id = ?').get(id) as HistoryRow | undefined;
  if (!row || !row.request_json) return undefined;
  return {
    ...toSummary(row),
    config: JSON.parse(row.request_json) as RequestConfig,
    response: row.response_json ? (JSON.parse(row.response_json) as ExecutedResponse) : null,
    responseTruncated: row.response_truncated === 1,
  };
}

export function deleteHistoryEntry(db: Database.Database, id: string): void {
  db.prepare('DELETE FROM request_history WHERE id = ?').run(id);
}

/** Deletes a workspace's whole history; returns how many entries went. */
export function clearHistory(db: Database.Database, workspaceId: string): number {
  return db.prepare('DELETE FROM request_history WHERE workspace_id = ?').run(workspaceId).changes;
}

/** Keeps a workspace's `keep` newest entries and deletes the rest; returns
 * how many went. */
export function pruneHistory(db: Database.Database, workspaceId: string, keep: number): number {
  return db
    .prepare(
      `DELETE FROM request_history WHERE workspace_id = ? AND id NOT IN (
        SELECT id FROM request_history WHERE workspace_id = ? ORDER BY executed_at DESC, id DESC LIMIT ?
      )`,
    )
    .run(workspaceId, workspaceId, Math.max(0, Math.floor(keep))).changes;
}
