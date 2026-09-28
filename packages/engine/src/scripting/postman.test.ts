import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runRequestWithScripts } from './runRequest';
import { unsupportedPostmanCalls } from './postman';
import { openDatabase } from '../storage/db';
import { getOrCreateDefaultWorkspace } from '../storage/repository';
import { importPostmanCollection } from '../import/postmanCollection';
import { emptyScopes, type RequestConfig } from '../types';

let server: http.Server;
let url: string;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(201, { 'content-type': 'application/json', 'x-request-id': 'abc' });
    res.end(JSON.stringify({ id: 7, name: 'Ann', tags: ['a', 'b'], token: 'tok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/users`;
});
afterAll(() => server.close());

const request = (overrides: Partial<RequestConfig> = {}): RequestConfig => ({
  id: 'r',
  name: 'Create user',
  method: 'POST',
  url,
  params: [],
  headers: [{ key: 'X-Trace', value: 'on', enabled: true }],
  body: { mode: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

describe('Postman scripts in the sandbox', () => {
  it('run as written: pm.test, Chai chains, pm.response, pm.environment and pm.variables', async () => {
    const result = await runRequestWithScripts(
      request({
        preRequestScript: `
          pm.variables.set("ts", "123");
          pm.environment.set("seen", pm.environment.get("base") + "!");
        `,
        testScript: `
          pm.test("created", () => {
            pm.response.to.have.status(201);
            pm.response.to.be.success;
            pm.response.to.have.header("X-Request-Id", "abc");
            pm.expect(pm.response.code).to.equal(201);
          });
          pm.test("body", () => {
            const json = pm.response.json();
            pm.expect(json).to.have.property("id", 7);
            pm.expect(json.name).to.be.a("string").and.to.include("An");
            pm.expect(json.tags).to.have.lengthOf(2).and.to.include("b");
            pm.expect(json).to.have.keys("id", "name", "tags", "token");
            pm.expect(json).to.deep.include({ name: "Ann" });
            pm.expect(json.id).to.be.above(5).and.below(10);
            pm.expect(json.missing).to.be.undefined;
            pm.expect(json.name).to.not.equal("Bob");
            pm.expect(json.tags).to.eql(["a", "b"]);
            pm.expect(pm.response.responseTime).to.be.at.least(0);
          });
          pm.test("request and variables", () => {
            pm.expect(pm.request.headers.get("x-trace")).to.equal("on");
            pm.expect(pm.request.url.toString()).to.include("/users");
            pm.expect(pm.variables.get("ts")).to.equal("123");
            pm.expect(pm.info.requestName).to.equal("Create user");
            pm.expect(pm.variables.replaceIn("t={{ts}}")).to.equal("t=123");
          });
          pm.environment.set("token", pm.response.json().token);
          pm.test("fails clearly", () => pm.expect(pm.response.code).to.equal(200));
        `,
      }),
      { ...emptyScopes(), environment: { base: 'b' } },
    );
    expect(result.testResults).toEqual([
      { name: 'created', passed: true },
      { name: 'body', passed: true },
      { name: 'request and variables', passed: true },
      { name: 'fails clearly', passed: false, error: 'expected 201 to equal 200' },
    ]);
    expect(result.environmentUpdates).toEqual({ seen: 'b!', token: 'tok' });
  });

  it('say which Postman call is missing', async () => {
    const result = await runRequestWithScripts(
      request({
        testScript: `
          pm.test("send", () => pm.sendRequest("https://x", () => {}));
          pm.test("iteration", () => pm.iterationData.get("x"));
          pm.test("schema", () => pm.response.to.have.jsonSchema({}));
        `,
      }),
      emptyScopes(),
    );
    expect(result.testResults.map((t) => t.error)).toEqual([
      "pm.sendRequest (scripts have no network) isn't supported here.",
      "pm.iterationData isn't supported here.",
      "pm.response.to.have.jsonSchema isn't supported here.",
    ]);
  });
});

describe('unsupportedPostmanCalls', () => {
  it('lists the calls the sandbox lacks, once each', () => {
    expect(
      unsupportedPostmanCalls(`
        pm.test("a", () => pm.expect(pm.response.json().ok).to.be.true);
        pm.environment.set("x", 1); pm.environment.clear();
        pm.sendRequest("u"); pm.sendRequest("v");
        postman.setEnvironmentVariable("t", 1);
        tests["status"] = responseCode.code === 200;
      `),
    ).toEqual(['pm.environment.clear', 'pm.sendRequest', 'postman.setEnvironmentVariable', 'tests[…]']);
    expect(unsupportedPostmanCalls('pm.test("x", () => pm.response.to.have.status(200));')).toEqual([]);
  });

  it('are reported by the Postman import, per request', () => {
    const db = openDatabase(':memory:');
    const { workspace } = getOrCreateDefaultWorkspace(db);
    const result = importPostmanCollection(db, workspace.id, {
      info: { name: 'API' },
      item: [
        {
          name: 'Fine',
          request: { method: 'GET', url: 'https://x' },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(200));'] } }],
        },
        {
          name: 'Chained',
          request: { method: 'GET', url: 'https://x' },
          event: [{ listen: 'prerequest', script: { exec: ['pm.sendRequest("https://auth", () => {});'] } }],
        },
      ],
    });
    expect(result.scriptWarnings).toEqual([{ requestName: 'Chained', calls: ['pm.sendRequest'] }]);
  });
});
