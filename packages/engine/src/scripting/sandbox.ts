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
import type { AssertionResult, ExecutedResponse, RequestConfig } from '../types.js';

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
  };

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
