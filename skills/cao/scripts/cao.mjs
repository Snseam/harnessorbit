#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Resolve the physical checkout even when Node preserves the installed symlink.
const script = await fs.realpath(fileURLToPath(import.meta.url));
const skillPath = path.resolve(path.dirname(script), '..');
const repository = path.resolve(skillPath, '../..');
const canonicalCliPath = path.join(repository, 'bin/harnessorbit.mjs');
const legacyCliPath = path.join(repository, 'bin/cao.mjs');
let cliPath = canonicalCliPath;
try { await fs.access(canonicalCliPath); } catch { cliPath = legacyCliPath; }
const args = process.argv.slice(2);

if (args.length === 1 && args[0] === '--paths') {
  await fs.access(cliPath);
  console.log(JSON.stringify({
    repository, cliPath, skillPath,
    workflow: path.join(skillPath, 'references/workflow.md'),
    readme: path.join(repository, 'README.md'),
    profilesGuide: path.join(repository, 'docs/execution-profiles.md'),
    monitorGuide: path.join(repository, 'docs/monitor.md'),
  }, null, 2));
} else {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: 'inherit', shell: false });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', error => {
    console.error(`Could not start HarnessOrbit: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}
