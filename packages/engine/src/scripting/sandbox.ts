import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';
import quickJsVariant from '@jitl/quickjs-singlefile-cjs-release-sync';
import { createContext, Script, type Context } from 'node:vm';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { AssertionResult, ExecutedResponse, RequestConfig, ScriptIteration } from '../types.js';

export interface ScriptContext {
  request: RequestConfig;
  response?: ExecutedResponse;
  /** Variables the script can read and set. Changes are written back to this object after the script runs. */
  variables: Record<string, string>;
  /**
   * The environment's values, which the script reads and sets as
   * `<namespace>.environment`. Changes are written back to this object after
   * the script runs, so the caller can keep them; a value set here is also
   * set in `variables`, so the request sees it at once. Without it,
   * `<namespace>.environment` is another name for `<namespace>.variables`.
   */
  environment?: Record<string, string>;
  /** The cookie jar's cookies for the request's URL, read as `<namespace>.cookies`. */
  cookies?: ScriptCookie[];
  /** A connection's messages so far, read as `<namespace>.messages` (see runConnectionTests). */
  messages?: ScriptStreamMessage[];
  /** The run's pass, read as `<namespace>.iteration`; a single send is pass 0 of 1, with no data. */
  iteration?: ScriptIteration;
}

/** A message a connection sent or received, as a connection's test script reads it. */
export interface ScriptStreamMessage {
  direction: 'sent' | 'received';
  /** Where it came from or went: a messaging topic, queue or event name, or an SSE event's type. */
  channel?: string;
  data: string;
  /** Milliseconds since the connection opened. */
  at: number;
  /** A messaging message's key, headers and protocol details, when it has them. */
  key?: string;
  headers?: Record<string, string>;
}

/** A cookie as scripts read it. */
export interface ScriptCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** ISO 8601; absent for a cookie with no expiry. */
  expires?: string;
  secure: boolean;
  httpOnly: boolean;
}

export interface ScriptConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
}

export interface ScriptRunResult {
  results: AssertionResult[];
  logs: ScriptConsoleEntry[];
}

export interface ScriptLimits {
  /** Wall-clock budget for the whole script, including promise callbacks. */
  timeoutMs: number;
  memoryBytes: number;
}

export const DEFAULT_SCRIPT_LIMITS: ScriptLimits = { timeoutMs: 1000, memoryBytes: 64 * 1024 * 1024 };

// The script-side API (the profile's script namespace, `jt` by default, and
// `console`), as JavaScript source evaluated
// inside QuickJS. It lives in the sandbox rather than being exposed from the
// host, so scripts never hold a reference to a host object: data goes in and
// comes out only as JSON (`__input` / `__output()`).
const PRELUDE = String.raw`
'use strict';
(function () {
  const input = JSON.parse(globalThis.__input);
  delete globalThis.__input;
  const results = [];
  const logs = [];

  function isDeepEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => isDeepEqual(a[key], b[key]));
  }

  function describe(value) {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  function capture(level) {
    return (...args) => {
      logs.push({ level, message: args.map((v) => (typeof v === 'string' ? v : describe(v))).join(' ') });
    };
  }
  globalThis.console = { log: capture('log'), info: capture('info'), warn: capture('warn'), error: capture('error') };

  // A minimal Chai-like matcher set: enough for the common status/body/header
  // assertions a pre-request or test script needs, not a full port.
  function makeExpect(actual, negated) {
    function assert(condition, message) {
      if (condition === Boolean(negated)) {
        throw new Error(
          negated ? 'expected ' + describe(actual) + ' not to ' + message : 'expected ' + describe(actual) + ' to ' + message,
        );
      }
    }
    return {
      get not() {
        return makeExpect(actual, !negated);
      },
      toBe(expected) {
        assert(actual === expected, 'be ' + describe(expected));
      },
      toEqual(expected) {
        assert(isDeepEqual(actual, expected), 'deep-equal ' + describe(expected));
      },
      toBeDefined() {
        assert(actual !== undefined, 'be defined');
      },
      toBeUndefined() {
        assert(actual === undefined, 'be undefined');
      },
      toBeNull() {
        assert(actual === null, 'be null');
      },
      toBeTruthy() {
        assert(Boolean(actual), 'be truthy');
      },
      toBeFalsy() {
        assert(!actual, 'be falsy');
      },
      toBeGreaterThan(expected) {
        assert(typeof actual === 'number' && actual > expected, 'be greater than ' + expected);
      },
      toBeLessThan(expected) {
        assert(typeof actual === 'number' && actual < expected, 'be less than ' + expected);
      },
      toContain(expected) {
        const contains =
          (typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)) ||
          (Array.isArray(actual) && actual.some((item) => isDeepEqual(item, expected)));
        assert(contains, 'contain ' + describe(expected));
      },
      toHaveProperty(key, expected) {
        const has = typeof actual === 'object' && actual !== null && key in actual;
        if (arguments.length < 2) {
          assert(has, 'have property "' + key + '"');
          return;
        }
        assert(has && isDeepEqual(actual[key], expected), 'have property "' + key + '" equal to ' + describe(expected));
      },
    };
  }

  const variables = input.variables;
  // With separate environment values, a write to the environment is also a
  // write to this run's variables, so the request uses the new value at once.
  const environmentValues = input.environment;
  const environment = environmentValues
    ? new Proxy(environmentValues, {
        set(target, key, value) {
          const text = String(value);
          target[key] = text;
          variables[key] = text;
          return true;
        },
        deleteProperty(target, key) {
          delete target[key];
          delete variables[key];
          return true;
        },
      })
    : variables;
  const response = input.response
    ? Object.assign({}, input.response, {
        json() {
          return JSON.parse(input.response.body);
        },
      })
    : undefined;

  const cookieList = input.cookies || [];
  const cookies = {
    get(name) {
      const found = cookieList.find((cookie) => cookie.name === name);
      return found ? found.value : undefined;
    },
    has(name) {
      return cookieList.some((cookie) => cookie.name === name);
    },
    toObject() {
      const all = {};
      for (const cookie of cookieList) if (!(cookie.name in all)) all[cookie.name] = cookie.value;
      return all;
    },
    all() {
      return cookieList.map((cookie) => Object.assign({}, cookie));
    },
  };

  const messages = (input.messages || []).map((message) =>
    Object.assign({}, message, {
      json() {
        return JSON.parse(message.data);
      },
    }),
  );

  globalThis[input.namespace] = {
    test(name, fn) {
      try {
        fn();
        results.push({ name, passed: true });
      } catch (error) {
        results.push({ name, passed: false, error: error && error.message });
      }
    },
    expect(actual) {
      return makeExpect(actual, false);
    },
    environment,
    variables,
    request: input.request,
    response,
    cookies,
    messages,
    iteration: input.iteration,
  };


  // Postman's script API (pm.*), so scripts imported from Postman run as
  // written: the common calls, over the same values as the namespace above.
  // Anything else throws, saying it isn't supported. See scripting/postman.ts
  // for the list, which the Postman importer warns with.
  function typeName(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }
  function chai(actual, negated) {
    const self = {};
    function check(condition, message) {
      if (condition === Boolean(negated)) {
        throw new Error('expected ' + describe(actual) + (negated ? ' not to ' : ' to ') + message);
      }
      return self;
    }
    const chains = ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'deep', 'all', 'any', 'own'];
    for (const word of chains) Object.defineProperty(self, word, { get: () => self });
    Object.defineProperty(self, 'not', { get: () => chai(actual, !negated) });
    const flag = (name, test, message) => Object.defineProperty(self, name, { get: () => check(test(), message) });
    flag('true', () => actual === true, 'be true');
    flag('false', () => actual === false, 'be false');
    flag('null', () => actual === null, 'be null');
    flag('undefined', () => actual === undefined, 'be undefined');
    flag('ok', () => Boolean(actual), 'be truthy');
    flag('exist', () => actual !== null && actual !== undefined, 'exist');
    flag('empty', () => (typeof actual === 'string' || Array.isArray(actual) ? actual.length === 0 : actual && typeof actual === 'object' ? Object.keys(actual).length === 0 : false), 'be empty');
    self.equal = self.equals = self.eq = (expected) => check(actual === expected, 'equal ' + describe(expected));
    self.eql = self.eqls = (expected) => check(isDeepEqual(actual, expected), 'deeply equal ' + describe(expected));
    self.above = self.gt = self.greaterThan = (n) => check(actual > n, 'be above ' + n);
    self.below = self.lt = self.lessThan = (n) => check(actual < n, 'be below ' + n);
    self.least = self.gte = (n) => check(actual >= n, 'be at least ' + n);
    self.most = self.lte = (n) => check(actual <= n, 'be at most ' + n);
    self.within = (low, high) => check(actual >= low && actual <= high, 'be within ' + low + '..' + high);
    self.a = self.an = (type) => check(typeName(actual) === String(type).toLowerCase(), 'be a ' + type);
    self.include = self.includes = self.contain = self.contains = (value) =>
      check(
        typeof actual === 'string'
          ? actual.includes(value)
          : Array.isArray(actual)
            ? actual.some((item) => isDeepEqual(item, value))
            : actual && typeof actual === 'object' && value && typeof value === 'object'
              ? Object.keys(value).every((key) => isDeepEqual(actual[key], value[key]))
              : false,
        'include ' + describe(value),
      );
    self.property = function (key, value) {
      const has = actual !== null && actual !== undefined && typeof actual === 'object' && key in actual;
      return arguments.length < 2
        ? check(has, 'have property ' + describe(key))
        : check(has && isDeepEqual(actual[key], value), 'have property ' + describe(key) + ' of ' + describe(value));
    };
    self.lengthOf = (n) => check(actual !== null && actual !== undefined && actual.length === n, 'have length ' + n);
    self.oneOf = (list) => check(list.some((item) => isDeepEqual(item, actual)), 'be one of ' + describe(list));
    self.match = (pattern) => check(pattern.test(String(actual)), 'match ' + pattern);
    self.keys = (...keys) => {
      const wanted = keys.length === 1 && Array.isArray(keys[0]) ? keys[0] : keys;
      return check(actual !== null && typeof actual === 'object' && wanted.every((key) => key in actual), 'have keys ' + describe(wanted));
    };
    self.key = self.keys;
    return self;
  }

  function unsupported(path) {
    return () => {
      throw new Error(path + " isn't supported here.");
    };
  }
  // An object whose unknown members throw, naming them.
  function strict(object, path) {
    return new Proxy(object, {
      get(target, key) {
        if (typeof key === 'symbol' || key in target) return target[key];
        throw new Error(path + '.' + key + " isn't supported here.");
      },
    });
  }
  function valueStore(values, path, writable) {
    return strict(
      {
        get: (key) => values[key],
        has: (key) => key in values,
        set: writable ? (key, value) => { values[key] = value; } : unsupported(path + '.set'),
        unset: writable ? (key) => { delete values[key]; } : unsupported(path + '.unset'),
        toObject: () => Object.assign({}, values),
        replaceIn: (text) => String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, name) => (name in values ? values[name] : match)),
      },
      path,
    );
  }
  function headerList(headers, path) {
    const find = (name) => {
      const lower = String(name).toLowerCase();
      if (Array.isArray(headers)) {
        const found = headers.find((h) => h.enabled !== false && String(h.key).toLowerCase() === lower);
        return found ? found.value : undefined;
      }
      const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === lower);
      return key === undefined ? undefined : headers[key];
    };
    return strict({ get: find, has: (name) => find(name) !== undefined }, path);
  }

  const pmResponse = input.response
    ? (() => {
        const r = input.response;
        const status = (expected) =>
          typeof expected === 'number'
            ? chai(r.status).to.equal(expected)
            : chai(r.statusText).to.equal(expected);
        const range = (name, test, message) => [name, () => { if (!test(r.status)) throw new Error('expected status ' + r.status + ' to be ' + message); }];
        const be = {};
        for (const [name, test] of [
          range('ok', (s) => s === 200, '200 OK'),
          range('success', (s) => s >= 200 && s < 300, '2xx'),
          range('created', (s) => s === 201, '201'),
          range('accepted', (s) => s === 202, '202'),
          range('badRequest', (s) => s === 400, '400'),
          range('unauthorized', (s) => s === 401, '401'),
          range('forbidden', (s) => s === 403, '403'),
          range('notFound', (s) => s === 404, '404'),
          range('rateLimited', (s) => s === 429, '429'),
          range('error', (s) => s >= 400, '4xx or 5xx'),
          range('clientError', (s) => s >= 400 && s < 500, '4xx'),
          range('serverError', (s) => s >= 500, '5xx'),
        ]) Object.defineProperty(be, name, { get: test });
        const headers = headerList(r.headers, 'pm.response.headers');
        const have = strict(
          {
            status,
            header(name, value) {
              const actual = headers.get(name);
              if (actual === undefined) throw new Error('expected a ' + name + ' header');
              if (arguments.length > 1 && actual !== value) throw new Error('expected header ' + name + ' to be ' + describe(value) + ', got ' + describe(actual));
            },
            body(expected) {
              if (arguments.length === 0) {
                if (!r.body) throw new Error('expected a body');
              } else if (r.body !== expected) throw new Error('expected the body to be ' + describe(expected));
            },
            jsonBody(key, value) {
              const json = JSON.parse(r.body);
              if (arguments.length === 1) chai(json).to.have.property(key);
              else if (arguments.length > 1) chai(json).to.have.property(key, value);
            },
          },
          'pm.response.to.have',
        );
        return strict(
          {
            code: r.status,
            status: r.statusText,
            headers,
            responseTime: r.timings ? r.timings.durationMs : undefined,
            responseSize: r.sizeBytes,
            json: () => JSON.parse(r.body),
            text: () => r.body,
            to: strict({ have: have, be: strict(be, 'pm.response.to.be') }, 'pm.response.to'),
          },
          'pm.response',
        );
      })()
    : undefined;

  const pm = strict(
    {
      test: (name, fn) => globalThis[input.namespace].test(name, fn),
      expect: (actual) => chai(actual, false),
      environment: valueStore(environment, 'pm.environment', true),
      variables: valueStore(variables, 'pm.variables', true),
      // Collection and global variables are this run's variables here.
      collectionVariables: valueStore(variables, 'pm.collectionVariables', true),
      globals: valueStore(variables, 'pm.globals', true),
      request: input.request
        ? strict(
            {
              url: { toString: () => input.request.url },
              method: input.request.method,
              headers: headerList(input.request.headers, 'pm.request.headers'),
              name: input.request.name,
            },
            'pm.request',
          )
        : undefined,
      response: pmResponse,
      cookies: strict({ get: cookies.get, has: cookies.has, toObject: cookies.toObject }, 'pm.cookies'),
      info: strict(
        {
          requestName: input.request ? input.request.name : undefined,
          iteration: input.iteration.index,
          iterationCount: input.iteration.count,
        },
        'pm.info',
      ),
      iterationData: strict(
        {
          get: (name) => input.iteration.data[name],
          has: (name) => Object.prototype.hasOwnProperty.call(input.iteration.data, name),
          toObject: () => Object.assign({}, input.iteration.data),
        },
        'pm.iterationData',
      ),
      sendRequest: unsupported('pm.sendRequest (scripts have no network)'),
    },
    'pm',
  );
  globalThis.pm = pm;

  globalThis.__output = () => JSON.stringify({ results, logs, variables, environment: environmentValues });
})();
`;

let quickJs: Promise<QuickJSWASMModule> | undefined;
/** Modules a hard stop left in an unknown state (see withHardStop). */
const discarded = new WeakSet<QuickJSWASMModule>();

/** Loads the QuickJS WebAssembly module once (about 25 ms), on first use. */
function loadQuickJs(): Promise<QuickJSWASMModule> {
  // The variant is a CommonJS package. Node's native ESM hands over its whole
  // exports object ({ default: variant }) as the default import, while bundlers
  // (Vitest) unwrap it; wrapped in a promise, the loader accepts either shape.
  return (quickJs ??= newQuickJSWASMModuleFromVariant(Promise.resolve(quickJsVariant)));
}

/** Loads the script engine ahead of time (a host application can call
 * this at startup), so the first script someone runs doesn't wait for it. */
export async function preloadScriptEngine(): Promise<void> {
  await loadQuickJs();
}

class ScriptError extends Error {}

/** Makes `target` hold exactly `values`, in place. */
function writeBack(target: Record<string, string>, values: Record<string, string>): void {
  for (const key of Object.keys(target)) {
    if (!(key in values)) delete target[key];
  }
  Object.assign(target, values);
}

/** How long past its deadline a script may run before the hard stop. QuickJS's
 * interrupt normally stops it at the deadline; this only catches a single
 * long built-in call. */
const HARD_STOP_GRACE_MS = 50;

let hardStop: { context: Context; script: Script } | undefined;

/**
 * Runs `task`, terminating it if it takes longer than `timeoutMs`. QuickJS
 * checks its deadline only between bytecode instructions, so one long built-in
 * call (a default `sort` of a million numbers, or garbage collection near the
 * memory cap) can run for seconds past it. Node's `vm` timeout stops even that:
 * its watchdog thread terminates whatever JavaScript or WebAssembly is running.
 * Returns undefined if it did.
 */
function withHardStop<T>(task: () => T, timeoutMs: number): { value: T } | undefined {
  hardStop ??= { context: createContext({ task: undefined }), script: new Script('task()') };
  hardStop.context.task = task;
  try {
    return { value: hardStop.script.runInContext(hardStop.context, { timeout: timeoutMs }) as T };
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return undefined;
    throw error;
  } finally {
    hardStop.context.task = undefined;
  }
}

/** Unwraps a QuickJS call result, turning a script exception into a host Error. */
function unwrap(
  ctx: QuickJSContext,
  result: ReturnType<QuickJSContext['evalCode']>,
  limits: ScriptLimits,
): QuickJSHandle {
  if (!result.error) return result.value;
  const dumped = ctx.dump(result.error) as { name?: string; message?: string } | string;
  result.error.dispose();
  const message = typeof dumped === 'object' && dumped ? (dumped.message ?? String(dumped)) : String(dumped);
  if (typeof dumped === 'object' && dumped?.name === 'InternalError' && message === 'interrupted') {
    throw new ScriptError(`Script timed out after ${limits.timeoutMs} ms`);
  }
  throw new ScriptError(message);
}

/**
 * Runs a pre-request or test script in a QuickJS sandbox: a separate
 * JavaScript engine compiled to WebAssembly, with its own heap. Scripts get
 * the script API (named by the profile's `scriptNamespace`) and a capturing
 * `console`, and nothing else — no Node or
 * host objects, no timers, no network. Each script gets a fresh runtime with
 * a memory cap and a deadline that also covers promise callbacks. The
 * deadline is hard: a script still running shortly after it is terminated,
 * even inside a single long built-in call.
 *
 * Throws (with the script's error message) if the script itself throws,
 * outside a `test` callback, or runs out of time or memory.
 */
export async function runScript(
  code: string,
  context: ScriptContext,
  limits: ScriptLimits = DEFAULT_SCRIPT_LIMITS,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): Promise<ScriptRunResult> {
  // The namespace becomes a global name inside the sandbox; only a plain
  // identifier is accepted.
  if (!/^[A-Za-z_$][\w$]*$/.test(profile.scriptNamespace)) {
    throw new Error(`Invalid script namespace: ${JSON.stringify(profile.scriptNamespace)}`);
  }
  let module = await loadQuickJs();
  // Another script's hard stop may have discarded this module while we waited.
  while (discarded.has(module)) module = await loadQuickJs();

  const run = withHardStop(() => {
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(1024 * 1024);
    const deadline = Date.now() + limits.timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
    const ctx = runtime.newContext();
    try {
      const input = ctx.newString(
        JSON.stringify({
          namespace: profile.scriptNamespace,
          request: context.request,
          response: context.response,
          variables: context.variables,
          environment: context.environment,
          cookies: context.cookies,
          messages: context.messages,
          iteration: context.iteration ?? { index: 0, count: 1, data: {} },
        }),
      );
      ctx.setProp(ctx.global, '__input', input);
      input.dispose();
      unwrap(ctx, ctx.evalCode(PRELUDE, 'prelude.js'), limits).dispose();

      unwrap(ctx, ctx.evalCode(code, 'script.js'), limits).dispose();
      // Let promise callbacks the script queued run too, within the same deadline.
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        const dumped = ctx.dump(jobs.error) as { message?: string };
        jobs.error.dispose();
        throw new ScriptError(dumped?.message ?? String(dumped));
      }
      // An interrupt inside a promise callback rejects that promise rather than
      // failing the call, so check the deadline directly.
      if (Date.now() >= deadline) throw new ScriptError(`Script timed out after ${limits.timeoutMs} ms`);

      const outputHandle = unwrap(ctx, ctx.evalCode('__output()', 'output.js'), limits);
      const output = ctx.getString(outputHandle);
      outputHandle.dispose();
      return output;
    } finally {
      ctx.dispose();
      runtime.dispose();
    }
  }, limits.timeoutMs + HARD_STOP_GRACE_MS);

  if (!run) {
    // Stopped mid-call, the module's memory is in an unknown state, so it's
    // never used again: the next script loads a fresh one (a few ms).
    discarded.add(module);
    quickJs = undefined;
    throw new ScriptError(`Script timed out after ${limits.timeoutMs} ms`);
  }
  const output = JSON.parse(run.value) as ScriptRunResult & {
    variables: Record<string, string>;
    environment?: Record<string, string>;
  };

  // Write variable changes back, so a pre-request script's `jt.variables.x = …`
  // reaches this request's variable resolution (see runRequest.ts), and
  // environment changes reach the caller.
  writeBack(context.variables, output.variables);
  if (context.environment && output.environment) writeBack(context.environment, output.environment);

  return { results: output.results, logs: output.logs };
}
