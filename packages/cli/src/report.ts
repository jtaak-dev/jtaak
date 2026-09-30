// What `jt run` prints as it goes: each request as it finishes, under its
// folder, with its tests and script output, then a summary.
import type { CollectionRunItemResult, CollectionRunReport, ExportedRequest } from '@jtaak/engine';

interface Output {
  write(text: string): unknown;
  isTTY?: boolean;
}

/** Colours only in a terminal, and never with NO_COLOR set (no-color.org). */
function palette(out: Output) {
  const on = !!out.isTTY && !process.env.NO_COLOR;
  const paint = (code: string) => (text: string) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { green: paint('32'), red: paint('31'), dim: paint('2'), bold: paint('1'), yellow: paint('33') };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function createReporter(out: Output, command = 'jt') {
  const c = palette(out);
  const line = (text = '') => out.write(`${text}\n`);
  let lastPath = '';

  return {
    start(run: { file: string; folder?: string; environment?: string; count: number; skipped: ExportedRequest[] }) {
      const what = [run.folder ? `"${run.folder}" in ${run.file}` : run.file];
      if (run.environment) what.push(`environment "${run.environment}"`);
      line(c.bold(`${command} run ${what.join(', ')}: ${plural(run.count, 'request')}`));
      if (run.skipped.length > 0) {
        const names = run.skipped.map((r) => `${r.name} (${(r.config.protocol ?? 'http').toUpperCase()})`);
        line(
          c.yellow(`Skipping ${plural(run.skipped.length, 'request')} ${command} run can't send: ${names.join(', ')}`),
        );
      }
    },

    item({ result }: CollectionRunItemResult, request: ExportedRequest) {
      const path = request.path.join(' / ');
      if (path !== lastPath) {
        line();
        line(c.bold(path));
        lastPath = path;
      }
      const problem = result.preRequestError ? `pre-request script error: ${result.preRequestError}` : result.sendError;
      const failed = !!problem || result.testResults.some((assertion) => !assertion.passed);
      const mark = failed ? c.red('✗') : c.green('✓');
      const target = `${request.config.method} ${request.config.url}`;
      if (result.response && !result.sendError) {
        const { status, statusText, timings } = result.response;
        const time = `${timings.durationMs.toFixed(0)} ms`;
        line(`  ${mark} ${request.name} ${c.dim(`${target} → ${status} ${statusText}, ${time}`)}`);
      } else {
        line(`  ${mark} ${request.name} ${c.dim(target)}`);
      }
      if (problem) line(`      ${c.red(problem)}`);
      for (const assertion of result.testResults) {
        line(
          assertion.passed
            ? `      ${c.green('✓')} ${assertion.name}`
            : `      ${c.red('✗')} ${assertion.name}: ${c.red(assertion.error ?? 'failed')}`,
        );
      }
      for (const log of result.scriptLogs) line(c.dim(`      │ ${log.message}`));
    },

    finish(report: CollectionRunReport) {
      const sent = report.items.length - report.requestsFailedToSend;
      const tests = report.passedAssertions + report.failedAssertions;
      const parts = [
        report.requestsFailedToSend > 0
          ? c.red(`${plural(report.items.length, 'request')} (${report.requestsFailedToSend} failed to send)`)
          : `${plural(sent, 'request')}`,
        report.failedAssertions > 0
          ? c.red(`${plural(tests, 'test')} (${report.failedAssertions} failed)`)
          : `${plural(tests, 'test')}${tests > 0 ? ' passed' : ''}`,
        `${(report.durationMs / 1000).toFixed(1)} s`,
      ];
      line();
      if (report.stoppedEarly) {
        line(
          c.yellow(
            `Stopped after the first failure (--bail): ${plural(report.total - report.items.length, 'request')} not run.`,
          ),
        );
      }
      line(parts.join(', '));
    },
  };
}
