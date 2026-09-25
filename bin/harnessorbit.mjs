#!/usr/bin/env node
import { main } from './cao.mjs';

main().then(data => {
  if (data?.help) process.stdout.write(data.help);
  else if (data?.usageTable) process.stdout.write(data.usageTable);
  else process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
}).catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'error', message: error.message, details: error.details || {} } }, null, 2)}\n`);
  process.exitCode = error.code === 'invalid_arguments' ? 2 : 1;
});
