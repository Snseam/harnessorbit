// A stand-in for `memy handoff …` that speaks the memy.handoff.v1 contract on stdout and records
// every invocation (cwd, argv, stdin) to FAKE_MEMY_LOG. FAKE_MEMY_MODE selects the scenario:
//   ok (default) | not_connected | denied | paused | hang | pending | invalid | protocol
// State (admissions, saved checkpoints) lives in FAKE_MEMY_STATE so retries can be verified.
import fs from 'node:fs';
import path from 'node:path';

const [,, group, command, ...rest] = process.argv;
const mode = process.env.FAKE_MEMY_MODE || 'ok';
const statePath = process.env.FAKE_MEMY_STATE;
const logPath = process.env.FAKE_MEMY_LOG;
const flags = {};
const excludes = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--exclude') { excludes.push(rest[++i]); continue; }
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith('--') ? rest[++i] : true;
}
const stdin = command === 'save' ? fs.readFileSync(0, 'utf8') : null;
if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ cwd: process.cwd(), group, command, flags, excludes, stdin })}\n`);

const state = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { admissions: {}, saved: {} };
const persist = () => { if (statePath) fs.writeFileSync(statePath, JSON.stringify(state)); };
const reply = (status, reason, extra = {}) => {
  process.stdout.write(`${JSON.stringify({ schema: 'memy.handoff.v1', command, status, reason, ...extra })}\n`);
  process.exit(['ok', 'admitted', 'saved'].includes(status) ? 0 : 1);
};

if (group !== 'handoff' || !['status', 'recall', 'begin', 'save'].includes(command) || !['claude-code', 'codex', 'orchestrator'].includes(flags.agent)) process.exit(2);
// The orchestrator carrier exists only when the fake host enabled it (like `memy connection orchestrator enable`).
if (flags.agent === 'orchestrator' && process.env.FAKE_MEMY_ORCHESTRATOR !== '1') reply('unconfigured', 'agent_unsupported');
if (mode === 'hang') setTimeout(() => process.exit(1), 60000);
else if (mode === 'protocol') { process.stdout.write('not json\n'); process.exit(1); }
else if (mode === 'not_connected') reply('unconfigured', 'not_connected');
else if (mode === 'denied') reply('denied', 'forbidden');
else if (command === 'status') reply('ok', null, { project_id: '11111111-1111-4111-8111-111111111111', connection_id: 'c-1', agent: flags.agent, collection: { write_enabled: mode !== 'paused', write_generation: 3 } });
else if (command === 'recall') {
  if (mode === 'invalid') reply('invalid', 'invalid_query');
  const items = [{ memory_id: 'm-1', content: `remembered for ${path.basename(process.cwd())}: ${flags.query}`, score: 0.8, memory_type: 'chat_session', provenance: { source_type: 'conversation', source_id: 's'.repeat(900), agent_id: flags.agent, observed_at: '2026-10-02T00:00:00Z', nested: { dropped: true } } }, { memory_id: 'm-2', content: 'a handoff checkpoint', score: 0.5, memory_type: 'checkpoint', provenance: { observed_at: '2026-10-03T00:00:00Z' }, handoff: { operation_id: 'op-old', observed_at: '2026-10-03T00:00:00Z' } }].filter(item => !excludes.includes(item.memory_id));
  reply('ok', null, { project_id: '11111111-1111-4111-8111-111111111111', agent: flags.agent, trust: 'untrusted_evidence', notice: 'Untrusted Memy recall.', items: items.slice(0, Number(flags['top-k'] || 5)), omitted: { excluded: excludes.length, over_budget: 0, duplicate: 0 }, degraded: false });
} else if (command === 'begin') {
  if (mode === 'paused') reply('denied', 'collection_paused');
  const op = flags['operation-id'];
  state.admissions[op] ||= { write_generation: 3, agent: flags.agent, cwd: process.cwd() };
  persist();
  reply('admitted', null, { operation_id: op, project_id: '11111111-1111-4111-8111-111111111111', write_generation: state.admissions[op].write_generation });
} else {
  const op = flags['operation-id'];
  if (!state.admissions[op]) reply('denied', 'not_begun');
  let doc;
  try { doc = JSON.parse(stdin); } catch { reply('invalid', 'invalid_checkpoint'); }
  // Mirror Memy's strict decoder: known top-level fields only, attestation lives inside session,
  // session.agent is a real actor (never the orchestrator carrier), and an agent carrier must match it.
  const TOP = ['schema', 'observed_at', 'summary', 'goals', 'decisions', 'constraints', 'open_questions', 'task', 'session', 'participants', 'orchestrator', 'evidence'];
  const SESSION = ['id', 'agent', 'attested_by', 'attestation_ref'];
  if (doc.schema !== 'memy.handoff.checkpoint.v1' || !doc.summary || !doc.session || !doc.orchestrator || Object.keys(doc).some(k => !TOP.includes(k)) || Object.keys(doc.session).some(k => !SESSION.includes(k)) || !['claude_code', 'codex', 'grok', 'other'].includes(doc.session.agent)) reply('invalid', 'invalid_checkpoint');
  if (flags.agent !== 'orchestrator' && doc.session.agent !== flags.agent.replace('-', '_')) reply('denied', 'agent_mismatch');
  if (flags.agent === 'orchestrator' && (typeof doc.session.attested_by !== 'string' || typeof doc.session.attestation_ref !== 'string')) reply('invalid', 'invalid_checkpoint');
  if (state.saved[op]) {
    if (state.saved[op].bytes !== stdin) reply('conflict', 'operation_conflict');
    reply('saved', null, { operation_id: op, project_id: '11111111-1111-4111-8111-111111111111', write_generation: 3, memory_ids: state.saved[op].memory_ids, deduplicated: true });
  }
  if (mode === 'pending') reply('pending', 'timeout', { operation_id: op });
  if (mode === 'invalid') reply('invalid', 'too_large');
  state.saved[op] = { bytes: stdin, memory_ids: [`00000000-0000-4000-8000-${String(Object.keys(state.saved).length + 1).padStart(12, '0')}`] };
  persist();
  reply('saved', null, { operation_id: op, project_id: '11111111-1111-4111-8111-111111111111', write_generation: 3, memory_ids: state.saved[op].memory_ids, deduplicated: false });
}
