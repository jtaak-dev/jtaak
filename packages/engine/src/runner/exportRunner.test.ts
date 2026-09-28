import { describe, expect, it } from 'vitest';
import { runnableRequestsFromExport } from './exportRunner';
import { junitReport } from './junit';
import type { CollectionRunReport, NativeExportDocument, RequestConfig } from '../types';

const config = (url: string, protocol: RequestConfig['protocol'] = 'http'): Omit<RequestConfig, 'id' | 'name'> => ({
  protocol,
  method: 'GET',
  url,
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
});

const doc: NativeExportDocument = {
  format: 'jtaak-export',
  version: 1,
  scope: 'workspace',
  exportedAt: '2026-09-28T00:00:00.000Z',
  secretsStripped: false,
  environments: [],
  collections: [
    {
      name: 'Users API',
      category: 'api',
      items: [
        { type: 'request', name: 'List', config: config('/users') },
        { type: 'request', name: 'Events', config: config('/events', 'sse') },
      ],
      folders: [
        {
          name: 'Admin',
          items: [{ type: 'request', name: 'Delete', config: config('/admin/delete') }],
          folders: [
            { name: 'Audit', items: [{ type: 'request', name: 'Log', config: config('/audit') }], folders: [] },
          ],
        },
      ],
    },
    {
      name: 'Sockets',
      category: 'websocket',
      items: [
        { type: 'websocket', name: 'Chat', url: 'ws://x', headers: [], subprotocols: [], auth: { type: 'none' } },
      ],
      folders: [],
    },
  ],
};

describe('runnableRequestsFromExport', () => {
  it('lists the API requests in order, with their paths, and skips streaming ones', () => {
    const { requests, skipped } = runnableRequestsFromExport(doc);
    expect(requests.map((r) => [r.path.join('/'), r.name, r.config.url])).toEqual([
      ['Users API', 'List', '/users'],
      ['Users API/Admin', 'Delete', '/admin/delete'],
      ['Users API/Admin/Audit', 'Log', '/audit'],
    ]);
    expect(skipped.map((r) => r.name)).toEqual(['Events']);
    expect(new Set(requests.map((r) => r.id)).size).toBe(3);
    expect(requests[0].config).toMatchObject({ id: requests[0].id, name: 'List' });
  });

  it('narrows to a folder, by path or by name, with its subfolders', () => {
    const byPath = runnableRequestsFromExport(doc, { folder: 'Users API/Admin' }).requests;
    expect(byPath.map((r) => r.name)).toEqual(['Delete', 'Log']);
    expect(runnableRequestsFromExport(doc, { folder: 'Audit' }).requests.map((r) => r.name)).toEqual(['Log']);
    expect(() => runnableRequestsFromExport(doc, { folder: 'Nope' })).toThrow('No collection or folder named "Nope"');
  });
});

describe('junitReport', () => {
  const response = { status: 200, statusText: 'OK', headers: {}, body: '', sizeBytes: 0 };
  const report: CollectionRunReport = {
    total: 3,
    passedAssertions: 1,
    failedAssertions: 1,
    requestsFailedToSend: 1,
    durationMs: 1500,
    items: [
      {
        requestId: 'a',
        requestName: 'List',
        result: {
          response: { ...response, timings: { start: 0, end: 120, durationMs: 120 } },
          scriptLogs: [],
          testResults: [
            { name: 'status is 200', passed: true },
            { name: 'has <users> & "more"', passed: false, error: 'expected 0 to be greater than 0' },
          ],
        },
      },
      { requestId: 'b', requestName: 'Delete', result: { testResults: [], scriptLogs: [], sendError: 'ECONNREFUSED' } },
      {
        requestId: 'c',
        requestName: 'Log',
        result: {
          response: { ...response, timings: { start: 0, end: 5, durationMs: 5 } },
          scriptLogs: [],
          testResults: [],
        },
      },
    ],
  };

  it('writes a suite per request and a case per test, with failures and errors', () => {
    const xml = junitReport(report, {
      name: 'Users API',
      paths: { a: ['Users API'], b: ['Users API', 'Admin'], c: ['Users API', 'Admin', 'Audit'] },
      timestamp: new Date('2026-09-28T10:00:00Z'),
    });
    expect(xml).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<testsuites name="Users API" tests="4" failures="1" errors="1" time="1.500">',
        '  <testsuite name="Users API / List" tests="2" failures="1" errors="0" time="0.120" timestamp="2026-09-28T10:00:00">',
        '    <testcase classname="Users API.List" name="status is 200" time="0.000"></testcase>',
        '    <testcase classname="Users API.List" name="has &lt;users&gt; &amp; &quot;more&quot;" time="0.000">',
        '      <failure message="expected 0 to be greater than 0" type="AssertionFailure">expected 0 to be greater than 0</failure>',
        '    </testcase>',
        '  </testsuite>',
        '  <testsuite name="Users API / Admin / Delete" tests="1" failures="0" errors="1" time="0.000" timestamp="2026-09-28T10:00:00">',
        '    <testcase classname="Users API.Admin.Delete" name="Delete" time="0.000">',
        '      <error message="ECONNREFUSED" type="RequestError">ECONNREFUSED</error>',
        '    </testcase>',
        '  </testsuite>',
        '  <testsuite name="Users API / Admin / Audit / Log" tests="1" failures="0" errors="0" time="0.005" timestamp="2026-09-28T10:00:00">',
        '    <testcase classname="Users API.Admin.Audit.Log" name="Log (200 OK)" time="0.005"/>',
        '  </testsuite>',
        '</testsuites>',
        '',
      ].join('\n'),
    );
  });

  it("adds the run's properties to every suite", () => {
    const xml = junitReport(
      { ...report, items: report.items.slice(2) },
      { name: 'Run', properties: { machine: 'build-01', note: 'a "quoted" <value>' } },
    );
    expect(xml).toContain(
      [
        '    <properties>',
        '      <property name="machine" value="build-01"/>',
        '      <property name="note" value="a &quot;quoted&quot; &lt;value&gt;"/>',
        '    </properties>',
        '    <testcase',
      ].join('\n'),
    );
  });

  it('writes an empty run, and drops characters XML cannot hold', () => {
    const empty = junitReport({ ...report, items: [], durationMs: 0 }, { name: 'bad\u0001name' });
    expect(empty).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="badname" tests="0" failures="0" errors="0" time="0.000">\n</testsuites>\n',
    );
  });
});
