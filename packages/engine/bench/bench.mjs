// Engine benchmarks: what jtaak costs on top of the network, and how it
// scales to a big workspace. Runs against the built package (dist/), as
// users get it: `pnpm bench` (after `pnpm build:engine`). Prints a
// Markdown table; `--json <file>` also writes the numbers, and in GitHub
// Actions the table goes to the job summary.
//
// Everything talks to a server on this machine, so the network is as fast
// as it gets and what's measured is the engine.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createCollectionNode,
  createRequest,
  emptyScopes,
  executeRequest,
  exportNative,
  getCollectionTree,
  getOrCreateDefaultWorkspace,
  openDatabase,
  resolveDeep,
  runCollection,
  runRequestWithScripts,
  runScript,
} from '../dist/index.js';

const quick = process.argv.includes('--quick');
const jsonAt = process.argv.indexOf('--json');
const jsonFile = jsonAt === -1 ? undefined : process.argv[jsonAt + 1];
const scale = quick ? 0.1 : 1;
const n = (count) => Math.max(10, Math.round(count * scale));

const percentile = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const ms = (value) => (value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2));

async function time(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

async function samples(count, fn) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(await time(fn));
  return out;
}

// A keep-alive server answering every request at once with a small JSON body.
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"items":[1,2,3]}');
  });
});
server.keepAliveTimeout = 60_000;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/items`;

const request = (overrides = {}) => ({
  id: 'bench',
  name: 'bench',
  method: 'GET',
  url,
  params: [],
  headers: [],
  body: { mode: 'none' },
  auth: { type: 'none' },
  ...overrides,
});

const TEST_SCRIPT = `
jt.test('status is 200', () => jt.expect(jt.response.status).toBe(200));
jt.test('has items', () => jt.expect(jt.response.json().items.length).toBe(3));
`;

const results = [];
const record = (name, value, unit, budget, note) => {
  results.push({ name, value, unit, budget, note });
  console.error(`  ${name}: ${ms(value)} ${unit}`);
};

console.error('Warming up…');
for (let i = 0; i < 200; i++) {
  await (await fetch(url)).text();
  await executeRequest(request());
}
await runScript(TEST_SCRIPT, { request: request(), variables: {} });

console.error('Requests…');
// Alternate the two, so both see the same machine and connection state.
const bare = [];
const engine = [];
for (let round = 0; round < n(2000); round++) {
  bare.push(await time(async () => (await fetch(url)).text()));
  engine.push(await time(() => executeRequest(request())));
}
record('A request, bare fetch (p50)', percentile(bare, 50), 'ms', undefined, 'the baseline');
record('A request through executeRequest (p50)', percentile(engine, 50), 'ms');
// Each request against the bare fetch just before it.
const overhead = engine.map((value, i) => value - bare[i]);
record(
  'Engine overhead per request (p50)',
  percentile(overhead, 50),
  'ms',
  5,
  'executeRequest minus the fetch before it',
);
record('Engine overhead per request (p95)', percentile(overhead, 95), 'ms', 5);

const withScripts = await samples(n(500), () =>
  runRequestWithScripts(
    request({ preRequestScript: 'jt.variables.id = String(Date.now());', testScript: TEST_SCRIPT }),
    emptyScopes(),
  ),
);
record('A request with a pre-request and a test script (p50)', percentile(withScripts, 50), 'ms');

const scripts = await samples(n(500), () => runScript(TEST_SCRIPT, { request: request(), variables: {} }));
record('One script in the sandbox (p50)', percentile(scripts, 50), 'ms', 10);

console.error('Variables…');
const variables = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`var${i}`, `value-${i}`]));
const templated = request({
  url: `${url}?${Array.from({ length: 50 }, (_, i) => `k${i}={{var${i}}}`).join('&')}`,
  headers: Array.from({ length: 20 }, (_, i) => ({ key: `X-${i}`, value: `{{var${i}}}`, enabled: true })),
});
const resolving = await samples(n(2000), () => resolveDeep(templated, { ...emptyScopes(), environment: variables }));
record('Resolving 70 {{variables}} in a request (p50)', percentile(resolving, 50), 'ms', 1);

console.error('Collection runs…');
const many = Array.from({ length: n(10_000) }, (_, i) => ({ id: String(i), name: `r${i}`, config: request() }));
const runPlain = await time(() => runCollection(many, emptyScopes()));
record(
  `Collection run, ${many.length.toLocaleString('en')} requests, no scripts`,
  runPlain,
  'ms',
  undefined,
  `${Math.round(many.length / (runPlain / 1000))} requests/s`,
);
const tested = many.slice(0, n(1000)).map((r) => ({ ...r, config: request({ testScript: TEST_SCRIPT }) }));
const runTested = await time(() => runCollection(tested, emptyScopes()));
record(
  `Collection run, ${tested.length.toLocaleString('en')} requests with tests`,
  runTested,
  'ms',
  undefined,
  `${Math.round(tested.length / (runTested / 1000))} requests/s`,
);

console.error('Storage…');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-bench-'));
const db = openDatabase(path.join(dir, 'bench.db'));
const { workspace } = getOrCreateDefaultWorkspace(db);
const root = getCollectionTree(db, workspace.id)[0].id;
const total = n(10_000);
const create = await time(() => {
  db.transaction(() => {
    for (let f = 0; f < 100; f++) {
      const folder = createCollectionNode(db, {
        workspaceId: workspace.id,
        parentFolderId: root,
        name: `Folder ${f}`,
        kind: 'folder',
      });
      for (let r = 0; r < total / 100; r++) {
        createRequest(db, {
          collectionId: folder.id,
          name: `Request ${f}-${r}`,
          config: request({ testScript: TEST_SCRIPT }),
        });
      }
    }
  })();
});
record(`Saving ${total.toLocaleString('en')} requests in 100 folders`, create, 'ms');
const loads = await samples(5, () => getCollectionTree(db, workspace.id));
record(`Loading a ${total.toLocaleString('en')}-request tree (p50 of 5)`, percentile(loads, 50), 'ms', 1000);
const exporting = await time(() =>
  JSON.stringify(exportNative(db, workspace.id, { scope: 'workspace' }, { includeSecrets: false, environmentIds: [] })),
);
record(`Exporting the ${total.toLocaleString('en')}-request workspace`, exporting, 'ms');
db.close();
fs.rmSync(dir, { recursive: true, force: true });
server.close();

// ---- Report -----------------------------------------------------------------
const cpu = os.cpus()[0]?.model.trim() ?? 'unknown CPU';
const machine = `Node ${process.version}, ${os.type()} ${os.release()} (${os.arch()}), ${cpu}, ${os.cpus().length} threads`;
const verdict = (r) =>
  r.budget === undefined ? '' : r.value <= r.budget ? `≤ ${r.budget} ms ✓` : `≤ ${r.budget} ms ✗`;
const table = [
  `Engine benchmarks${quick ? ' (quick run: a tenth of the counts)' : ''}: ${machine}.`,
  '',
  '| Benchmark | Result | Budget | Note |',
  '| --- | ---: | --- | --- |',
  ...results.map((r) => `| ${r.name} | ${ms(r.value)} ${r.unit} | ${verdict(r)} | ${r.note ?? ''} |`),
  '',
].join('\n');
console.log(table);
if (jsonFile) fs.writeFileSync(jsonFile, JSON.stringify({ machine, quick, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);
