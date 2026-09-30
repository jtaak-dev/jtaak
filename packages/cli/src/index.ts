#!/usr/bin/env node
// The `jt` command: runCli (cli.ts) with the default command name and profile.
import { runCli } from './cli.js';

void runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
