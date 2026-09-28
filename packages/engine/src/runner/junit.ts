import type { CollectionRunReport } from '../types.js';

export interface JunitOptions {
  /** The run's name, on `<testsuites>`. */
  name: string;
  /** Each request's collection and folders, by request id, for the suite names; without it a suite is named after its request. */
  paths?: Record<string, string[]>;
  /** When the run started; default now. */
  timestamp?: Date;
}

const escapeXml = (text: string) =>
  text
    // Characters XML 1.0 doesn't allow at all.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const seconds = (ms: number) => (ms / 1000).toFixed(3);

/**
 * A collection run's report as JUnit XML, the format CI systems read: a
 * `<testsuite>` per request (named by its folder path), with a `<testcase>`
 * per test. A request that couldn't be sent, or whose script failed, is an
 * `<error>`; a failed test a `<failure>`. A request with no tests is one
 * passing test case, so it still shows in the report.
 */
export function junitReport(report: CollectionRunReport, options: JunitOptions): string {
  const timestamp = (options.timestamp ?? new Date()).toISOString().replace(/\.\d{3}Z$/, '');
  let tests = 0;
  let failures = 0;
  let errors = 0;
  const suites = report.items.map(({ requestId, requestName, result }) => {
    const path = options.paths?.[requestId] ?? [];
    const suite = [...path, requestName].join(' / ');
    const classname = escapeXml([...path, requestName].join('.'));
    const time = seconds(result.response?.timings.durationMs ?? 0);
    const cases: string[] = [];
    const problem = result.preRequestError ? `pre-request script error: ${result.preRequestError}` : result.sendError;
    if (problem) {
      cases.push(
        `    <testcase classname="${classname}" name="${escapeXml(requestName)}" time="${time}">\n` +
          `      <error message="${escapeXml(problem)}" type="RequestError">${escapeXml(problem)}</error>\n` +
          `    </testcase>`,
      );
    }
    for (const assertion of result.testResults) {
      const failure = assertion.passed
        ? ''
        : `\n      <failure message="${escapeXml(assertion.error ?? 'failed')}" type="AssertionFailure">${escapeXml(assertion.error ?? 'failed')}</failure>\n    `;
      cases.push(
        `    <testcase classname="${classname}" name="${escapeXml(assertion.name)}" time="0.000">${failure}</testcase>`,
      );
    }
    if (cases.length === 0) {
      const status = result.response ? `${result.response.status} ${result.response.statusText}`.trim() : '';
      cases.push(
        `    <testcase classname="${classname}" name="${escapeXml(status ? `${requestName} (${status})` : requestName)}" time="${time}"/>`,
      );
    }
    const suiteFailures = result.testResults.filter((a) => !a.passed).length;
    const suiteErrors = problem ? 1 : 0;
    tests += cases.length;
    failures += suiteFailures;
    errors += suiteErrors;
    return (
      `  <testsuite name="${escapeXml(suite)}" tests="${cases.length}" failures="${suiteFailures}" errors="${suiteErrors}" time="${time}" timestamp="${timestamp}">\n` +
      `${cases.join('\n')}\n` +
      `  </testsuite>`
    );
  });
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="${escapeXml(options.name)}" tests="${tests}" failures="${failures}" errors="${errors}" time="${seconds(report.durationMs)}">\n` +
    (suites.length > 0 ? `${suites.join('\n')}\n` : '') +
    `</testsuites>\n`
  );
}
