#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve('work/aider-polyglot');
const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
const tasks = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));
if (tasks.length !== 1) {
  console.error(`expected exactly one Aider Polyglot task directory, found ${tasks.length}`);
  process.exit(2);
}

const taskRoot = path.join(root, tasks[0].name);
const child = spawn('python3', ['-m', 'unittest', 'discover', '-s', taskRoot, '-p', '*_test.py'], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
child.on('error', error => {
  console.error(error.message);
  process.exit(2);
});
child.on('close', (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
