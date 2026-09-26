// Installs the packed engine and CLI with npm into an empty folder, the way a
// user would, then runs the installed `jt` command against a local server and
// opens a database through the installed engine. It catches what the source
// tests can't: a wrong `files` list or bin, the workspace: dependency not being
// rewritten, a native module compiling on install. Run it with
// `pnpm check:install` (it uses pnpm to pack); it needs network access to
// install the engine's own dependencies from npm.
import { exec, execFile, execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CLI_DIR = path.resolve(import.meta.dirname, '..');
// The engine this CLI depends on, through the workspace link.
const ENGINE_DIR = fs.realpathSync(path.join(CLI_DIR, 'node_modules', '@jtaak', 'engine'));
const PNPM = process.env.npm_execpath;
if (!PNPM) {
  console.error('Run this with `pnpm check:install`.');
  process.exit(1);
}
// npm and npx are .cmd files on Windows, which only run through a shell, so
// they're run as one command line with each argument quoted.
const commandLine = (command, args) => [command, ...args.map((arg) => JSON.stringify(arg))].join(' ');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jtaak-install-'));
const project = path.join(work, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ private: true }));

function pack(dir) {
  const out = execFileSync(process.execPath, [PNPM, 'pack', '--pack-destination', work], {
    cwd: dir,
    encoding: 'utf8',
  });
  const tarball = out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.endsWith('.tgz'));
  if (!tarball) throw new Error(`pnpm pack printed no tarball in ${dir}:\n${out}`);
  return path.isAbsolute(tarball) ? tarball : path.join(work, tarball);
}

function settle(resolve) {
  return (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
}

const run = (command, args, cwd) => new Promise((resolve) => execFile(command, args, { cwd }, settle(resolve)));
const runInShell = (command, args, cwd) =>
  new Promise((resolve) => exec(commandLine(command, args), { cwd }, settle(resolve)));

function fail(message) {
  console.error(`check:install failed: ${message}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ path: req.url }));
});

try {
  console.log('Packing the engine and the CLI…');
  const engineTarball = pack(ENGINE_DIR);
  const cliTarball = pack(CLI_DIR);

  console.log('Installing both tarballs with npm into an empty folder…');
  execSync(commandLine('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock', engineTarball, cliTarball]), {
    cwd: project,
    stdio: 'inherit',
  });

  // better-sqlite3 ships prebuilt binaries; a build/ folder means npm compiled it.
  if (fs.existsSync(path.join(project, 'node_modules', 'better-sqlite3', 'build'))) {
    fail('npm compiled better-sqlite3 from source instead of using its prebuilt binary.');
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hello`;

  console.log(`Running the installed CLI: jt GET ${url}`);
  const cli = await runInShell('npx', ['--no-install', 'jt', 'GET', url], project);
  const [statusLine = '', body = ''] = cli.stdout.trim().split(/\r?\n/);
  if (cli.code !== 0 || !statusLine.startsWith('200 OK') || !body.includes('"/hello"')) {
    fail(`unexpected output from jt (exit ${cli.code}):\n${cli.stdout}\n${cli.stderr}`);
  }
  console.log(`  ${statusLine}`);

  console.log('Opening a database through the installed engine…');
  const probe = await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const e = await import('@jtaak/engine'); const db = e.openDatabase(':memory:'); " +
        'console.log(e.getOrCreateDefaultWorkspace(db).workspace.name);',
    ],
    project,
  );
  if (probe.code !== 0) fail(`the installed engine could not open a database:\n${probe.stderr}`);
  console.log(`  default workspace: ${probe.stdout.trim()}`);

  console.log('\ncheck:install passed.');
} finally {
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
}
