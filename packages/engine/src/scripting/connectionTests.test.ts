import { describe, expect, it } from 'vitest';
import { CONNECTION_TEST_DATA_LIMIT, CONNECTION_TEST_MESSAGE_LIMIT, runConnectionTests } from './connectionTests';
import { openDatabase } from '../storage/db';
import {
  createMessagingConnection,
  createWebSocketConnection,
  getMessagingConnection,
  getMessagingTree,
  getOrCreateDefaultWorkspace,
  getWebSocketConnection,
  getWebSocketTree,
  updateMessagingConnection,
  updateWebSocketConnection,
} from '../storage/repository';
import { exportNative } from '../export/nativeExport';
import { importNative, previewNativeImport, validateNativeExport } from '../import/nativeImport';
import type { RequestConfig } from '../types';
import type { ScriptStreamMessage } from './sandbox';

const request: RequestConfig = {
  id: 'c',
  name: 'Orders',
  protocol: 'mqtt',
  method: 'GET',
  url: 'mqtt://localhost',
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
};

const messages: ScriptStreamMessage[] = [
  { direction: 'sent', channel: 'orders/new', data: '{"id":7}', at: 10 },
  { direction: 'received', channel: 'orders/7', data: '{"status":"pending"}', at: 400 },
  { direction: 'received', channel: 'orders/7', data: '{"status":"paid"}', at: 1200 },
];

describe('runConnectionTests', () => {
  it('checks the messages so far, with json() and the time since the connection opened', async () => {
    const result = await runConnectionTests(
      `
        jt.test('an order is paid within 5 s', () => {
          const paid = jt.messages.find((m) => m.direction === 'received' && m.json().status === 'paid');
          jt.expect(paid).toBeDefined();
          jt.expect(paid.at).toBeLessThan(5000);
        });
        jt.test('nothing failed', () => {
          jt.expect(jt.messages.filter((m) => m.json().status === 'failed').length).toBe(0);
        });
        jt.test('refunded', () => jt.expect(jt.messages.some((m) => m.json().status === 'refunded')).toBe(true));
        console.log(jt.request.url, jt.messages.length, jt.variables.env);
      `,
      { request, messages, variables: { env: 'dev' } },
    );
    expect(result.error).toBeUndefined();
    expect(result.testResults.map((t) => [t.name, t.passed])).toEqual([
      ['an order is paid within 5 s', true],
      ['nothing failed', true],
      ['refunded', false],
    ]);
    expect(result.scriptLogs).toEqual([{ phase: 'test', level: 'log', message: 'mqtt://localhost 3 dev' }]);
  });

  it('gives only the newest messages, each cut to the limit', async () => {
    const many = Array.from({ length: CONNECTION_TEST_MESSAGE_LIMIT + 5 }, (_, i) => ({
      direction: 'received' as const,
      data: i === CONNECTION_TEST_MESSAGE_LIMIT + 4 ? 'x'.repeat(CONNECTION_TEST_DATA_LIMIT + 10) : String(i),
      at: i,
    }));
    const result = await runConnectionTests(
      `jt.test('limits', () => {
        jt.expect(jt.messages.length).toBe(${CONNECTION_TEST_MESSAGE_LIMIT});
        jt.expect(jt.messages[0].data).toBe('5');
        jt.expect(jt.messages[jt.messages.length - 1].data.length).toBe(${CONNECTION_TEST_DATA_LIMIT});
      });`,
      { request, messages: many },
    );
    expect(result.testResults).toEqual([{ name: 'limits', passed: true }]);
  });

  it('reports a script that throws, instead of results', async () => {
    const result = await runConnectionTests('throw new Error("broken")', { request, messages });
    expect(result).toMatchObject({ testResults: [], error: expect.stringContaining('broken') });
  });
});

describe("connections' test scripts", () => {
  it('are stored, kept when left out of an update, and removed when emptied', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const ws = createWebSocketConnection(db, {
      collectionId: getWebSocketTree(db, workspace.id)[0].id,
      name: 'W',
      url: 'ws://x',
    });
    const base = { url: 'ws://x', headers: [], subprotocols: [], auth: { type: 'none' as const } };
    updateWebSocketConnection(db, ws.id, { ...base, testScript: 'jt.test("a", () => {})' });
    expect(getWebSocketConnection(db, ws.id)?.testScript).toBe('jt.test("a", () => {})');
    updateWebSocketConnection(db, ws.id, base);
    expect(getWebSocketConnection(db, ws.id)?.testScript).toBe('jt.test("a", () => {})');
    updateWebSocketConnection(db, ws.id, { ...base, testScript: '' });
    expect(getWebSocketConnection(db, ws.id)?.testScript).toBeUndefined();

    const mq = createMessagingConnection(db, {
      collectionId: getMessagingTree(db, workspace.id)[0].id,
      name: 'M',
      protocol: 'mqtt',
      url: 'mqtt://x',
    });
    updateMessagingConnection(db, mq.id, {
      protocol: 'mqtt',
      url: 'mqtt://x',
      headers: [],
      auth: { type: 'none' },
      settings: {},
      subscriptions: [],
      testScript: 'jt.test("m", () => {})',
    });
    expect(getMessagingConnection(db, mq.id)?.testScript).toBe('jt.test("m", () => {})');
  });

  it('travel in exports, and come in on import only when scripts are included', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const ws = createWebSocketConnection(db, {
      collectionId: getWebSocketTree(db, workspace.id)[0].id,
      name: 'W',
      url: 'ws://x',
    });
    updateWebSocketConnection(db, ws.id, {
      url: 'ws://x',
      headers: [],
      subprotocols: [],
      auth: { type: 'none' },
      testScript: 'jt.test("w", () => {})',
    });
    const doc = validateNativeExport(
      JSON.parse(
        JSON.stringify(
          exportNative(db, workspace.id, { scope: 'workspace' }, { includeSecrets: false, environmentIds: [] }),
        ),
      ),
    );
    const item = doc.collections.find((c) => c.category === 'websocket')!.items[0];
    expect(item).toMatchObject({ type: 'websocket', testScript: 'jt.test("w", () => {})' });
    expect(previewNativeImport(doc).scriptRequestCount).toBe(1);

    const target = openDatabase(':memory:');
    const into = getOrCreateDefaultWorkspace(target).workspace.id;
    importNative(target, into, doc, { includeScripts: false, includeEnvironments: false });
    importNative(target, into, doc, { includeScripts: true, includeEnvironments: false });
    const imported = getWebSocketTree(target, into).flatMap((c) => c.connections);
    expect(imported.map((c) => c.testScript)).toEqual([undefined, 'jt.test("w", () => {})']);
  });
});
