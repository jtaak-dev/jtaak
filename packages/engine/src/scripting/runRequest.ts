import { executeRequest } from '../request/executor.js';
import { resolveDeep } from '../variables/resolver.js';
import { diffEnvironment } from '../variables/environmentUpdates.js';
import { runScript, type ScriptConsoleEntry } from './sandbox.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { RequestConfig, RequestRunResult, ScriptLogEntry, VariableScope } from '../types.js';

function tagPhase(entries: ScriptConsoleEntry[], phase: ScriptLogEntry['phase']): ScriptLogEntry[] {
  return entries.map((entry) => ({ ...entry, phase }));
}

/**
 * Runs a request through the full engine pipeline: pre-request script (which
 * may set variables consumed by this same request) → variable resolution →
 * send → test script against the response. This is the entry point both a
 * single "Send" action and the collection runner use, so the two never
 * drift in what "running a request" actually means.
 *
 * Scripts see two sets of values. `<namespace>.variables` starts as the
 * environment's values, and what scripts set there lasts only for this
 * request. `<namespace>.environment` is the environment itself: what scripts
 * set there is used by this request too, and comes back as
 * `environmentUpdates` for the caller to keep (say, a token a login
 * request's test script read from the response).
 */
export async function runRequestWithScripts(
  config: RequestConfig,
  scopes: VariableScope,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): Promise<RequestRunResult> {
  // A mutable working copy: a pre-request script can set a variable (e.g. a
  // timestamp or a token) that this same request's URL/headers/body then
  // resolve against, before anything is sent over the network.
  const variables = { ...scopes.environment };
  const environment = { ...scopes.environment };
  const scriptLogs: ScriptLogEntry[] = [];
  // Only when something changed, so results without scripts look as before.
  const withUpdates = (result: RequestRunResult): RequestRunResult => {
    const updates = diffEnvironment(scopes.environment, environment);
    return Object.keys(updates).length > 0 ? { ...result, environmentUpdates: updates } : result;
  };

  if (config.preRequestScript) {
    try {
      const preRequestRun = await runScript(
        config.preRequestScript,
        { request: config, variables, environment },
        undefined,
        profile,
      );
      scriptLogs.push(...tagPhase(preRequestRun.logs, 'pre-request'));
    } catch (error) {
      return { testResults: [], scriptLogs, preRequestError: (error as Error).message };
    }
  }

  const resolvedConfig = resolveDeep(config, { ...scopes, environment: variables });

  let response;
  try {
    response = await executeRequest(resolvedConfig);
  } catch (error) {
    return withUpdates({ testResults: [], scriptLogs, sendError: (error as Error).message });
  }

  let testResults: RequestRunResult['testResults'] = [];
  if (config.testScript) {
    try {
      const testRun = await runScript(
        config.testScript,
        { request: resolvedConfig, response, variables, environment },
        undefined,
        profile,
      );
      testResults = testRun.results;
      scriptLogs.push(...tagPhase(testRun.logs, 'test'));
    } catch (error) {
      return withUpdates({
        response,
        testResults: [],
        scriptLogs,
        sendError: `test script error: ${(error as Error).message}`,
      });
    }
  }

  return withUpdates({ response, testResults, scriptLogs });
}
