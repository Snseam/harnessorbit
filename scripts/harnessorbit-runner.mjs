#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HARNESSORBIT_RUNNER_VERSION, parseTaskPrompt, runHarnessOrbit } from '../src/harnessorbit-runner.mjs';

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--version')) {
    process.stdout.write(`harnessorbit-runner ${HARNESSORBIT_RUNNER_VERSION}\n`);
    return { version: HARNESSORBIT_RUNNER_VERSION };
  }
  const result = await runHarnessOrbit({ cwd: process.cwd(), prompt: parseTaskPrompt(argv) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.outcome === 'timeout') process.exitCode = 124;
  else if (result.outcome === 'failed') process.exitCode = result.exitCode || 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error?.message || 'harnessorbit_runner_failed'}\n`);
    process.exitCode = 2;
  });
}
