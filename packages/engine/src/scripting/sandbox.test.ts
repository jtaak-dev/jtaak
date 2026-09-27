import { describe, expect, it } from 'vitest';
import { preloadScriptEngine, runScript } from './sandbox';
import { DEFAULT_ENGINE_PROFILE, type ExecutedResponse, type RequestConfig } from '../types';

const baseRequest: RequestConfig = {
  id: 'req-1',
  name: 'test',
  method: 'GET',
  url: 'https://example.com',
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
};

const baseResponse: ExecutedResponse = {
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  body: '{"id":1,"name":"jtaak","tags":["fast","local"]}',
  timings: { start: 0, end: 5, durationMs: 5 },
  sizeBytes: 42,
};

// First in the file on purpose: this is where QuickJS's WebAssembly module
// is loaded, so these measure a real cold start. Loading is a one-off cost
// (about 25 ms), which a host application can pay at startup via
// preloadScriptEngine rather than on someone's first script.
describe('performance budget: sandbox cold start', () => {
  it('loads the script engine in under 150ms', async () => {
    const start = performance.now();
    await preloadScriptEngine();
    expect(performance.now() - start).toBeLessThan(150);
  });

  // About 16 ms on a developer machine, but 50–55 ms on shared CI runners, so
  // the ceiling leaves room for slow machines while still catching a real
  // regression.
  it('runs a first script in under 150ms', async () => {
    const start = performance.now();
    await runScript('jt.test("noop", () => jt.expect(1).toBe(1));', { request: baseRequest, variables: {} });
    const durationMs = performance.now() - start;
    expect(durationMs).toBeLessThan(150);
  });
});

describe('runScript', () => {
  it('records a passing test', async () => {
    const { results } = await runScript('jt.test("2 + 2", () => jt.expect(2 + 2).toBe(4));', {
      request: baseRequest,
      variables: {},
    });
    expect(results).toEqual([{ name: '2 + 2', passed: true }]);
  });

  it('records a failing test with its error message', async () => {
    const { results } = await runScript('jt.test("status is 201", () => jt.expect(200).toBe(201));', {
      request: baseRequest,
      variables: {},
    });
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain('expected 200 to be 201');
  });

  it('exposes response and variables to the script', async () => {
    const { results } = await runScript('jt.test("has token", () => jt.expect(jt.environment.token).toBeDefined());', {
      request: baseRequest,
      variables: { token: 'abc' },
    });
    expect(results[0].passed).toBe(true);
  });
});

describe('script namespace', () => {
  const acme = { ...DEFAULT_ENGINE_PROFILE, scriptNamespace: 'acme' };

  it("exposes the API under the profile's namespace, and only there", async () => {
    const { results, logs } = await runScript(
      'console.log(typeof jt); acme.test("works", () => acme.expect(1).toBe(1));',
      { request: baseRequest, variables: {} },
      undefined,
      acme,
    );
    expect(results).toEqual([{ name: 'works', passed: true }]);
    expect(logs).toEqual([{ level: 'log', message: 'undefined' }]);
  });

  it('rejects a namespace that is not a plain identifier', async () => {
    await expect(
      runScript('', { request: baseRequest, variables: {} }, undefined, {
        ...DEFAULT_ENGINE_PROFILE,
        scriptNamespace: 'x; globalThis.y',
      }),
    ).rejects.toThrow(/Invalid script namespace/);
  });
});

describe('console capture', () => {
  it('captures console.log/warn/error calls instead of printing to the host console', async () => {
    const { logs } = await runScript('console.log("hello", 1); console.warn("careful"); console.error("boom");', {
      request: baseRequest,
      variables: {},
    });
    expect(logs).toEqual([
      { level: 'log', message: 'hello 1' },
      { level: 'warn', message: 'careful' },
      { level: 'error', message: 'boom' },
    ]);
  });

  it('stringifies non-string console arguments as JSON', async () => {
    const { logs } = await runScript('console.log("value:", { a: 1 });', { request: baseRequest, variables: {} });
    expect(logs).toEqual([{ level: 'log', message: 'value: {"a":1}' }]);
  });
});

describe('assertion library', () => {
  const run = async (expr: string) =>
    (await runScript(`jt.test("t", () => ${expr});`, { request: baseRequest, variables: {} })).results;

  it('supports toEqual for deep equality', async () => {
    expect((await run('jt.expect({ a: [1, 2] }).toEqual({ a: [1, 2] })'))[0].passed).toBe(true);
    expect((await run('jt.expect({ a: [1, 2] }).toEqual({ a: [1, 3] })'))[0].passed).toBe(false);
  });

  it('supports truthy/falsy/null/undefined', async () => {
    expect((await run('jt.expect(1).toBeTruthy()'))[0].passed).toBe(true);
    expect((await run('jt.expect(0).toBeFalsy()'))[0].passed).toBe(true);
    expect((await run('jt.expect(null).toBeNull()'))[0].passed).toBe(true);
    expect((await run('jt.expect(undefined).toBeUndefined()'))[0].passed).toBe(true);
  });

  it('supports comparisons and contains', async () => {
    expect((await run('jt.expect(5).toBeGreaterThan(3)'))[0].passed).toBe(true);
    expect((await run('jt.expect(5).toBeLessThan(3)'))[0].passed).toBe(false);
    expect((await run('jt.expect("hello world").toContain("world")'))[0].passed).toBe(true);
    expect((await run('jt.expect([1, 2, 3]).toContain(2)'))[0].passed).toBe(true);
  });

  it('supports toHaveProperty with and without a value check', async () => {
    expect((await run('jt.expect({ status: 200 }).toHaveProperty("status")'))[0].passed).toBe(true);
    expect((await run('jt.expect({ status: 200 }).toHaveProperty("status", 200)'))[0].passed).toBe(true);
    expect((await run('jt.expect({ status: 200 }).toHaveProperty("status", 404)'))[0].passed).toBe(false);
  });

  it('negates any matcher via .not', async () => {
    const { results } = await runScript('jt.test("t", () => jt.expect(200).not.toBe(404));', {
      request: baseRequest,
      variables: {},
    });
    expect(results[0].passed).toBe(true);
  });
});

describe('response helper', () => {
  it('exposes response.json() for parsing the body', async () => {
    const { results } = await runScript(
      'jt.test("has name", () => jt.expect(jt.response.json().name).toBe("jtaak"));',
      { request: baseRequest, response: baseResponse, variables: {} },
    );
    expect(results[0].passed).toBe(true);
  });

  it('exposes response status/headers directly', async () => {
    const { results } = await runScript('jt.test("status ok", () => jt.expect(jt.response.status).toBe(200));', {
      request: baseRequest,
      response: baseResponse,
      variables: {},
    });
    expect(results[0].passed).toBe(true);
  });
});

describe('performance budget: per-script sandbox overhead', () => {
  it('achieves under 10ms per script execution', async () => {
    const iterations = 20;
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await runScript('jt.test("status is 200", () => jt.expect(jt.response.status).toBe(200));', {
        request: baseRequest,
        response: baseResponse,
        variables: {},
      });
      samples.push(performance.now() - start);
    }
    expect(Math.min(...samples)).toBeLessThan(10);
  });
});

describe('isolation and limits', () => {
  const limits = { timeoutMs: 100, memoryBytes: 16 * 1024 * 1024 };

  it('gives scripts no access to Node or host globals', async () => {
    const { logs } = await runScript(
      'console.log(typeof require, typeof process, typeof module, typeof globalThis.fetch, typeof setTimeout);',
      { request: baseRequest, variables: {} },
    );
    expect(logs).toEqual([{ level: 'log', message: 'undefined undefined undefined undefined undefined' }]);
  });

  it('stops a script that runs past its deadline', async () => {
    await expect(runScript('while (true) {}', { request: baseRequest, variables: {} }, limits)).rejects.toThrow(
      'Script timed out after 100 ms',
    );
  });

  it('applies the deadline to promise callbacks too', async () => {
    await expect(
      runScript('Promise.resolve().then(() => { while (true) {} });', { request: baseRequest, variables: {} }, limits),
    ).rejects.toThrow(/timed out/);
  });

  it('stops a script that exceeds its memory limit', async () => {
    // One allocation over the 16 MB cap fails at once. (Approaching the cap in
    // steps makes QuickJS collect garbage over and over, which the hard stop
    // below covers.)
    await expect(
      runScript(
        'new Uint8Array(32 * 1024 * 1024);',
        { request: baseRequest, variables: {} },
        { ...limits, timeoutMs: 1000 },
      ),
    ).rejects.toThrow(/out of memory/i);
  });

  // Built by one fast native call, then a default sort of about 2 s: a single
  // built-in call, which QuickJS's interrupt can't stop. (Unstopped, the
  // garbage collection case below takes about 3 s.) The 1 s ceilings leave room
  // for a busy machine.
  const longBuiltIn = 'new Array(6e6).fill(0.5).sort();';
  const longLimits = { timeoutMs: 100, memoryBytes: 256 * 1024 * 1024 };

  it('stops a long built-in call shortly after the deadline', async () => {
    const start = performance.now();
    await expect(runScript(longBuiltIn, { request: baseRequest, variables: {} }, longLimits)).rejects.toThrow(
      'Script timed out after 100 ms',
    );
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('stops garbage collection near the memory cap shortly after the deadline', async () => {
    const start = performance.now();
    await expect(
      runScript(
        'const a = []; while (true) a.push(new Array(1000000).fill(1));',
        { request: baseRequest, variables: {} },
        limits,
      ),
    ).rejects.toThrow('Script timed out after 100 ms');
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('runs scripts normally after a stopped one, including ones already waiting', async () => {
    const script = 'jt.test("t", () => jt.expect(1).toBe(1));';
    const [before, stopped, after] = await Promise.allSettled([
      runScript(script, { request: baseRequest, variables: {} }),
      runScript(longBuiltIn, { request: baseRequest, variables: {} }, longLimits),
      runScript(script, { request: baseRequest, variables: {} }),
    ]);
    expect(before).toMatchObject({ status: 'fulfilled', value: { results: [{ name: 't', passed: true }] } });
    expect(stopped).toMatchObject({ status: 'rejected', reason: { message: 'Script timed out after 100 ms' } });
    expect(after).toMatchObject({ status: 'fulfilled', value: { results: [{ name: 't', passed: true }] } });
  });

  it('reports a script error with its message', async () => {
    await expect(runScript('notDefined.x = 1;', { request: baseRequest, variables: {} })).rejects.toThrow(/notDefined/);
  });

  it('writes variable changes back to the caller, including deletions', async () => {
    const variables: Record<string, string> = { keep: '1', remove: '2' };
    await runScript('jt.variables.token = "abc"; delete jt.variables.remove;', { request: baseRequest, variables });
    expect(variables).toEqual({ keep: '1', token: 'abc' });
  });

  it('keeps jt.environment as another name for jt.variables when no environment is given', async () => {
    const variables: Record<string, string> = {};
    await runScript('jt.environment.token = "abc";', { request: baseRequest, variables });
    expect(variables).toEqual({ token: 'abc' });
  });

  it('writes environment changes back separately, and into the variables too', async () => {
    const variables: Record<string, string> = { base: '1' };
    const environment: Record<string, string> = { base: '1', old: 'x' };
    await runScript(
      'jt.environment.token = "abc"; jt.environment.count = 2; delete jt.environment.old; jt.variables.local = "y";',
      { request: baseRequest, variables, environment },
    );
    // Values become strings, as the environment holds them.
    expect(environment).toEqual({ base: '1', token: 'abc', count: '2' });
    // The request sees the environment's new values at once; local ones stay local.
    expect(variables).toEqual({ base: '1', token: 'abc', count: '2', local: 'y' });
  });

  it('gives scripts a read-only copy of the request', async () => {
    const request = { ...baseRequest };
    await runScript('jt.request.url = "https://evil.example";', { request, variables: {} });
    expect(request.url).toBe('https://example.com');
  });

  it('runs promise callbacks the script queued', async () => {
    const { logs } = await runScript('Promise.resolve(7).then((v) => console.log("got", v));', {
      request: baseRequest,
      variables: {},
    });
    expect(logs).toEqual([{ level: 'log', message: 'got 7' }]);
  });
});
