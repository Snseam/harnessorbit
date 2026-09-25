import { isAbsolute } from 'node:path';
import { runCommand } from '../process.mjs';
import { OrchestratorError } from '../errors.mjs';

const TESTED_VERSION = '4.16.0';
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const TIMEOUT_MS = 60000;

const ALLOWED_CLIENTS = new Set(['claude', 'codex', 'pi', 'opencode']);
const ALLOWED_GROUP_BY = new Set([
  'client,provider,model',
  'client,session,model',
  'workspace,model',
]);
const REQUIRED_TOTALS = [
  ['input', 'totalInput'],
  ['output', 'totalOutput'],
  ['cacheRead', 'totalCacheRead'],
  ['cacheWrite', 'totalCacheWrite'],
  ['messageCount', 'totalMessages'],
];
const REQUIRED_ENTRY_FIELDS = [
  'client',
  'mergedClients',
  'model',
  'provider',
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
  'messageCount',
];

function invalid(message, details = {}) {
  throw new OrchestratorError('tokscale_invalid_report', message, details);
}

function validateClients(clients) {
  if (!Array.isArray(clients) || clients.length === 0) {
    invalid('Tokscale clients must be a nonempty array');
  }
  for (const client of clients) {
    if (!ALLOWED_CLIENTS.has(client)) {
      invalid('Tokscale client is not supported by HarnessOrbit', { client });
    }
  }
  return clients;
}

function validateGroupBy(groupBy) {
  if (!ALLOWED_GROUP_BY.has(groupBy)) {
    invalid('Tokscale groupBy is not supported by HarnessOrbit', { groupBy });
  }
  return groupBy;
}

function validateHome(home) {
  if (typeof home !== 'string' || home.length === 0 || !isAbsolute(home)) {
    invalid('Tokscale home must be an explicit absolute path');
  }
  return home;
}

function validateDate(name, value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid(`Tokscale ${name} must be YYYY-MM-DD`, { [name]: value });
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) invalid(`Tokscale ${name} is not a valid calendar date`);
  return value;
}

function parseVersionOutput(output) {
  const match = String(output).trim().match(/^tokscale (\d+)\.(\d+)\.(\d+)$/);
  if (!match) invalid('Tokscale version output did not match the expected format');
  return {
    version: `${match[1]}.${match[2]}.${match[3]}`,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function assertSupportedVersion(parsed) {
  const supported = parsed.major === 4 && (
    parsed.minor > 16 || (parsed.minor === 16 && parsed.patch >= 0)
  );
  if (!supported) {
    throw new OrchestratorError('tokscale_unsupported_version', 'Tokscale CLI version is not supported', {
      version: parsed.version,
      testedVersion: TESTED_VERSION,
      supportedRange: '>=4.16.0 <5',
    });
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    invalid('Tokscale returned invalid JSON');
  }
}

function assertSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid('Tokscale report contains an invalid numeric field', { field });
  }
}

function assertStringOrNull(value, field) {
  if (!(typeof value === 'string' || value === null)) {
    invalid('Tokscale report contains an invalid string field', { field });
  }
}

function assertNonemptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    invalid('Tokscale report contains an invalid string field', { field });
  }
}

function assertStringOrNullField(entry, field, index) {
  if (!Object.hasOwn(entry, field)) {
    invalid('Tokscale report entry is missing a required field', { index, field });
  }
  assertStringOrNull(entry[field], `entries[${index}].${field}`);
}

function requestedClientSet(clients) {
  return new Set(clients);
}

function validateMergedClients(entry, requested) {
  if (entry.mergedClients === null) return;
  for (const client of entry.mergedClients.split(',').map((part) => part.trim()).filter(Boolean)) {
    if (!requested.has(client)) {
      invalid('Tokscale report merged clients outside the requested client set', { client });
    }
    if (client !== entry.client) invalid('Tokscale aggregate combines different clients into one row');
  }
}

function validateEntry(entry, index, requested, groupBy) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    invalid('Tokscale report entry must be an object', { index });
  }
  for (const field of REQUIRED_ENTRY_FIELDS) {
    if (!Object.hasOwn(entry, field)) {
      invalid('Tokscale report entry is missing a required field', { index, field });
    }
  }

  assertNonemptyString(entry.client, `entries[${index}].client`);
  assertStringOrNull(entry.mergedClients, `entries[${index}].mergedClients`);
  assertNonemptyString(entry.model, `entries[${index}].model`);
  assertStringOrNull(entry.provider, `entries[${index}].provider`);

  if (!requested.has(entry.client)) {
    invalid('Tokscale report contains a client outside the requested client set', { client: entry.client });
  }
  if (groupBy === 'client,session,model') {
    assertStringOrNullField(entry, 'sessionId', index);
  }
  if (groupBy === 'workspace,model') {
    assertStringOrNullField(entry, 'workspaceKey', index);
    assertStringOrNullField(entry, 'workspaceLabel', index);
  }
  validateMergedClients(entry, requested);

  for (const [field] of REQUIRED_TOTALS) {
    assertSafeInteger(entry[field], `entries[${index}].${field}`);
  }
  assertSafeInteger(entry.reasoning, `entries[${index}].reasoning`);
}

function validateReport(report, groupBy, clients) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    invalid('Tokscale report must be a JSON object');
  }
  if (report.groupBy !== groupBy) {
    invalid('Tokscale report groupBy did not match the requested grouping', {
      expected: groupBy,
      actual: report.groupBy,
    });
  }
  if (!Array.isArray(report.entries)) {
    invalid('Tokscale report entries must be an array');
  }
  if (report.warnings !== undefined && (!Array.isArray(report.warnings) || report.warnings.some(w => typeof w !== 'string'))) invalid('Tokscale warnings must be an array of strings');
  if (report.diagnostics !== undefined && (!Array.isArray(report.diagnostics) || report.diagnostics.some(d => !d || typeof d.code !== 'string' || !['warning', 'info', 'error'].includes(d.severity)))) invalid('Tokscale diagnostics must be structured severity records');

  const requested = requestedClientSet(clients);
  const sums = Object.fromEntries(REQUIRED_TOTALS.map(([field]) => [field, 0]));
  const groups = new Set();
  for (const [index, entry] of report.entries.entries()) {
    validateEntry(entry, index, requested, groupBy);
    const key = JSON.stringify(groupBy === 'workspace,model' ? [entry.workspaceKey, entry.model] : groupBy === 'client,session,model' ? [entry.client, entry.sessionId, entry.model] : [entry.client, entry.provider, entry.model]);
    if (groups.has(key)) invalid('Tokscale returned duplicate aggregate groups');
    groups.add(key);
    for (const [field] of REQUIRED_TOTALS) sums[field] += entry[field];
  }

  for (const [field, totalField] of REQUIRED_TOTALS) {
    if (!Object.hasOwn(report, totalField)) {
      invalid('Tokscale report is missing a required total field', { field: totalField });
    }
    assertSafeInteger(report[totalField], totalField);
    if (report[totalField] !== sums[field]) {
      invalid('Tokscale report total does not match entry sum', {
        field: totalField,
        expected: sums[field],
        actual: report[totalField],
      });
    }
  }
}

function mapRunnerError(error, argv) {
  if (error instanceof OrchestratorError && error.code === 'command_spawn_failed') {
    throw new OrchestratorError('tokscale_missing', 'Tokscale CLI was not found or could not be started. Install @tokscale/cli and make the tokscale binary available on PATH.', {
      argv,
      causeCode: error.code,
      installSuggestion: 'npm install -g @tokscale/cli@4.16.0',
    });
  }
  if (error instanceof OrchestratorError && error.code === 'command_timeout') {
    throw new OrchestratorError('tokscale_timeout', 'Tokscale command timed out', {
      argv,
      timeoutMs: TIMEOUT_MS,
      truncated: error.details?.truncated === true,
    });
  }
  throw error;
}

export class Tokscale {
  constructor({ binary = 'tokscale', runner = runCommand } = {}) {
    this.binary = binary;
    this.runner = runner;
  }

  async run(argv) {
    try {
      return await this.runner(argv, {
        timeoutMs: TIMEOUT_MS,
        maxBytes: MAX_OUTPUT_BYTES,
      });
    } catch (error) {
      mapRunnerError(error, argv);
    }
  }

  async version() {
    const argv = [this.binary, '--version'];
    const result = await this.run(argv);
    if (result.truncated) {
      throw new OrchestratorError('tokscale_invalid_report', 'Tokscale version output was truncated', { argv });
    }
    if (result.code !== 0) {
      throw new OrchestratorError('tokscale_failed', 'Tokscale version command failed', {
        argv,
        code: result.code,
      });
    }
    const parsed = parseVersionOutput(result.stdout);
    assertSupportedVersion(parsed);
    return {
      version: parsed.version,
      testedVersion: TESTED_VERSION,
      supportedRange: '>=4.16.0 <5',
    };
  }

  async models({ clients, groupBy, since, until, home } = {}) {
    validateClients(clients);
    validateGroupBy(groupBy);
    validateHome(home);
    const start = validateDate('since', since);
    const end = validateDate('until', until);
    if (start && end && start > end) invalid('Tokscale since must not be later than until');

    const argv = [
      this.binary,
      'models',
      '--json',
      '--no-spinner',
      '--home',
      home,
      '--client',
      clients.join(','),
      '--group-by',
      groupBy,
    ];
    if (start !== undefined) argv.push('--since', start);
    if (end !== undefined) argv.push('--until', end);

    const result = await this.run(argv);
    if (result.truncated) {
      throw new OrchestratorError('tokscale_invalid_report', 'Tokscale report output was truncated', { argv });
    }
    if (result.code !== 0) {
      throw new OrchestratorError('tokscale_failed', 'Tokscale models command failed', {
        argv,
        code: result.code,
      });
    }
    const report = parseJson(result.stdout.trim());
    validateReport(report, groupBy, clients);
    return report;
  }
}
