import { runScript, type ScriptStreamMessage } from './sandbox.js';
import { DEFAULT_ENGINE_PROFILE, type EngineProfile } from '../types.js';
import type { AssertionResult, RequestConfig, ScriptLogEntry } from '../types.js';

/** At most this many messages go to a script, the newest: a long-running connection shouldn't run it out of memory. */
export const CONNECTION_TEST_MESSAGE_LIMIT = 1000;
/** Each message's data is cut to this many characters. */
export const CONNECTION_TEST_DATA_LIMIT = 64 * 1024;

export interface ConnectionTestInput {
  /** The connection as it was opened (its URL, headers…), read as `<namespace>.request`. */
  request: RequestConfig;
  /** What it sent and received so far, oldest first. */
  messages: ScriptStreamMessage[];
  /** The active environment's values, read as `<namespace>.variables`; changes aren't kept. */
  variables?: Record<string, string>;
}

export interface ConnectionTestResult {
  testResults: AssertionResult[];
  scriptLogs: ScriptLogEntry[];
  /** The script threw, or ran out of time or memory. */
  error?: string;
}

/**
 * Runs a WebSocket, SSE or messaging connection's test script over the
 * messages it has seen, in the sandbox, as a request's test script runs over
 * its response. The script reads `<namespace>.messages` (each with
 * `direction`, `channel`, `data`, `at` in milliseconds since the connection
 * opened, and `json()`), and checks it with `<namespace>.test` and
 * `<namespace>.expect`:
 *
 *     jt.test('an order is paid within 5 s', () => {
 *       const paid = jt.messages.find((m) => m.channel === 'orders' && m.json().status === 'paid');
 *       jt.expect(paid).toBeDefined();
 *       jt.expect(paid.at).toBeLessThan(5000);
 *     });
 *
 * A host runs it again as messages arrive, so the results say how the
 * connection is doing so far.
 */
export async function runConnectionTests(
  script: string,
  input: ConnectionTestInput,
  profile: EngineProfile = DEFAULT_ENGINE_PROFILE,
): Promise<ConnectionTestResult> {
  const messages = input.messages
    .slice(-CONNECTION_TEST_MESSAGE_LIMIT)
    .map((message) =>
      message.data.length > CONNECTION_TEST_DATA_LIMIT
        ? { ...message, data: message.data.slice(0, CONNECTION_TEST_DATA_LIMIT) }
        : message,
    );
  try {
    const run = await runScript(
      script,
      { request: input.request, variables: { ...input.variables }, messages },
      undefined,
      profile,
    );
    return { testResults: run.results, scriptLogs: run.logs.map((entry) => ({ ...entry, phase: 'test' })) };
  } catch (error) {
    return { testResults: [], scriptLogs: [], error: (error as Error).message };
  }
}
