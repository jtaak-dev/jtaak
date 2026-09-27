import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from './db';
import { MIGRATIONS, migrate, schemaVersion } from './migrations';
import { createRequest, deleteRequest, getOrCreateDefaultWorkspace, getCollectionTree } from './repository';
import {
  addHistoryEntry,
  clearHistory,
  deleteHistoryEntry,
  getHistoryEntry,
  listHistory,
  pruneHistory,
} from './history';
import type { ExecutedResponse, RequestConfig } from '../types';

function config(overrides: Partial<RequestConfig> = {}): RequestConfig {
  return {
    id: 'req',
    name: 'List users',
    method: 'GET',
    url: 'https://api.example.com/users?page={{page}}',
    params: [],
    headers: [],
    body: { mode: 'none' },
    auth: { type: 'none' },
    ...overrides,
  };
}

function response(body = '{"ok":true}'): ExecutedResponse {
  return {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body,
    timings: { start: 0, end: 42, durationMs: 42 },
    sizeBytes: Buffer.byteLength(body),
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const { workspace } = getOrCreateDefaultWorkspace(db);
  return { db, workspaceId: workspace.id };
}

describe('migration 2', () => {
  it('adds the history columns to a version 1 database, keeping its rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS.slice(0, 1));
    db.prepare("INSERT INTO request_history (id, executed_at, status, duration_ms) VALUES ('old', 1, 204, 3)").run();

    migrate(db);
    expect(schemaVersion(db)).toBe(2);
    expect(
      db.prepare("SELECT status, tests_total, response_truncated FROM request_history WHERE id = 'old'").get(),
    ).toEqual({ status: 204, tests_total: 0, response_truncated: 0 });
  });
});

describe('history', () => {
  it('records a request with its response and test results', () => {
    const { db, workspaceId } = setup();
    const summary = addHistoryEntry(db, {
      workspaceId,
      config: config(),
      response: response(),
      testResults: [
        { name: 'is 200', passed: true },
        { name: 'has users', passed: false, error: 'expected 0 to be greater than 0' },
      ],
      executedAt: 1000,
    });
    expect(summary).toMatchObject({
      workspaceId,
      requestId: null,
      executedAt: 1000,
      name: 'List users',
      protocol: 'http',
      method: 'GET',
      url: 'https://api.example.com/users?page={{page}}',
      status: 200,
      durationMs: 42,
      sizeBytes: 11,
      testsPassed: 1,
      testsTotal: 2,
      error: null,
    });

    const entry = getHistoryEntry(db, summary.id)!;
    // Stored as given: the variables are still there.
    expect(entry.config.url).toBe('https://api.example.com/users?page={{page}}');
    expect(entry.response).toEqual(response());
    expect(entry.responseTruncated).toBe(false);
  });

  it('records a request that could not be sent', () => {
    const { db, workspaceId } = setup();
    const summary = addHistoryEntry(db, { workspaceId, config: config(), error: 'getaddrinfo ENOTFOUND' });
    expect(summary).toMatchObject({ status: null, durationMs: null, sizeBytes: null, error: 'getaddrinfo ENOTFOUND' });
    expect(getHistoryEntry(db, summary.id)!.response).toBeNull();
  });

  it('keeps only the status, duration and size when told not to store the response', () => {
    const { db, workspaceId } = setup();
    const summary = addHistoryEntry(
      db,
      { workspaceId, config: config(), response: response() },
      { storeResponse: false },
    );
    expect(summary).toMatchObject({ status: 200, durationMs: 42, sizeBytes: 11, error: null });
    const entry = getHistoryEntry(db, summary.id)!;
    expect(entry.response).toBeNull();
    expect(entry.config.name).toBe('List users');
  });

  it('cuts long bodies without splitting a character, keeping the full size', () => {
    const { db, workspaceId } = setup();
    // "é" is two bytes in UTF-8, so a 5-byte limit falls in the middle of the third.
    const body = 'éééé';
    const summary = addHistoryEntry(
      db,
      { workspaceId, config: config(), response: response(body) },
      { maxBodyBytes: 5 },
    );
    const entry = getHistoryEntry(db, summary.id)!;
    expect(entry.response!.body).toBe('éé');
    expect(entry.responseTruncated).toBe(true);
    expect(entry.sizeBytes).toBe(8);
    expect(entry.response!.sizeBytes).toBe(8);
  });

  it('lists newest first, a page at a time, across entries sent in the same millisecond', () => {
    const { db, workspaceId } = setup();
    for (const executedAt of [100, 200, 200, 200, 300]) {
      addHistoryEntry(db, { workspaceId, config: config(), response: response(), executedAt });
    }
    const all = listHistory(db, workspaceId);
    expect(all.map((e) => e.executedAt)).toEqual([300, 200, 200, 200, 100]);

    const pages: string[][] = [];
    let before: { executedAt: number; id: string } | undefined;
    for (;;) {
      const page = listHistory(db, workspaceId, { limit: 2, before });
      if (page.length === 0) break;
      pages.push(page.map((e) => e.id));
      const last = page.at(-1)!;
      before = { executedAt: last.executedAt, id: last.id };
    }
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat()).toEqual(all.map((e) => e.id));
  });

  it('orders entries from the same millisecond by when they were added, and prunes by that too', () => {
    const { db, workspaceId } = setup();
    for (const name of ['first', 'second', 'third', 'fourth']) {
      addHistoryEntry(db, { workspaceId, config: config({ name }), response: response(), executedAt: 500 });
    }
    expect(listHistory(db, workspaceId).map((e) => e.name)).toEqual(['fourth', 'third', 'second', 'first']);
    pruneHistory(db, workspaceId, 2);
    expect(listHistory(db, workspaceId).map((e) => e.name)).toEqual(['fourth', 'third']);
  });

  it('searches names and URLs, case-insensitively, taking % and _ literally', () => {
    const { db, workspaceId } = setup();
    addHistoryEntry(db, { workspaceId, config: config({ name: 'List users' }), response: response() });
    addHistoryEntry(db, { workspaceId, config: config({ name: 'Orders', url: 'https://shop.test/orders' }) });
    addHistoryEntry(db, { workspaceId, config: config({ name: '100% done', url: 'https://x.test/a_b' }) });

    expect(listHistory(db, workspaceId, { search: 'USERS' }).map((e) => e.name)).toEqual(['List users']);
    expect(listHistory(db, workspaceId, { search: 'shop.test' }).map((e) => e.name)).toEqual(['Orders']);
    expect(listHistory(db, workspaceId, { search: '0%' }).map((e) => e.name)).toEqual(['100% done']);
    expect(listHistory(db, workspaceId, { search: 'a_b' }).map((e) => e.name)).toEqual(['100% done']);
    expect(listHistory(db, workspaceId, { search: '_' })).toHaveLength(1);
  });

  it("keeps each workspace's history apart, and goes with its workspace", () => {
    const { db, workspaceId } = setup();
    db.prepare("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)").run();
    addHistoryEntry(db, { workspaceId, config: config(), response: response() });
    addHistoryEntry(db, { workspaceId: 'other', config: config(), response: response() });
    expect(listHistory(db, workspaceId)).toHaveLength(1);

    db.prepare("DELETE FROM workspaces WHERE id = 'other'").run();
    expect(listHistory(db, 'other')).toHaveLength(0);
    expect(listHistory(db, workspaceId)).toHaveLength(1);
  });

  it('keeps entries when their saved request is deleted, unlinked from it', () => {
    const { db, workspaceId } = setup();
    const collectionId = getCollectionTree(db, workspaceId)[0].id;
    const saved = createRequest(db, { collectionId, name: 'Saved', config: config() });
    const summary = addHistoryEntry(db, { workspaceId, requestId: saved.id, config: saved.config });
    expect(summary.requestId).toBe(saved.id);

    deleteRequest(db, saved.id);
    expect(getHistoryEntry(db, summary.id)!.requestId).toBeNull();
  });

  it('deletes one entry, prunes to the newest, and clears', () => {
    const { db, workspaceId } = setup();
    const ids = [1, 2, 3, 4, 5].map(
      (executedAt) => addHistoryEntry(db, { workspaceId, config: config(), response: response(), executedAt }).id,
    );
    deleteHistoryEntry(db, ids[0]);
    expect(listHistory(db, workspaceId)).toHaveLength(4);

    expect(pruneHistory(db, workspaceId, 2)).toBe(2);
    expect(listHistory(db, workspaceId).map((e) => e.executedAt)).toEqual([5, 4]);

    expect(clearHistory(db, workspaceId)).toBe(2);
    expect(listHistory(db, workspaceId)).toEqual([]);
  });
});
