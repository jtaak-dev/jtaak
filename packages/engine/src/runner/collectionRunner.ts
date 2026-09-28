import { runRequestWithScripts } from '../scripting/runRequest.js';
import { applyEnvironmentUpdates, diffEnvironment } from '../variables/environmentUpdates.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { CollectionRunItemResult, CollectionRunReport, RequestConfig, VariableScope } from '../types.js';
import type { RunRequestOptions } from '../scripting/runRequest.js';
import { MemoryOAuth2TokenStore } from '../request/oauth2.js';

export interface RunCollectionOptions extends RunRequestOptions {
  /** Stop after the first request that fails to send or fails a test. */
  stopOnFailure?: boolean;
}

export interface RunnableRequest {
  id: string;
  name: string;
  config: RequestConfig;
}

/**
 * Runs a list of requests sequentially — same order a user would click
 * through them — and produces an aggregate pass/fail report.
 *
 * This deliberately does NOT offload to worker threads. Each request/script
 * step runs in a Node process that a host application can keep separate
 * from its UI process, so a UI thread is never blocked by this loop. The
 * synchronous part of each step, running a script in the QuickJS sandbox,
 * is asserted to stay under the <10ms-per-script budget
 * and is hard-capped by the sandbox's 1 s deadline, and `fetch()` between
 * scripts already yields the event loop. A worker pool
 * was evaluated for stricter isolation but rejected for now: it
 * either pays worker-spawn cost per script (busting the <10ms budget) or
 * requires resolving a compiled sandbox module path that doesn't exist when
 * tests run against source directly — real complexity for a benefit this
 * process model already provides. `onProgress` lets a caller (such as a
 * host application) stream live per-request updates instead, which is what actually
 * keeps a long run feeling responsive.
 *
 * What a request's scripts set in the environment reaches the requests after
 * it (a login request's token, say), and the run's net changes come back as
 * the report's `environmentUpdates`; saving them is the caller's choice.
 * With `options.cookieJar`, cookies a request's response sets are sent by
 * the requests after it (a login's session cookie, say).
 */
export async function runCollection(
  requests: RunnableRequest[],
  scopes: VariableScope,
  onProgress?: (item: CollectionRunItemResult, index: number, total: number) => void,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
  options: RunCollectionOptions = {},
): Promise<CollectionRunReport> {
  const start = performance.now();
  const items: CollectionRunItemResult[] = [];
  let passedAssertions = 0;
  let failedAssertions = 0;
  let requestsFailedToSend = 0;
  let environment = scopes.environment;
  // Without a token store, the run keeps one of its own, so its requests share a token.
  const { stopOnFailure, ...requestOptions } = options;
  const runOptions: RunRequestOptions = {
    ...requestOptions,
    oauth2Tokens: requestOptions.oauth2Tokens ?? new MemoryOAuth2TokenStore(),
  };
  let stoppedEarly = false;

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const result = await runRequestWithScripts(request.config, { ...scopes, environment }, profile, runOptions);
    if (result.environmentUpdates) environment = applyEnvironmentUpdates(environment, result.environmentUpdates);

    if (result.preRequestError || result.sendError) requestsFailedToSend++;
    for (const assertion of result.testResults) {
      if (assertion.passed) passedAssertions++;
      else failedAssertions++;
    }

    const item: CollectionRunItemResult = { requestId: request.id, requestName: request.name, result };
    items.push(item);
    onProgress?.(item, i, requests.length);
    const failed =
      !!result.preRequestError || !!result.sendError || result.testResults.some((assertion) => !assertion.passed);
    if (stopOnFailure && failed && i < requests.length - 1) {
      stoppedEarly = true;
      break;
    }
  }

  const environmentUpdates = diffEnvironment(scopes.environment, environment);
  return {
    total: requests.length,
    items,
    passedAssertions,
    failedAssertions,
    requestsFailedToSend,
    durationMs: performance.now() - start,
    ...(Object.keys(environmentUpdates).length > 0 && { environmentUpdates }),
    ...(stoppedEarly && { stoppedEarly }),
  };
}
