import { runRequestWithScripts } from '../scripting/runRequest.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { CollectionRunItemResult, CollectionRunReport, RequestConfig, VariableScope } from '../types.js';

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
 */
export async function runCollection(
  requests: RunnableRequest[],
  scopes: VariableScope,
  onProgress?: (item: CollectionRunItemResult, index: number, total: number) => void,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): Promise<CollectionRunReport> {
  const start = performance.now();
  const items: CollectionRunItemResult[] = [];
  let passedAssertions = 0;
  let failedAssertions = 0;
  let requestsFailedToSend = 0;

  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const result = await runRequestWithScripts(request.config, scopes, profile);

    if (result.preRequestError || result.sendError) requestsFailedToSend++;
    for (const assertion of result.testResults) {
      if (assertion.passed) passedAssertions++;
      else failedAssertions++;
    }

    const item: CollectionRunItemResult = { requestId: request.id, requestName: request.name, result };
    items.push(item);
    onProgress?.(item, i, requests.length);
  }

  return {
    total: requests.length,
    items,
    passedAssertions,
    failedAssertions,
    requestsFailedToSend,
    durationMs: performance.now() - start,
  };
}
