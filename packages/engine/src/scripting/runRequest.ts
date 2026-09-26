import { executeRequest } from '../request/executor.js';
import { resolveDeep } from '../variables/resolver.js';
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
  const scriptLogs: ScriptLogEntry[] = [];

  if (config.preRequestScript) {
    try {
      const preRequestRun = await runScript(
        config.preRequestScript,
        { request: config, variables },
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
    return { testResults: [], scriptLogs, sendError: (error as Error).message };
  }

  let testResults: RequestRunResult['testResults'] = [];
  if (config.testScript) {
    try {
      const testRun = await runScript(
        config.testScript,
        { request: resolvedConfig, response, variables },
        undefined,
        profile,
      );
      testResults = testRun.results;
      scriptLogs.push(...tagPhase(testRun.logs, 'test'));
    } catch (error) {
      return { response, testResults: [], scriptLogs, sendError: `test script error: ${(error as Error).message}` };
    }
  }

  return { response, testResults, scriptLogs };
}
