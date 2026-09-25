#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInternalBenchmarkPlan, runInternalBenchmark } from '../src/internal-benchmark.mjs';

function outputPath(argv) {
  const index = argv.indexOf('--output');
  return index >= 0 ? argv[index + 1] : null;
}

export async function main(argv = process.argv.slice(2)) {
  const output = outputPath(argv);
  if (output && (!output.endsWith('.json') || output === '--output')) throw new Error('--output must be a JSON file path.');
  const report = runInternalBenchmark({ plan: createInternalBenchmarkPlan() });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (output) {
    const file = path.resolve(output);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { mode: 0o600 });
  } else {
    process.stdout.write(text);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
