#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Orchestrator, defaultStateRoot } from '../src/orchestrator.mjs';
import { Herdr } from '../src/runtime/herdr.mjs';
import { capabilities } from '../src/adapters.mjs';
import { validateTask } from '../src/task.mjs';
import { OrchestratorError } from '../src/errors.mjs';
import { runCommand } from '../src/process.mjs';
import { Tokscale } from '../src/runtime/tokscale.mjs';
import { UsageService, formatUsageTable } from '../src/usage.mjs';
import { ProfileStore } from '../src/profiles.mjs';
import { discoverCCSwitch, importCCSwitchProfile } from '../src/config-sources/cc-switch.mjs';
import { explainRoute, listReservations } from '../src/routing.mjs';
import { GatewayManager } from '../src/gateway/manager.mjs';
import { MonitorManager, openMonitor } from '../src/monitor/manager.mjs';
import { loadRun } from '../src/state.mjs';
import { getProjectInfo } from '../src/git.mjs';
import { installCaoSkill, statusCaoSkill, uninstallCaoSkill } from '../src/skills.mjs';
import { disableConversationMode, enableConversationMode, statusConversationMode, resolveThreadId } from '../src/conversation-mode.mjs';
import { explainShadowRoute, recordShadowDecision } from '../src/shadow-routing.mjs';
import { AdaptiveDispatcher } from '../src/adaptive-dispatch.mjs';
import { Supervisor } from '../src/supervisor/index.mjs';
import { submitResult, MAX_RESULT_BYTES } from '../src/results.mjs';
import { ResourceService } from '../src/resources/index.mjs';
import { CalibrationStore } from '../src/calibration/store.mjs';
import { CalibrationRunner, releaseCalibrationReservation } from '../src/calibration/runner.mjs';
import { createContextPacket } from '../src/context-packet.mjs';
import { ProjectLedger, initProjectLedger } from '../src/project-ledger.mjs';
import { WorkflowRegistry } from '../src/workflows.mjs';
import { runInternalBenchmark, createInternalBenchmarkPlan } from '../src/internal-benchmark.mjs';
import { replayShadowTraces } from '../src/shadow-replay.mjs';
import { DeterministicDecisionProvider, JevDecisionProvider } from '../src/decision-provider.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService, AccessAudit } from '../src/access/service.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { SessionService, SessionStore, Tmux } from '../src/access/sessions.mjs';
import { MemoryService, memoryProviderFromEnv } from '../src/access/memory.mjs';
import { JobStore } from '../src/access/jobs.mjs';
import { CoopService } from '../src/access/coop.mjs';
import { SessionObserver } from '../src/access/observer.mjs';
import { Dispatcher, defaultAdapters } from '../src/access/dispatch.mjs';

export const help = `HarnessOrbit 0.1.0

Usage: node bin/harnessorbit.mjs <command> [options]

The legacy node bin/cao.mjs entrypoint remains supported.

  init       --project PATH [--id ID] [--max-parallel 4]
  harness init --project PATH [--include-paths src/,docs/]
  harness context --project PATH [--include-paths src/,docs/]
  harness ledger --project PATH
  harness workflow --run ID [--id release-readiness]
  harness benchmark [--output PATH]
  harness replay --file TRACES.json
  validate   --file TASK.json
  dispatch   --run ID --file TASK.json [--adaptive] [--thread ID] [--resources ID,ID]
             [--executor host|external] [--preference balanced|fastest|subscription-first|quality-first]
             [--calibration-policy off|on-demand] [--probe-budget-ms N]
  preflight  --run ID --file TASK.json (read-only; no model calls)
  supervise  --run ID [--wait-ms 30000] [--poll-ms 1000] [--integrate] [--repair-reports]
  step       --run ID [--integrate] [--repair-reports]
  performance report --run ID
  result submit --attempt-dir PATH (--file REPORT.json | --stdin)
  host start --run ID --file TASK.json [--thread ID] [--retry]
  host report --run ID --task ID --file REPORT.json [--thread ID]
  host verify --run ID --task ID [--thread ID]
  host release --run ID --task ID --ack-stopped [--children-file PATH] [--thread ID]
  host recover --run ID --task ID [--thread ID]
  resources list [--agent claude,pi,codex,opencode] [--home PATH]
  resources check [--agent claude,pi,codex,opencode] [--home PATH]
  calibrate --resource ID[,ID] [--quick | --suite quick|code] [--refresh]
             [--timeout-ms N] [--budget-ms N] [--home PATH]
  calibration list [--resource ID]
  calibration release --reservation ID --confirm-stopped
  status     [--run ID]
  inspect    --run ID --task ID [--output]
  collect    --run ID --task ID [--wait-ms 45000]
  verify     --run ID --task ID
  retry      --run ID --task ID [--feedback-file PATH]
  resume     --run ID --task ID
  input      --run ID --task ID (--keys enter | --text-file PATH)
  integrate  --run ID --task ID
  recover    --run ID --task ID (recheck failed checkout or integration)
  cancel     --run ID --task ID
  cleanup    --run ID
  usage      [--agent claude,codex,pi,opencode] [--model MODEL]
             [--today | --since YYYY-MM-DD --until YYYY-MM-DD]
             [--run ID [--task ID]] [--home PATH] [--tokscale-bin PATH] [--table]
  doctor

  skill install [--skills-dir PATH]
  skill status [--skills-dir PATH]
  skill uninstall [--skills-dir PATH]
  mode enable [--thread ID] [--project PATH] [--agent auto|claude|pi|opencode|codex]
             [--profile ID] [--max-parallel N] [--max-attempts N]
             [--strategy delegated|shadow|adaptive] [--preference balanced|fastest|subscription-first|quality-first]
             [--calibration-policy off|on-demand] [--probe-budget-ms N]
  mode status [--thread ID]
  mode disable [--thread ID]

  monitor start [--project PATH | --run ID | --all] [--open] [--id NAME] [--port 0]
  monitor status [--id NAME]
  monitor stop [--id NAME]
  monitor snapshot [--project PATH | --run ID | --all]
             [--coordinator CODEX_THREAD_ID] [--codex-home PATH] [--claude-home PATH]

  source discover [--directory CC_SWITCH_DIRECTORY]
  profile list
  profile show --id ID
  profile put --file PROFILE.json [--if-revision HASH] [--default]
  profile clone --id ID --new-id NEW_ID
  profile remove --id ID
  profile default [--id ID | --clear]
  profile export --id ID [--file PATH]
  profile import-cc-switch --provider ID --app claude|pi --id ID
             [--directory PATH] [--model MODEL] [--allow-shared]
  profile refresh --id ID [--model MODEL]
  secret set --id ID --stdin
  secret remove --id ID
  route explain --file TASK.json
  route shadow --file TASK.json [--thread ID] [--record] [--resources ID,ID] [--no-host] [--executor host|external]
             [--agent claude|pi|codex|opencode] [--preference balanced|fastest|subscription-first|quality-first]
  route reservations
  gateway start --profile ID [--id ID] [--allow-shared]
  gateway status --id ID
  gateway stop --id ID
  gateway list

  access principal create --id ID --project PATH[,PATH] [--agents codex,claude]
             [--allow-integrate] [--rate-limit 60] [--label TEXT] [--kind grok|claude_code|codex|human|other]   (prints the token once)
  access principal list
  access principal remove --id ID
  access serve [--port 0] [--host 127.0.0.1]   (foreground MCP server; Ctrl-C stops it)
  access describe --principal ID
  access submit --principal ID --file JOB.json
  access status --principal ID --job ID [--no-advance]
  access approve --principal ID --job ID            (integrate; principal needs --allow-integrate)
  access answer --principal ID --job ID (--text TEXT | --text-file FILE | --keys Enter,y)
  access cancel --principal ID --job ID [--reason TEXT]
  access result --principal ID --job ID [--patch]
  access retry --principal ID --job ID [--feedback TEXT | --feedback-file FILE]
  access events --principal ID [--job ID] [--since CURSOR] [--limit 100]
  access principal update --id ID (--allow-sessions | --deny-sessions | --allow-integrate | --deny-integrate)
  access principal migrate --id ID      (operator, once: give a pre-identity principal its incarnation)
  access principal adopt-jobs --id ID   (operator: assign this principal's pre-identity jobs to its current incarnation)
  access session discover [--tmux-socket NAME]       (operator: which tmux panes run claude/codex)
  access session bind --principal ID --pane %N [--id NAME] [--allow-keys] [--label TEXT] [--tmux-socket NAME] [--provider-session UUID]
  access session list --principal ID
  access session status --principal ID --session ID
  access session send --principal ID --session ID --key KEY (--text TEXT | --text-file FILE | --keys Enter)
  access session read --principal ID --session ID [--cursor CURSOR] [--max-lines 120]
  access session unbind --principal ID --session ID   (or --operator to drop any binding by id)
  access memory recall --principal ID (--session ID | --job ID) --question TEXT [--top-k 5] [--authority agent|orchestrator]
  access coop resolve --event UUID --consumer ID --as accepted|resend [--note TEXT]   (operator: settle an unresolved delivery)
  access memory begin --principal ID (--session ID | --job ID) --operation ID [--authority agent|orchestrator]
  access memory checkpoint --principal ID (--session ID | --job ID) --operation ID [--file CHECKPOINT.json] [--attestation EVENT-UUID]
  (orchestrator carrier needs HARNESSORBIT_MEMORY_ORCHESTRATOR_CARRIER=1 on the host after "memy connection orchestrator enable")
  access memory pending [--principal ID]
  access recipient register --id ID --kind inbox --principal ID [--task-refs harnessorbit:job/,…] [--sources ID,…] [--types work.reported,…] [--label TEXT]
  access recipient register --id ID --kind grok-native-webhook --endpoint https://… --secret-file FILE [scopes…]
  access recipient register --id ID --kind codex-app-server --socket PATH --thread ID [scopes…]
  access recipient list | access recipient revoke --id ID
  access coop report --principal ID --key KEY --type TYPE --task REF [--payload-file FILE] [--evidence-file FILE] [--correlation ID] [--causation EVENT-UUID]
  access coop inbox --principal ID [--cursor N | --cursor-v2 TOKEN] [--limit 50]
  access coop store init                            (host: create an empty cooperation store with a fresh generation)
  access coop store migrate --from-v1 [--resume]    (host, writers stopped: bring a pre-protocol store under the committed boundary)
  access coop store inspect                         (host: read-only store status, boundary and pending recovery)
  access coop ack --principal ID --event UUID --epoch EPOCH
  access coop deliveries                            (operator: pending non-inbox deliveries)
  access coop dispatch [--once] [--interval-ms 5000] [--allow-http-loopback]   (operator: deliver pending events through registered transports)
  access observe [--once] [--interval-ms 5000] [--tmux-socket NAME]   (emit agent.turn_finished on observed working → ready)
  (memory provider: HARNESSORBIT_MEMORY_PROVIDER=memy-handoff-cli [HARNESSORBIT_MEMY_BIN=memy]; unset = unconfigured)

Global: --state-dir PATH (outside project), --help, --json
Results are JSON unless usage --table is selected. Keys can be comma-separated.
dispatch submits once; collect waits without resubmitting.
verify checks a stopped candidate; integrate applies and rechecks it.
usage queries local token records through optional Tokscale; scoped attribution is workspace-based.
Profiled tasks use isolated runtime settings; existing global provider files are not rewritten.
monitor serves an authenticated, localhost-only status page; stopping it never stops agents.
No automatic commits, pushes, or plugin installation.
supervise is a bounded foreground controller; no background watchdog runs between calls.
Only --integrate applies patches; --repair-reports permits one report-only request per attempt.
Task deadlineAt is an optional ISO UTC deadline, enforced while a controller/check is active.
`;

function configuredDecisionProvider() {
  const endpoint = process.env.JEV_ENDPOINT;
  const apiKey = process.env.JEV_JBSD_API_KEY || process.env.JEV_JBSD_APIKEY;
  return endpoint && apiKey ? new JevDecisionProvider({ endpoint, apiKey }) : null;
}

const optionsByCommand = {
  init: ['project', 'id', 'max-parallel'], validate: ['file'], dispatch: ['run', 'file', 'adaptive', 'thread', 'resources', 'executor', 'preference', 'calibration-policy', 'probe-budget-ms'],
  'harness init': ['project', 'include-paths', 'run'], 'harness context': ['project', 'include-paths', 'run'], 'harness ledger': ['project'],
  'harness workflow': ['run', 'id'], 'harness benchmark': ['output'], 'harness replay': ['file'],
  preflight: ['run', 'file'], supervise: ['run', 'wait-ms', 'poll-ms', 'integrate', 'repair-reports'],
  step: ['run', 'integrate', 'repair-reports'], 'performance report': ['run'],
  'result submit': ['attempt-dir', 'file', 'stdin'],
  'host start': ['run', 'file', 'thread', 'retry'], 'host report': ['run', 'task', 'file', 'thread'],
  'host verify': ['run', 'task', 'thread'], 'host release': ['run', 'task', 'thread', 'ack-stopped', 'children-file'],
  'host recover': ['run', 'task', 'thread'],
  'resources list': ['agent', 'home'], 'resources check': ['agent', 'home'],
  calibrate: ['resource', 'quick', 'suite', 'refresh', 'timeout-ms', 'budget-ms', 'home'],
  'calibration list': ['resource'], 'calibration release': ['reservation', 'confirm-stopped'],
  status: ['run'], inspect: ['run', 'task', 'output'], collect: ['run', 'task', 'wait-ms'],
  verify: ['run', 'task'], retry: ['run', 'task', 'feedback-file'], resume: ['run', 'task'],
  input: ['run', 'task', 'keys', 'text-file'], integrate: ['run', 'task'],
  recover: ['run', 'task'], cancel: ['run', 'task'], cleanup: ['run'], doctor: [],
  usage: ['agent', 'model', 'today', 'since', 'until', 'run', 'task', 'home', 'tokscale-bin', 'table'],
  'source discover': ['directory'],
  'profile list': [], 'profile show': ['id'], 'profile put': ['file', 'if-revision', 'default'],
  'profile clone': ['id', 'new-id'], 'profile remove': ['id'], 'profile default': ['id', 'clear'],
  'profile export': ['id', 'file'], 'profile import-cc-switch': ['directory', 'provider', 'app', 'id', 'model', 'allow-shared'],
  'profile refresh': ['id', 'model'], 'secret set': ['id', 'stdin'], 'secret remove': ['id'],
  'route explain': ['file'], 'route reservations': [],
  'route shadow': ['file', 'thread', 'record', 'resources', 'no-host', 'agent', 'preference', 'executor'],
  'skill install': ['skills-dir'], 'skill status': ['skills-dir'], 'skill uninstall': ['skills-dir'],
  'mode enable': ['thread', 'project', 'agent', 'profile', 'max-parallel', 'max-attempts', 'strategy', 'preference', 'calibration-policy', 'probe-budget-ms'],
  'mode status': ['thread'], 'mode disable': ['thread'],
  'gateway start': ['profile', 'id', 'allow-shared'], 'gateway status': ['id'], 'gateway stop': ['id'], 'gateway list': [],
  'monitor start': ['project', 'run', 'all', 'open', 'id', 'port', 'coordinator', 'codex-home', 'claude-home'],
  'monitor status': ['id'], 'monitor stop': ['id'],
  'monitor snapshot': ['project', 'run', 'all', 'coordinator', 'codex-home', 'claude-home'],
  'access principal create': ['id', 'project', 'agents', 'allow-integrate', 'rate-limit', 'label', 'kind'],
  'access principal list': [], 'access principal remove': ['id'],
  'access serve': ['port', 'host', 'tmux-socket'],
  'access describe': ['principal'], 'access submit': ['principal', 'file'], 'access status': ['principal', 'job', 'no-advance'],
  'access approve': ['principal', 'job'], 'access answer': ['principal', 'job', 'text', 'text-file', 'keys'],
  'access cancel': ['principal', 'job', 'reason'], 'access result': ['principal', 'job', 'patch'],
  'access retry': ['principal', 'job', 'feedback', 'feedback-file'], 'access events': ['principal', 'job', 'since', 'limit'],
  'access principal update': ['id', 'allow-sessions', 'deny-sessions', 'allow-integrate', 'deny-integrate'],
  'access principal adopt-jobs': ['id'], 'access principal migrate': ['id'],
  'access session discover': ['tmux-socket'],
  'access session bind': ['principal', 'pane', 'id', 'allow-keys', 'label', 'tmux-socket', 'provider-session'],
  'access session list': ['principal', 'tmux-socket'], 'access session status': ['principal', 'session', 'tmux-socket'],
  'access session send': ['principal', 'session', 'key', 'text', 'text-file', 'keys', 'tmux-socket'],
  'access session read': ['principal', 'session', 'cursor', 'max-lines', 'tmux-socket'],
  'access session unbind': ['principal', 'session', 'operator', 'tmux-socket'],
  'access memory recall': ['principal', 'session', 'job', 'question', 'top-k', 'authority'],
  'access memory begin': ['principal', 'session', 'job', 'operation', 'authority'],
  'access memory checkpoint': ['principal', 'session', 'job', 'operation', 'file', 'attestation'],
  'access memory pending': ['principal'],
  'access recipient register': ['id', 'kind', 'principal', 'endpoint', 'secret-file', 'socket', 'thread', 'task-refs', 'sources', 'types', 'label'],
  'access recipient list': [], 'access recipient revoke': ['id'],
  'access coop report': ['principal', 'key', 'type', 'task', 'payload-file', 'evidence-file', 'conversation', 'correlation', 'causation'],
  'access coop inbox': ['principal', 'cursor', 'cursor-v2', 'limit'], 'access coop store init': [], 'access coop store migrate': ['from-v1', 'resume'], 'access coop store inspect': [], 'access coop ack': ['principal', 'event', 'epoch'], 'access coop deliveries': [],
  'access coop dispatch': ['once', 'interval-ms', 'allow-http-loopback'],
  'access coop resolve': ['event', 'consumer', 'as', 'note'],
  'access observe': ['once', 'interval-ms', 'tmux-socket'],
};
const namespaces = new Set(['source', 'profile', 'secret', 'route', 'gateway', 'monitor', 'skill', 'mode', 'performance', 'result', 'resources', 'calibration', 'host', 'harness', 'access', 'access principal', 'access session', 'access memory', 'access recipient', 'access coop', 'access coop store']);

export function parseArgs(argv) {
  const values = {};
  let command;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      if (!command) { command = token; continue; }
      if (namespaces.has(command)) { command += ` ${token}`; continue; }
      throw new OrchestratorError('invalid_arguments', `Unexpected argument: ${token}`);
    }
    const [name, ...inlineParts] = token.slice(2).split('=');
    if (Object.hasOwn(values, name)) throw new OrchestratorError('invalid_arguments', `Duplicate option: --${name}`);
    const booleanOption = ['help', 'today', 'table', 'default', 'clear', 'allow-shared', 'stdin', 'all', 'open', 'integrate', 'repair-reports', 'quick', 'refresh', 'confirm-stopped', 'retry', 'ack-stopped', 'record', 'no-host', 'adaptive', 'allow-integrate', 'no-advance', 'patch', 'allow-sessions', 'deny-sessions', 'deny-integrate', 'allow-keys', 'operator', 'required', 'once', 'allow-http-loopback', 'from-v1', 'resume'].includes(name)
      || (name === 'output' && command !== 'harness benchmark');
    if (booleanOption) {
      if (inlineParts.length) throw new OrchestratorError('invalid_arguments', `--${name} takes no value`);
      values[name] = true;
    } else {
      const value = inlineParts.length ? inlineParts.join('=') : argv[++i];
      if (value === undefined || (!inlineParts.length && value.startsWith('--'))) throw new OrchestratorError('invalid_arguments', `Missing value for --${name}`);
      values[name] = value;
    }
  }
  if (values.help || !command) return { command: 'help', values };
  if (!Object.hasOwn(optionsByCommand, command)) throw new OrchestratorError('invalid_arguments', `Unknown command: ${command}`);
  const allowed = new Set(['state-dir', 'json', ...optionsByCommand[command]]);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new OrchestratorError('invalid_arguments', `Unknown option for ${command}: --${name}`);
  return { command, values };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values: o } = parseArgs(argv);
  if (command === 'help') return { help };
  const required = key => {
    if (!o[key]) throw new OrchestratorError('invalid_arguments', `--${key} is required`);
    return o[key];
  };
  const read = file => fs.readFile(path.resolve(file), 'utf8');
  const profiles = new ProfileStore({ root: o['state-dir'] || defaultStateRoot() });
  const gateways = new GatewayManager({ root: profiles.root, profiles });
  const readProfile = async file => {
    try { return JSON.parse(await read(file)); }
    catch (error) { if (error instanceof SyntaxError) throw new OrchestratorError('invalid_profile_file', 'Profile file is not valid JSON.'); throw error; }
  };
  const orchestrator = new Orchestrator({ stateRoot: o['state-dir'], herdr: new Herdr({ binary: process.env.CAO_HERDR_BIN || 'herdr' }) });
  const taskArgs = () => [required('run'), required('task')];
  const monitorScope = async () => {
    if (o.all && (o.project || o.run)) throw new OrchestratorError('invalid_arguments', '--all cannot be combined with --project or --run.');
    let project = o.project ? await fs.realpath(path.resolve(o.project)) : null;
    if (o.run) {
      const run = await loadRun(profiles.root, o.run);
      if (!run) throw new OrchestratorError('run_not_found', 'Monitor run does not exist in this state directory.');
      if (project && project !== run.project) throw new OrchestratorError('monitor_scope_mismatch', 'Project does not match the selected run.');
      project = run.project;
    }
    if (!o.all && !project) project = (await getProjectInfo(process.cwd())).root;
    return { project, runId: o.run || null, all: !!o.all, coordinatorId: o.coordinator || (o.run ? null : process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || null), coordinatorExplicit: Boolean(o.coordinator), codexHome: o['codex-home'], claudeHome: o['claude-home'] };
  };
  switch (command) {
    case 'host start': return orchestrator.hostStart(required('run'), await readProfile(required('file')), { thread: o.thread, retry: !!o.retry });
    case 'host report': {
      const file = required('file'), info = await fs.lstat(path.resolve(file));
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RESULT_BYTES) throw new OrchestratorError('invalid_result', 'Report must be a regular file of at most 128 KiB.');
      return orchestrator.hostReport(...taskArgs(), await readProfile(file), { thread: o.thread });
    }
    case 'host verify': return orchestrator.hostVerify(...taskArgs(), { thread: o.thread });
    case 'host release': return orchestrator.hostRelease(...taskArgs(), { thread: o.thread, ackStopped: !!o['ack-stopped'], ...(o['children-file'] ? { children: await readProfile(o['children-file']) } : {}) });
    case 'host recover': return orchestrator.recover(...taskArgs(), { hostThread: resolveThreadId(o.thread) });
    case 'route shadow': {
      const input = await readProfile(required('file'));
      const task = validateTask(input);
      const thread = resolveThreadId(o.thread);
      const mode = await statusConversationMode({ stateRoot: profiles.root, thread });
      const inventory = await new ResourceService({ root: profiles.root }).discover();
      const requestedAgent = o.agent || (mode.enabled && o.executor !== 'host' ? mode.agent : null) || (input.agent && input.agent !== 'auto' ? input.agent : null);
      const decision = await explainShadowRoute({ task, inventory, preference: o.preference || mode.preference,
        fixedExecutorKind: o.executor,
        hostAvailable: !o['no-host'], ...(o.resources === undefined ? {} : { allowedResourceIds: o.resources.split(',') }),
        fixedProfileId: mode.enabled && o.executor !== 'host' ? mode.profile : null,
        fixedAgent: requestedAgent === 'auto' ? null : requestedAgent,
      });
      if (!o.record) return decision;
      if (!thread) throw new OrchestratorError('thread_unavailable', '--record requires the current conversation id.');
      return recordShadowDecision(profiles.root, thread, decision);
    }
    case 'resources list':
    case 'resources check': return new ResourceService({ root: profiles.root, ...(o.home ? { home: path.resolve(o.home) } : {}) }).discover({ check: command.endsWith('check'), ...(o.agent ? { agents: o.agent.split(',') } : {}) });
    case 'calibration list': return { records: await new CalibrationStore({ root: profiles.root }).list({ resourceId: o.resource }) };
    case 'calibration release': return releaseCalibrationReservation(profiles.root, required('reservation'), { confirmedStopped: !!o['confirm-stopped'] });
    case 'calibrate': {
      if (o.quick && o.suite && o.suite !== 'quick') throw new OrchestratorError('invalid_arguments', '--quick cannot be combined with another suite.');
      const resources = new ResourceService({ root: profiles.root, ...(o.home ? { home: path.resolve(o.home) } : {}) });
      const controller = new AbortController();
      const interrupt = () => { process.exitCode = 130; controller.abort(); };
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        return await new CalibrationRunner({ root: profiles.root, resources, profiles, ...(o.home ? { home: path.resolve(o.home) } : {}) }).run({
          resourceIds: required('resource').split(','), suite: o.suite || 'quick', refresh: !!o.refresh,
          ...(o['timeout-ms'] === undefined ? {} : { timeoutMs: Number(o['timeout-ms']) }),
          ...(o['budget-ms'] === undefined ? {} : { budgetMs: Number(o['budget-ms']) }), signal: controller.signal,
        });
      } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    }
    case 'monitor start': {
      const monitor = await new MonitorManager({ root: profiles.root }).start({ ...await monitorScope(), id: o.id || 'default', port: o.port === undefined ? 0 : Number(o.port) });
      return { ...monitor, browserOpened: o.open ? await openMonitor(monitor.url) : false };
    }
    case 'access principal create': {
      const projects = required('project').split(',').map(value => path.resolve(value.trim())).filter(Boolean);
      const rateLimit = o['rate-limit'] === undefined ? 60 : Number(o['rate-limit']);
      const created = await new PrincipalStore({ root: profiles.root }).create({
        id: required('id'), projects, agents: o.agents ? o.agents.split(',').map(value => value.trim()) : ['codex', 'claude'],
        permissions: { integrate: !!o['allow-integrate'] }, rateLimitPerMinute: rateLimit, label: o.label || null, kind: o.kind || 'other',
      });
      return { ...created, note: 'Store this token now; HarnessOrbit keeps only its hash and cannot show it again.' };
    }
    case 'access principal list': return { principals: await new PrincipalStore({ root: profiles.root }).list() };
    case 'access principal migrate': return new PrincipalStore({ root: profiles.root }).migrate(required('id'));
    case 'access principal adopt-jobs': return new AccessService({ root: profiles.root, orchestrator, driver: 'inline' }).adoptLegacyJobs(required('id'));
    case 'access principal update': {
      const permissions = {};
      if (o['allow-sessions']) permissions.sessions = true;
      if (o['deny-sessions']) permissions.sessions = false;
      if (o['allow-integrate']) permissions.integrate = true;
      if (o['deny-integrate']) permissions.integrate = false;
      if (!Object.keys(permissions).length) throw new OrchestratorError('invalid_arguments', 'Name at least one permission change.');
      return { principal: await new PrincipalStore({ root: profiles.root }).update(required('id'), { permissions }) };
    }
    case 'access session discover':
    case 'access session bind':
    case 'access session list':
    case 'access session status':
    case 'access session send':
    case 'access session read':
    case 'access session unbind': {
      const principals = new PrincipalStore({ root: profiles.root });
      const sessions = new SessionService({ root: profiles.root, principals, tmux: new Tmux({ socket: o['tmux-socket'] || null }) });
      const audit = new AccessAudit({ root: profiles.root });
      const tool = command.slice('access session '.length);
      if (tool === 'discover') return sessions.discover();
      if (tool === 'bind') return sessions.bind({ principalId: required('principal'), pane: required('pane'), id: o.id || null, allowKeys: !!o['allow-keys'], label: o.label || null, providerSessionId: o['provider-session'] || null });
      if (tool === 'unbind' && o.operator) return { id: required('session'), removed: await sessions.unbindAsOperator(o.session) };
      const principal = await principals.get(required('principal'));
      if (!principal) throw new OrchestratorError('principal_not_found', 'Principal does not exist.');
      const startedAt = Date.now();
      const auditName = tool === 'list' ? 'sessions' : `session_${tool}`;
      try {
        let result;
        if (tool === 'list') result = await sessions.list(principal);
        else if (tool === 'status') result = await sessions.status(principal, { sessionId: required('session') });
        else if (tool === 'read') result = await sessions.read(principal, { sessionId: required('session'), cursor: o.cursor, ...(o['max-lines'] === undefined ? {} : { maxLines: Number(o['max-lines']) }) });
        else if (tool === 'unbind') result = await sessions.unbind(principal, { sessionId: required('session') });
        else {
          const sources = ['text', 'text-file', 'keys'].filter(key => o[key] !== undefined);
          if (sources.length !== 1) throw new OrchestratorError('invalid_arguments', 'Supply exactly one of --text, --text-file, or --keys.');
          const input = o.keys !== undefined ? { keys: String(o.keys).split(',').map(v => v.trim()).filter(Boolean) } : { text: o['text-file'] ? await read(o['text-file']) : o.text };
          result = await sessions.send(principal, { sessionId: required('session'), idempotencyKey: required('key'), ...input });
        }
        await audit.record({ principalId: principal.id, transport: 'cli', tool: auditName, sessionId: o.session || null, ok: true, durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        await audit.record({ principalId: principal.id, transport: 'cli', tool: auditName, sessionId: o.session || null, ok: false, code: error.code, durationMs: Date.now() - startedAt });
        throw error;
      }
    }
    case 'access principal remove': return { id: required('id'), removed: await new PrincipalStore({ root: profiles.root }).remove(o.id) };
    case 'access serve': {
      const service = new AccessService({ root: profiles.root, orchestrator, driver: 'background' });
      const sessions = new SessionService({ root: profiles.root, principals: service.principals, tmux: new Tmux({ socket: o['tmux-socket'] || null }) });
      const provider = memoryProviderFromEnv();
      const coop = new CoopService({ root: profiles.root, principals: service.principals, jobs: service.jobs, sessions: sessions.sessions, orchestrator });
      const memory = new MemoryService({ root: profiles.root, provider, principals: service.principals, sessions: sessions.sessions, jobs: service.jobs, orchestrator, coop, orchestratorCarrier: process.env.HARNESSORBIT_MEMORY_ORCHESTRATOR_CARRIER === '1' });
      const port = o.port === undefined ? 0 : Number(o.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new OrchestratorError('invalid_arguments', '--port must be an integer from 0 to 65535.');
      const started = await startAccessServer({ service, sessions, memory, coop, port, host: o.host || '127.0.0.1' });
      process.stdout.write(`${JSON.stringify({ ok: true, data: { endpoint: started.endpoint, port: started.port, pid: process.pid, memoryProvider: provider.name, note: 'Serving. Expose the endpoint through your own tunnel or tailnet; callers need a principal token.' } })}\n`);
      await new Promise(resolve => { const stop = () => { started.close(); resolve(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
      return { stopped: true, endpoint: started.endpoint };
    }
    case 'access describe':
    case 'access submit':
    case 'access status':
    case 'access approve':
    case 'access answer':
    case 'access cancel':
    case 'access result':
    case 'access retry':
    case 'access events': {
      const principal = await new PrincipalStore({ root: profiles.root }).get(required('principal'));
      if (!principal) throw new OrchestratorError('principal_not_found', 'Principal does not exist.');
      const service = new AccessService({ root: profiles.root, orchestrator, driver: 'inline' });
      const audit = new AccessAudit({ root: profiles.root });
      const tool = command.slice('access '.length);
      const startedAt = Date.now();
      const answerInput = async () => {
        const sources = ['text', 'text-file', 'keys'].filter(key => o[key] !== undefined);
        if (sources.length !== 1) throw new OrchestratorError('invalid_arguments', 'Supply exactly one of --text, --text-file, or --keys.');
        if (o.keys !== undefined) return { keys: String(o.keys).split(',').map(value => value.trim()).filter(Boolean) };
        return { text: o['text-file'] ? await read(o['text-file']) : o.text };
      };
      try {
        const result = tool === 'describe' ? service.describe(principal)
          : tool === 'submit' ? await service.submit(principal, await readProfile(required('file')))
            : tool === 'status' ? await service.status(principal, { jobId: required('job'), advance: !o['no-advance'] })
              : tool === 'approve' ? await service.approve(principal, { jobId: required('job') })
                : tool === 'answer' ? await service.answer(principal, { jobId: required('job'), ...(await answerInput()) })
                  : tool === 'cancel' ? await service.cancel(principal, { jobId: required('job'), reason: o.reason })
                    : tool === 'retry' ? await service.retry(principal, { jobId: required('job'), feedback: o['feedback-file'] ? await read(o['feedback-file']) : o.feedback })
                      : tool === 'events' ? await service.events(principal, { jobId: o.job, since: o.since, ...(o.limit === undefined ? {} : { limit: Number(o.limit) }) })
                        : await service.result(principal, { jobId: required('job'), includePatch: !!o.patch });
        await audit.record({ principalId: principal.id, transport: 'cli', tool, jobId: result?.job?.id || o.job || null, ok: true, durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        await audit.record({ principalId: principal.id, transport: 'cli', tool, jobId: o.job || null, ok: false, code: error.code, durationMs: Date.now() - startedAt });
        throw error;
      }
    }
    case 'access memory recall':
    case 'access memory begin':
    case 'access memory checkpoint':
    case 'access memory pending': {
      const principals = new PrincipalStore({ root: profiles.root });
      const memorySessions = new SessionStore({ root: profiles.root });
      const memoryJobs = new JobStore({ root: profiles.root });
      const memory = new MemoryService({ root: profiles.root, provider: memoryProviderFromEnv(), principals, sessions: memorySessions, jobs: memoryJobs, orchestrator, coop: new CoopService({ root: profiles.root, principals, jobs: memoryJobs, sessions: memorySessions, orchestrator }), orchestratorCarrier: process.env.HARNESSORBIT_MEMORY_ORCHESTRATOR_CARRIER === '1' });
      const tool = command.slice('access memory '.length);
      if (tool === 'pending') return memory.pending(o.principal ? { id: o.principal } : null);
      const principal = await principals.get(required('principal'));
      if (!principal) throw new OrchestratorError('principal_not_found', 'Principal does not exist.');
      const audit = new AccessAudit({ root: profiles.root });
      const startedAt = Date.now();
      const target = { sessionId: o.session, jobId: o.job };
      try {
        const result = tool === 'recall'
          ? await memory.recall(principal, { ...target, question: required('question'), ...(o['top-k'] === undefined ? {} : { topK: Number(o['top-k']) }), ...(o.authority ? { authority: o.authority } : {}) })
          : tool === 'begin'
            ? await memory.begin(principal, { ...target, operationId: required('operation'), ...(o.authority ? { authority: o.authority } : {}) })
            : await memory.checkpoint(principal, { ...target, operationId: required('operation'), ...(o.file ? await readProfile(o.file) : {}), ...(o.attestation ? { attestationEventId: o.attestation } : {}) });
        await audit.record({ principalId: principal.id, transport: 'cli', tool: `memory_${tool}`, jobId: o.job || null, sessionId: o.session || null, ok: true, code: result.status, durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        await audit.record({ principalId: principal.id, transport: 'cli', tool: `memory_${tool}`, jobId: o.job || null, sessionId: o.session || null, ok: false, code: error.code, durationMs: Date.now() - startedAt });
        throw error;
      }
    }
    case 'access recipient register':
    case 'access recipient list':
    case 'access recipient revoke':
    case 'access coop report':
    case 'access coop inbox':
    case 'access coop ack':
    case 'access coop deliveries':
    case 'access coop dispatch':
    case 'access coop resolve':
    case 'access coop store init':
    case 'access coop store migrate':
    case 'access coop store inspect':
    case 'access observe': {
      const principals = new PrincipalStore({ root: profiles.root });
      const sessionStore = new SessionStore({ root: profiles.root });
      const coop = new CoopService({ root: profiles.root, principals, jobs: new JobStore({ root: profiles.root }), sessions: sessionStore, orchestrator });
      const split = value => (value === undefined ? [] : String(value).split(',').map(v => v.trim()).filter(Boolean));
      if (command === 'access recipient register') return coop.registerRecipient({ id: required('id'), kind: required('kind'), principalId: o.principal || null, endpoint: o.endpoint || null, secretFile: o['secret-file'] ? path.resolve(o['secret-file']) : null, socketPath: o.socket ? path.resolve(o.socket) : null, threadId: o.thread || null, taskRefs: split(o['task-refs']), sources: split(o.sources), types: split(o.types), label: o.label || null });
      if (command === 'access recipient list') return coop.listRecipients();
      if (command === 'access recipient revoke') return coop.revokeRecipient(required('id'));
      if (command === 'access coop store init') return coop.store.init();
      if (command === 'access coop store migrate') return coop.store.migrate({ fromV1: !!o['from-v1'], resume: !!o.resume });
      if (command === 'access coop store inspect') return coop.store.inspect();
      if (command === 'access coop deliveries') return { deliveries: await coop.pendingDeliveries() };
      if (command === 'access coop resolve') return coop.resolveDelivery({ eventId: required('event'), consumerId: required('consumer'), as: required('as'), note: o.note || null });
      if (command === 'access coop dispatch') {
        const dispatcher = new Dispatcher({ root: profiles.root, coop, principals, adapters: defaultAdapters({ grok: { allowHttpLoopback: !!o['allow-http-loopback'] } }) });
        if (o.once) return { results: await dispatcher.tick() };
        process.once('SIGINT', () => dispatcher.stop()); process.once('SIGTERM', () => dispatcher.stop());
        await dispatcher.run({ intervalMs: o['interval-ms'] === undefined ? 5000 : Number(o['interval-ms']) });
        return { stopped: true };
      }
      if (command === 'access observe') {
        const sessions = new SessionService({ root: profiles.root, principals, tmux: new Tmux({ socket: o['tmux-socket'] || null }) });
        const observer = new SessionObserver({ root: profiles.root, sessions, coop, intervalMs: o['interval-ms'] === undefined ? 5000 : Number(o['interval-ms']), log: entry => process.stderr.write(`${JSON.stringify(entry)}\n`) });
        if (o.once) return { results: await observer.tick() };
        process.once('SIGINT', () => observer.stop()); process.once('SIGTERM', () => observer.stop());
        await observer.run();
        return { stopped: true };
      }
      const principal = await principals.get(required('principal'));
      if (!principal) throw new OrchestratorError('principal_not_found', 'Principal does not exist.');
      const audit = new AccessAudit({ root: profiles.root });
      const tool = `coop_${command.slice('access coop '.length)}`;
      const startedAt = Date.now();
      try {
        let result;
        if (tool === 'coop_report') result = await coop.report(principal, { idempotencyKey: required('key'), type: required('type'), task: { ref: required('task') }, ...(o['payload-file'] ? { payload: await readProfile(o['payload-file']) } : {}), ...(o['evidence-file'] ? { evidenceRefs: await readProfile(o['evidence-file']) } : {}), conversationRef: o.conversation, correlationId: o.correlation, causationId: o.causation }, { via: 'cli' });
        else if (tool === 'coop_inbox') result = await coop.inbox(principal, { ...(o.cursor === undefined ? {} : { cursor: Number(o.cursor) }), ...(o['cursor-v2'] === undefined ? {} : { cursorV2: o['cursor-v2'] }), ...(o.limit === undefined ? {} : { limit: Number(o.limit) }) });
        else result = await coop.ack(principal, { eventId: required('event'), epoch: required('epoch') });
        await audit.record({ principalId: principal.id, transport: 'cli', tool, jobId: result?.event?.eventId || o.event || null, ok: true, durationMs: Date.now() - startedAt });
        return result;
      } catch (error) {
        await audit.record({ principalId: principal.id, transport: 'cli', tool, jobId: o.event || null, ok: false, code: error.code, durationMs: Date.now() - startedAt });
        throw error;
      }
    }
    case 'monitor status': return new MonitorManager({ root: profiles.root }).status(o.id || 'default');
    case 'monitor stop': return new MonitorManager({ root: profiles.root }).stop(o.id || 'default');
    case 'monitor snapshot': {
      const { MonitorCollector } = await import('../src/monitor/collector.mjs');
      return new MonitorCollector({ root: profiles.root, ...await monitorScope() }).snapshot();
    }
    case 'skill install': return installCaoSkill({ skillsDir: o['skills-dir'] });
    case 'skill status': return statusCaoSkill({ skillsDir: o['skills-dir'] });
    case 'skill uninstall': return uninstallCaoSkill({ skillsDir: o['skills-dir'] });
    case 'mode enable': return enableConversationMode({ stateRoot: profiles.root, thread: o.thread, project: o.project, agent: o.agent, profile: o.profile, maxParallel: o['max-parallel'], maxAttempts: o['max-attempts'], strategy: o.strategy, preference: o.preference, calibrationPolicy: o['calibration-policy'], probeBudgetMs: o['probe-budget-ms'] });
    case 'mode status': return statusConversationMode({ stateRoot: profiles.root, thread: o.thread });
    case 'mode disable': return disableConversationMode({ stateRoot: profiles.root, thread: o.thread });
    case 'source discover': return discoverCCSwitch({ directory: o.directory });
    case 'profile list': return { profiles: await profiles.list(), defaultProfileId: (await profiles.getDefault())?.id || null };
    case 'profile show': {
      const profile = await profiles.get(required('id'));
      if (!profile) throw new OrchestratorError('profile_not_found', 'Profile does not exist.');
      return profile;
    }
    case 'profile put': return profiles.put(await readProfile(required('file')), { ifRevision: o['if-revision'], makeDefault: !!o.default });
    case 'profile clone': return profiles.clone(required('id'), required('new-id'));
    case 'profile remove': return { id: required('id'), removed: await profiles.remove(o.id) };
    case 'profile default': {
      if (o.id && o.clear) throw new OrchestratorError('invalid_arguments', '--id and --clear are mutually exclusive.');
      if (o.clear || o.id) await profiles.setDefault(o.clear ? null : o.id);
      return { defaultProfileId: (await profiles.getDefault())?.id || null };
    }
    case 'profile export': {
      const exported = await profiles.export(required('id'));
      if (!o.file) return exported;
      await fs.writeFile(path.resolve(o.file), JSON.stringify(exported, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      return { exported: path.resolve(o.file), containsCredentialValues: false };
    }
    case 'profile import-cc-switch': return profiles.put(await importCCSwitchProfile({ directory: o.directory, providerId: required('provider'), app: required('app'), id: required('id'), model: o.model, allowShared: !!o['allow-shared'] }));
    case 'profile refresh': {
      const previous = await profiles.get(required('id'));
      if (!previous || previous.source.type !== 'cc-switch') throw new OrchestratorError('profile_not_external', 'Select an imported CC Switch profile.');
      const imported = await importCCSwitchProfile({ directory: previous.source.directory, providerId: previous.source.providerId, app: previous.source.app, id: previous.id, model: o.model, allowShared: previous.source.allowShared });
      return profiles.put({
        ...imported,
        name: previous.name,
        enabled: previous.enabled,
        capabilities: previous.capabilities,
        priority: previous.priority,
        account: previous.account,
        quota: previous.quota,
        quality: previous.quality,
        speed: previous.speed,
        costPerMillion: previous.costPerMillion,
        modelMap: previous.modelMap,
        fallbacks: previous.fallbacks,
        ...(previous.modelMetadata ? { modelMetadata: previous.modelMetadata } : {}),
      }, { ifRevision: previous.revision });
    }
    case 'secret set': {
      const id = required('id');
      if (!o.stdin || process.stdin.isTTY) throw new OrchestratorError('invalid_arguments', 'Pipe the secret on stdin and pass --stdin; never put secret values in command arguments.');
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) { size += chunk.length; if (size > 65536) throw new OrchestratorError('invalid_secret', 'Secret exceeds 64 KiB.'); chunks.push(chunk); }
      const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
      return { ref: await profiles.putSecret(id, value), stored: true };
    }
    case 'secret remove': await profiles.removeSecret(required('id')); return { id: o.id, removed: true };
    case 'route explain': {
      const task = validateTask(await readProfile(required('file')));
      if (task.execution?.native) return { selectedProfileId: null, mode: 'explicit-native-config', agent: task.agent };
      const defaultProfile = task.execution ? null : await profiles.getDefault();
      const selector = task.execution || (defaultProfile ? { profile: defaultProfile.id } : null);
      if (!selector) return { selectedProfileId: null, mode: 'inherited-agent-config', agent: task.agent };
      return explainRoute(profiles, selector, { agent: task.agent === 'auto' ? null : task.agent });
    }
    case 'route reservations': return { reservations: await listReservations(profiles.root), scope: 'HarnessOrbit attempts' };
    case 'gateway start': {
      const primary = await profiles.resolve(required('profile'));
      return gateways.start({ id: o.id, profileIds: [primary.id, ...primary.fallbacks], allowShared: !!o['allow-shared'] });
    }
    case 'gateway status': return gateways.status(required('id'));
    case 'gateway stop': return gateways.stop(required('id'));
    case 'gateway list': return gateways.list();
    case 'init': return orchestrator.init({ project: required('project'), id: o.id, maxParallel: Number(o['max-parallel'] || 4) });
    case 'preflight': return orchestrator.preflight(required('run'), JSON.parse(await read(required('file'))));
    case 'performance report': return orchestrator.performance(required('run'));
    case 'step': return new Supervisor({ orchestrator }).step(required('run'), { integrate: !!o.integrate, repairReports: !!o['repair-reports'] });
    case 'supervise': return new Supervisor({ orchestrator }).supervise(required('run'), {
      integrate: !!o.integrate, repairReports: !!o['repair-reports'],
      waitMs: o['wait-ms'] === undefined ? 30000 : Number(o['wait-ms']), pollMs: o['poll-ms'] === undefined ? 1000 : Number(o['poll-ms']),
    });
    case 'result submit': {
      if (Boolean(o.file) === Boolean(o.stdin)) throw new OrchestratorError('invalid_arguments', 'Supply exactly one of --file or --stdin.');
      const chunks = []; let size = 0;
      if (o.stdin) {
        if (process.stdin.isTTY) throw new OrchestratorError('invalid_arguments', 'Pipe the report on stdin.');
        for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_RESULT_BYTES) throw new OrchestratorError('invalid_result', 'Result exceeds 128 KiB.'); chunks.push(chunk); }
      } else {
        const info = await fs.lstat(path.resolve(o.file));
        if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RESULT_BYTES) throw new OrchestratorError('invalid_result', 'Report must be a regular file of at most 128 KiB.');
        chunks.push(await fs.readFile(path.resolve(o.file)));
      }
      let report;
      try { report = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new OrchestratorError('invalid_result', 'Report is not valid JSON.'); }
      return submitResult(required('attempt-dir'), report);
    }
    case 'validate': return validateTask(JSON.parse(await read(required('file'))));
    case 'dispatch': {
      const input = JSON.parse(await read(required('file')));
      const thread = resolveThreadId(o.thread);
      const mode = await statusConversationMode({ stateRoot: profiles.root, thread });
      if (!o.adaptive && !(mode.enabled && mode.strategy === 'adaptive')) {
        if (o.resources || o.executor || o.preference || o['calibration-policy'] || o['probe-budget-ms']) throw new OrchestratorError('invalid_arguments', 'Routing options require --adaptive or an enabled adaptive conversation.');
        return orchestrator.dispatch(required('run'), input);
      }
      const fixedAgent = mode.enabled && o.executor !== 'host' && mode.agent !== 'auto' ? mode.agent : null;
      return new AdaptiveDispatcher({
        orchestrator,
        decisionProvider: configuredDecisionProvider(),
        decisionMode: process.env.CAO_DECISION_MODE === 'online' ? 'online' : 'shadow',
      }).dispatch(required('run'), input, {
        thread, preference: o.preference || mode.preference, fixedExecutorKind: o.executor,
        calibrationPolicy: o['calibration-policy'] || (mode.enabled ? mode.calibrationPolicy : 'off'),
        probeBudgetMs: o['probe-budget-ms'] === undefined ? (mode.enabled ? mode.probeBudgetMs : 30000) : Number(o['probe-budget-ms']),
        ...(o.resources === undefined ? {} : { allowedResourceIds: o.resources.split(',') }),
        fixedProfileId: mode.enabled && o.executor !== 'host' ? mode.profile : null, fixedAgent,
      });
    }
    case 'status': return orchestrator.status(o.run);
    case 'inspect': return orchestrator.inspect(...taskArgs(), { output: !!o.output });
    case 'collect': return orchestrator.collect(...taskArgs(), { waitMs: Number(o['wait-ms'] || 0) });
    case 'verify': return orchestrator.verify(...taskArgs());
    case 'retry': return orchestrator.retry(...taskArgs(), o['feedback-file'] ? await read(o['feedback-file']) : '');
    case 'resume': return orchestrator.resume(...taskArgs());
    case 'input': return orchestrator.input(...taskArgs(), { keys: o.keys?.split(','), text: o['text-file'] ? await read(o['text-file']) : undefined });
    case 'integrate': return orchestrator.integrate(...taskArgs());
    case 'recover': return orchestrator.recover(...taskArgs());
    case 'cancel': return orchestrator.cancel(...taskArgs());
    case 'cleanup': return orchestrator.cleanup(required('run'));
    case 'harness init': {
      const project = path.resolve(required('project'));
      const includePaths = o['include-paths'] ? o['include-paths'].split(',').map(value => value.trim()).filter(Boolean) : [];
      return initProjectLedger({ root: profiles.root, project, includePaths, runId: o.run || null });
    }
    case 'harness context': {
      const project = path.resolve(required('project'));
      const includePaths = o['include-paths'] ? o['include-paths'].split(',').map(value => value.trim()).filter(Boolean) : [];
      return createContextPacket({ project, includePaths, runId: o.run || null });
    }
    case 'harness ledger': {
      const project = path.resolve(required('project'));
      return new ProjectLedger({ root: profiles.root, project }).load();
    }
    case 'harness workflow': {
      const run = await loadRun(profiles.root, required('run'));
      if (!run) throw new OrchestratorError('run_not_found', 'Harness workflow run does not exist.');
      const contextPacket = createContextPacket({ project: run.project, runId: run.id });
      const report = new WorkflowRegistry().evaluate(o.id || 'release-readiness', { run, contextPacket });
      const ledger = new ProjectLedger({ root: profiles.root, project: run.project });
      try {
        await ledger.recordEvidence({
          type: 'workflow.outcome',
          status: report.projectAcceptance,
          digest: report.reportDigest,
          runId: run.id,
          references: report.evidence.references,
        });
        return { ...report, ledgerEvidenceIncomplete: false };
      } catch (error) {
        if (error?.code !== 'ledger_full') throw error;
        return { ...report, ledgerEvidenceIncomplete: true, ledgerEvidenceStatus: 'ledger_full' };
      }
    }
    case 'harness benchmark': {
      const report = runInternalBenchmark({ plan: createInternalBenchmarkPlan() });
      if (o.output) {
        const file = path.resolve(o.output);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
      }
      return report;
    }
    case 'harness replay': {
      const traces = JSON.parse(await read(required('file')));
      return replayShadowTraces({ traces: Array.isArray(traces) ? traces : traces.traces, provider: new DeterministicDecisionProvider() });
    }
    case 'usage': {
      if (o.table && o.json) throw new OrchestratorError('invalid_arguments', '--table and --json are mutually exclusive.');
      if (o['tokscale-bin'] !== undefined && !o['tokscale-bin']) throw new OrchestratorError('invalid_arguments', '--tokscale-bin must identify an executable.');
      const service = new UsageService({ stateRoot: o['state-dir'], tokscale: new Tokscale({ binary: o['tokscale-bin'] || process.env.CAO_TOKSCALE_BIN || 'tokscale' }) });
      const report = await service.query({ agent: o.agent, model: o.model, today: o.today, since: o.since, until: o.until, run: o.run, task: o.task, home: o.home });
      return o.table ? { usageTable: formatUsageTable(report) } : report;
    }
    case 'doctor': {
      const tools = {};
      for (const name of ['node', 'git', 'herdr', 'claude', 'pi', 'opencode', 'codex', 'tokscale']) {
        try { const r = await runCommand([name === 'tokscale' ? process.env.CAO_TOKSCALE_BIN || name : name, '--version'], { timeoutMs: 10000 }); tools[name] = { available: r.code === 0, version: r.stdout.trim() || r.stderr.trim() }; }
        catch (error) { tools[name] = { available: false, error: error.code || 'error' }; }
      }
      let hasCompletedOnboarding = null;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf8'));
        hasCompletedOnboarding = raw?.hasCompletedOnboarding === true;
      } catch {
        hasCompletedOnboarding = null;
      }
      return {
        tools, capabilities, tokenUsage: { backend: 'tokscale', optional: true, testedVersion: '4.16.0' },
        claudeOnboarding: { hasCompletedOnboarding, advisory: true },
        note: 'Native child reporting is a contract, not verified telemetry or a hard concurrency limit. claudeOnboarding is advisory and does not gate dispatch.',
      };
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(data => {
    if (data?.help) process.stdout.write(data.help);
    else if (data?.usageTable) process.stdout.write(data.usageTable);
    else process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: error.code || 'error', message: error.message, details: error.details || {} } }, null, 2)}\n`);
    process.exitCode = error.code === 'invalid_arguments' ? 2 : 1;
  });
}
