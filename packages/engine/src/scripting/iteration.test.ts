import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runRequestWithScripts } from './runRequest';
import { runCollection } from '../runner/collectionRunner';
import { emptyScopes, type RequestConfig } from '../types';

// A run's pass (ScriptIteration): scripts read it, Postman's pm.iterationData
// and pm.info.iteration work, and the row's values resolve as {{variables}}.

let server: http.Server;
let base: string;
beforeAll(async () => {
  server = http.createServer((req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ url: req.url })),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const request = (overrides: Partial<RequestConfig> = {}): RequestConfig => ({
  id: 'r',
  name: 'Get user',
  method: 'GET',
  url: `${base}/users/{{userId}}?env={{envOnly}}`,
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
  ...overrides,
});
const scopes = () => ({ ...emptyScopes(), environment: { userId: 'from-env', envOnly: 'e' } });
const iteration = { index: 2, count: 5, data: { userId: '42', name: 'Ann' } };

describe('iteration data', () => {
  it("resolves the row's values as variables, above the environment's, without saving them", async () => {
    const result = await runRequestWithScripts(request(), scopes(), undefined, { iteration });
    expect(JSON.parse(result.response!.body).url).toBe('/users/42?env=e');
    expect(result.environmentUpdates).toBeUndefined();
  });

  it('lets a script read the pass, and a value a script sets win over the row', async () => {
    const result = await runRequestWithScripts(
      request({
        preRequestScript: 'jt.variables.userId = "from-script";',
        testScript: `
          jt.test("pass", () => {
            jt.expect(jt.iteration.index).toBe(2);
            jt.expect(jt.iteration.count).toBe(5);
            jt.expect(jt.iteration.data.name).toBe("Ann");
          });
          jt.test("the row is a variable", () => jt.expect(jt.variables.name).toBe("Ann"));
        `,
      }),
      scopes(),
      undefined,
      { iteration },
    );
    expect(JSON.parse(result.response!.body).url).toBe('/users/from-script?env=e');
    expect(result.testResults).toEqual([
      { name: 'pass', passed: true },
      { name: 'the row is a variable', passed: true },
    ]);
  });

  it("runs Postman's pm.iterationData and pm.info.iteration, and has pass 0 of 1 outside a run", async () => {
    const script = `
      pm.test("data", () => {
        pm.expect(pm.iterationData.get("name")).to.equal("Ann");
        pm.expect(pm.iterationData.has("userId")).to.be.true;
        pm.expect(pm.iterationData.toObject()).to.eql({ userId: "42", name: "Ann" });
        pm.expect(pm.info.iteration).to.equal(2);
        pm.expect(pm.info.iterationCount).to.equal(5);
      });`;
    const inRun = await runRequestWithScripts(request({ testScript: script }), scopes(), undefined, { iteration });
    expect(inRun.testResults).toEqual([{ name: 'data', passed: true }]);

    const alone = await runRequestWithScripts(
      request({
        testScript: `pm.test("alone", () => {
          pm.expect(pm.info.iteration).to.equal(0);
          pm.expect(pm.info.iterationCount).to.equal(1);
          pm.expect(pm.iterationData.toObject()).to.eql({});
        });`,
      }),
      scopes(),
    );
    expect(alone.testResults).toEqual([{ name: 'alone', passed: true }]);
  });

  it('reaches every request of a collection run', async () => {
    const report = await runCollection(
      [1, 2].map((n) => ({
        id: `r${n}`,
        name: `r${n}`,
        config: request({ testScript: 'jt.test("row", () => jt.expect(jt.iteration.data.userId).toBe("42"));' }),
      })),
      scopes(),
      undefined,
      undefined,
      { iteration },
    );
    expect(report.passedAssertions).toBe(2);
    expect(report.items.map((item) => JSON.parse(item.result.response!.body).url)).toEqual([
      '/users/42?env=e',
      '/users/42?env=e',
    ]);
  });
});
