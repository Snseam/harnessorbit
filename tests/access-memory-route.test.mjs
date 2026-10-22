import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Orchestrator } from '../src/orchestrator.mjs';
import { PrincipalStore } from '../src/access/principals.mjs';
import { AccessService } from '../src/access/service.mjs';
import { SessionStore } from '../src/access/sessions.mjs';
import { MemoryService, MemoryRouteStore, MemyHandoffCliProvider, uuidFromOperationId } from '../src/access/memory.mjs';
import { startAccessServer } from '../src/access/server.mjs';
import { parseArgs } from '../bin/cao.mjs';
import { fixture, FakeHerdr } from './helpers.mjs';

// Fixture evidence for operator provider routing: a fake command runner stands in for the Memy
// CLI and records every exact argv, cwd and stdin. No container, no real Memy, no network.

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_DEFAULT = '33333333-3333-4333-8333-333333333333';
const checks = [{ name: 'math', argv: [process.execPath, '--test', 'tests/math.test.mjs'], timeoutMs: 10000 }];
const job = (project, extra = {}) => ({ idempotencyKey: 'req-1', project, objective: 'Fix add to add its two inputs; preserve the existing tests.', context: 'Tests already encode the expected behaviour.', allowedPaths: ['src/math.mjs'], checks, ...extra });
const body = () => ({ summary: 'add() now adds; tests pass on the host.', goals: ['Make add() add its inputs'], decisions: ['No new dependencies'], constraints: ['Do not touch tests'], openQuestions: [] });
const envelope = (sub, fields) => ({ schema: 'memy.handoff.v1', command: sub, ...fields });

// The fake CLI answers per the handoff contract; which Project it "is" depends on the argv prefix.
function fakeCommand(projectFor = () => PROJECT_DEFAULT) {
  const calls = []; const hooks = { onSave: null, saveMode: 'ok', recall: null };
  const fn = async (argv, opts) => {
    const at = argv.indexOf('handoff'); const sub = argv[at + 1]; const prefix = argv.slice(0, at);
    const value = flag => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
    const call = { argv, cwd: opts.cwd, input: opts.input ?? null, sub, prefix, expect: value('--expect-project'), operationId: value('--operation-id') };
    calls.push(call);
    const project = projectFor(prefix, call);
    if (sub === 'save' && hooks.saveMode === 'hang') return new Promise(() => {});
    if (sub === 'save' && hooks.onSave) await hooks.onSave(call);
    const out = sub === 'status' ? envelope('status', { status: 'ok', project_id: project, collection: { write_enabled: true, write_generation: 1 } })
      : sub === 'recall' ? (hooks.recall ? hooks.recall(envelope('recall', { status: 'ok', project_id: project, items: [] }), call) : envelope('recall', { status: 'ok', project_id: project, items: [] }))
        : sub === 'begin' ? envelope('begin', { status: 'admitted', operation_id: call.operationId, project_id: project, write_generation: 1 })
          : envelope('save', { status: 'saved', operation_id: call.operationId, project_id: project, write_generation: 1, memory_ids: [crypto.randomUUID()], deduplicated: false });
    return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '' };
  };
  fn.calls = calls; fn.hooks = hooks; return fn;
}

async function setup(t, { projectFor } = {}) {
  const f = await fixture(); t.after(f.remove);
  f.project = await fs.realpath(f.project);
  f.project2 = path.join(f.base, 'p2'); await fs.mkdir(path.join(f.project2, 'src'), { recursive: true }); await fs.mkdir(path.join(f.project2, 'tests'));
  await fs.writeFile(path.join(f.project2, 'src/math.mjs'), 'export const add = (a, b) => a - b;\n');
  await fs.writeFile(path.join(f.project2, 'tests/math.test.mjs'), "import { test } from 'node:test';\ntest('t', () => {});\n");
  const git = args => execFileSync('git', ['-C', f.project2, ...args], { stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=CAO Test', '-c', 'user.email=cao@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'second fixture project']);
  f.project2 = await fs.realpath(f.project2);
  const orchestrator = new Orchestrator({ stateRoot: f.stateRoot, herdr: new FakeHerdr() });
  const principals = new PrincipalStore({ root: f.stateRoot });
  const { principal, token } = await principals.create({ id: 'grok', projects: [f.project, f.project2], agents: ['claude', 'codex'], permissions: { sessions: true }, kind: 'grok' });
  const access = new AccessService({ root: f.stateRoot, orchestrator, principals, driver: 'inline' });
  const sessions = new SessionStore({ root: f.stateRoot });
  const command = fakeCommand(projectFor || (prefix => prefix[0] === 'docker' ? (prefix.includes('ctr-a') ? PROJECT_A : PROJECT_B) : PROJECT_DEFAULT));
  const provider = new MemyHandoffCliProvider({ argv: ['memy'], timeoutMs: 800, command });
  const memory = new MemoryService({ root: f.stateRoot, provider, principals, sessions, jobs: access.jobs, orchestrator, timeoutMs: 800 });
  const jobA = (await access.submit(principal, job(f.project))).job.id;
  const jobB = (await access.submit(principal, job(f.project2, { idempotencyKey: 'req-2' }))).job.id;
  const routes = memory.routes;
  const argvA = ['docker', '--host', 'unix:///var/run/docker.sock', 'exec', '-i', '--workdir', '/home/memy/YProgram/provider A', 'ctr-a', 'memy'];
  const argvB = ['docker', 'exec', '-i', '--workdir', '/home/memy/YProgram/provider-b', 'ctr-b', 'memy'];
  const routesFile = path.join(f.stateRoot, 'access', 'memory', 'routes.json');
  const pendingFile = op => path.join(f.stateRoot, 'access', 'memory', 'pending', `${crypto.createHash('sha256').update(op).digest('hex')}.json`);
  const admissionFile = op => path.join(f.stateRoot, 'access', 'memory', 'admissions', `${crypto.createHash('sha256').update(op).digest('hex')}.json`);
  return { ...f, principals, principal, token, access, sessions, memory, provider, command, routes, jobA, jobB, argvA, argvB, routesFile, pendingFile, admissionFile, orchestrator };
}

test('two host projects route to two exact argv prefixes with their own expected Project; an unmapped project keeps the same-machine default; stdin and cwd are unchanged', async t => {
  const { memory, principal, project, project2, jobA, jobB, routes, argvA, argvB, command } = await setup(t);
  const a = await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/home/memy/YProgram/provider A', expectedProjectId: PROJECT_A, label: 'A' });
  const b = await routes.bind({ hostProject: project2, argv: argvB, providerCheckout: '/home/memy/YProgram/provider-b', expectedProjectId: PROJECT_B });
  assert.equal(a.revision, 1); assert.equal(b.revision, 1); assert.notEqual(a.routeId, b.routeId);
  // Recall, begin and save on A.
  const recall = await memory.recall(principal, { jobId: jobA, question: 'what was decided?' });
  assert.equal(recall.status, 'ok'); assert.deepEqual(recall.route, { routeId: a.routeId, revision: 1, expectedProjectId: PROJECT_A });
  const begun = await memory.begin(principal, { jobId: jobA, operationId: 'op-a' });
  assert.equal(begun.status, 'admitted'); assert.equal(begun.route.routeId, a.routeId);
  const saved = await memory.checkpoint(principal, { jobId: jobA, operationId: 'op-a', ...body() });
  assert.equal(saved.status, 'saved');
  for (const call of command.calls) {
    assert.deepEqual(call.prefix, argvA, 'exact tokens, including the one with a space');
    assert.equal(call.expect, PROJECT_A, '--expect-project carries the trusted route value');
    assert.equal(call.cwd, project);
    assert.equal(call.argv.indexOf('--expect-project') < call.argv.indexOf('--timeout-ms'), true);
  }
  const saveA = command.calls.find(c => c.sub === 'save');
  assert.ok(saveA.input.endsWith('\n')); const docA = JSON.parse(saveA.input);
  assert.equal(docA.schema, 'memy.handoff.checkpoint.v1'); assert.equal(docA.summary, body().summary);
  assert.ok(!saveA.argv.some(tok => /docker|ctr-a/.test(tok) && saveA.argv.indexOf(tok) >= saveA.argv.indexOf('handoff')), 'route tokens appear only in the prefix');
  // B gets its own prefix and Project.
  command.calls.length = 0;
  assert.equal((await memory.begin(principal, { jobId: jobB, operationId: 'op-b' })).status, 'admitted');
  assert.equal((await memory.checkpoint(principal, { jobId: jobB, operationId: 'op-b', ...body() })).status, 'saved');
  for (const call of command.calls) { assert.deepEqual(call.prefix, argvB); assert.equal(call.expect, PROJECT_B); assert.equal(call.cwd, project2); }
  // Unmapped: a third project uses the default argv and no --expect-project; stdin identical in shape.
  const { memory: m2, principal: p2, jobA: j2, command: c2 } = await setup(t);
  assert.equal((await m2.begin(p2, { jobId: j2, operationId: 'op-d' })).route, null);
  assert.equal((await m2.checkpoint(p2, { jobId: j2, operationId: 'op-d', ...body() })).status, 'saved');
  for (const call of c2.calls) { assert.deepEqual(call.prefix, ['memy']); assert.equal(call.expect, null); assert.ok(!call.argv.includes('--expect-project')); }
  const saveD = c2.calls.find(c => c.sub === 'save');
  assert.deepEqual(Object.keys(JSON.parse(saveD.input)), Object.keys(docA), 'the same document shape and field order on both paths');
  assert.ok(!JSON.stringify(begun).includes('docker') && !JSON.stringify(recall).includes('docker') && !JSON.stringify(saved).includes('docker'), 'no argv in any tool response');
});

test('a disabled route never falls back to the default; a malformed or unreadable store fails every project closed, never as unmapped; an invalid record is refused', async t => {
  const { memory, principal, project, project2, jobA, jobB, routes, argvA, command, routesFile } = await setup(t);
  await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  const unbound = await routes.unbind({ hostProject: project });
  assert.equal(unbound.enabled, false); assert.equal(unbound.revision, 1); assert.ok(unbound.disabledAt);
  for (const call of [() => memory.recall(principal, { jobId: jobA, question: 'what was decided?' }), () => memory.begin(principal, { jobId: jobA, operationId: 'op-x' })]) {
    await assert.rejects(call(), e => e.code === 'memory_route_disabled');
  }
  await assert.rejects(memory.checkpoint(principal, { jobId: jobA, operationId: 'op-x', ...body() }), e => e.code === 'not_begun', 'never admitted: refused before any route is consulted');
  assert.equal(command.calls.length, 0, 'nothing spawned for a disabled route');
  assert.equal((await memory.begin(principal, { jobId: jobB, operationId: 'op-y' })).route, null, 'another, unmapped project is unaffected by the disabled one');
  // Rebind after unbind: a fresh routeId and revision 2 even with identical content.
  const rebound = await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  assert.equal(rebound.revision, 2); assert.notEqual(rebound.routeId, unbound.routeId); assert.equal(rebound.enabled, true);
  // Malformed store: every memory operation refuses, including the unmapped project.
  const good = await fs.readFile(routesFile);
  await fs.writeFile(routesFile, '{not json');
  await assert.rejects(memory.recall(principal, { jobId: jobA, question: 'what was decided?' }), e => e.code === 'memory_route_store_invalid');
  await assert.rejects(memory.begin(principal, { jobId: jobB, operationId: 'op-z' }), e => e.code === 'memory_route_store_invalid', 'a parse failure is never "unmapped"');
  await assert.rejects(routes.list(), e => e.code === 'memory_route_store_invalid');
  await fs.writeFile(routesFile, JSON.stringify({ schemaVersion: 99, routes: {} }));
  await assert.rejects(memory.begin(principal, { jobId: jobB, operationId: 'op-z' }), e => e.code === 'memory_route_store_invalid');
  // Invalid record for one project: that project refuses; others continue.
  const doc = JSON.parse(good.toString());
  doc.routes[project].argv = [];
  await fs.writeFile(routesFile, JSON.stringify(doc));
  await assert.rejects(memory.begin(principal, { jobId: jobA, operationId: 'op-z' }), e => e.code === 'memory_route_invalid');
  assert.equal((await memory.begin(principal, { jobId: jobB, operationId: 'op-z2' })).status, 'admitted');
  await fs.writeFile(routesFile, good);
  // Absent store is the plain default.
  await fs.unlink(routesFile);
  assert.equal((await memory.begin(principal, { jobId: jobA, operationId: 'op-default' })).route, null);
});

test('a provider answering for another Project is refused before any admission or save is recorded', async t => {
  const { memory, principal, project, jobA, routes, argvA, admissionFile, command } = await setup(t, { projectFor: () => PROJECT_B });
  await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  const recall = await memory.recall(principal, { jobId: jobA, question: 'what was decided?' });
  assert.equal(recall.status, 'denied'); assert.equal(recall.reason, 'project_mismatch'); assert.deepEqual(recall.items, []);
  const begun = await memory.begin(principal, { jobId: jobA, operationId: 'op-m' });
  assert.equal(begun.status, 'denied'); assert.equal(begun.reason, 'project_mismatch');
  assert.equal(await fs.readFile(admissionFile('op-m'), 'utf8').catch(e => e.code), 'ENOENT', 'no admission file');
  await assert.rejects(memory.checkpoint(principal, { jobId: jobA, operationId: 'op-m', ...body() }), e => e.code === 'not_begun');
  assert.ok(command.calls.every(c => c.expect === PROJECT_A), 'Memy’s own --expect-project was passed on every call');
});

test('bots cannot route: the MCP memory tools refuse route fields and nothing in a request can name an executable or Project', async t => {
  const { memory, access, token, jobA, command } = await setup(t);
  const server = await startAccessServer({ service: access, memory, port: 0 }); t.after(() => server.close());
  const call = async (name, args) => (await (await fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).json());
  // Request fields naming an executable, a route or a Project have no effect: the server passes only
  // the documented fields on, the route comes from the operator store (here: none), and the default
  // argv is what runs. Nothing a bot sends reaches the command line.
  let n = 0;
  for (const extra of [{ argv: ['sh', '-c', 'id'] }, { route: { argv: ['x'] } }, { expectProject: PROJECT_A }, { hostProject: '/tmp' }]) {
    const r = await call('memory_begin', { jobId: jobA, operationId: `op-bot-${n++}`, ...extra });
    const parsed = r.result?.isError ? null : JSON.parse(r.result.content[0].text);
    assert.ok(parsed, `the call is answered normally for ${Object.keys(extra)[0]}`);
    assert.equal(parsed.route, null); assert.equal(parsed.status, 'admitted');
  }
  for (const c of command.calls) { assert.deepEqual(c.prefix, ['memy']); assert.ok(!c.argv.includes('sh') && !c.argv.includes('--expect-project') && !c.argv.includes('/tmp')); }
  const tools = (await (await fetch(server.endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })).json()).result.tools;
  assert.ok(!tools.some(tl => /route/.test(tl.name)), 'no route tool is exposed');
  for (const tl of tools.filter(x => x.name.startsWith('memory_'))) assert.equal(tl.inputSchema.additionalProperties, false);
});

test('frozen operations: a rebind (same content, new revision), an unbind, or a mapping introduced over a default admission refuse the retry before any save, leaving pending bytes unchanged; a new operation proceeds under the new revision', async t => {
  const { memory, principal, project, project2, jobA, jobB, routes, argvA, argvB, command, pendingFile, admissionFile } = await setup(t);
  const first = await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  assert.equal((await memory.begin(principal, { jobId: jobA, operationId: 'op-f' })).status, 'admitted');
  assert.deepEqual(JSON.parse(await fs.readFile(admissionFile('op-f'), 'utf8')).route, { routeId: first.routeId, revision: 1, expectedProjectId: PROJECT_A, argvHash: MemoryRouteStore.argvHash(argvA) });
  command.hooks.saveMode = 'hang';
  const pendingResult = await memory.checkpoint(principal, { jobId: jobA, operationId: 'op-f', ...body() });
  assert.equal(pendingResult.status, 'pending');
  const pendingBytes = await fs.readFile(pendingFile('op-f'));
  const callsBefore = command.calls.length;
  command.hooks.saveMode = 'ok';
  // Rebind with identical content: revision 2; the frozen operation is refused, not rerouted.
  const second = await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  assert.equal(second.revision, 2); assert.notEqual(second.routeId, first.routeId);
  await assert.rejects(memory.checkpoint(principal, { jobId: jobA, operationId: 'op-f' }), e => e.code === 'memory_route_changed' && e.details.frozen.revision === 1 && e.details.current.revision === 2);
  await assert.rejects(memory.begin(principal, { jobId: jobA, operationId: 'op-f' }), e => e.code === 'memory_route_changed', 'a repeat begin is refused too');
  assert.ok(Buffer.compare(await fs.readFile(pendingFile('op-f')), pendingBytes) === 0, 'pending bytes unchanged');
  assert.equal(command.calls.length, callsBefore, 'nothing spawned');
  // Unbind: still refused (and the project itself is now disabled for new work).
  await routes.unbind({ hostProject: project });
  await assert.rejects(memory.checkpoint(principal, { jobId: jobA, operationId: 'op-f' }), e => e.code === 'memory_route_changed');
  await assert.rejects(memory.begin(principal, { jobId: jobA, operationId: 'op-new' }), e => e.code === 'memory_route_disabled');
  // A new operation under the current revision proceeds.
  const third = await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  assert.equal(third.revision, 3);
  assert.equal((await memory.begin(principal, { jobId: jobA, operationId: 'op-g' })).route.revision, 3);
  assert.equal((await memory.checkpoint(principal, { jobId: jobA, operationId: 'op-g', ...body() })).status, 'saved');
  assert.ok(Buffer.compare(await fs.readFile(pendingFile('op-f')), pendingBytes) === 0, 'the old pending operation is still exactly where it was');
  // A mapping introduced over a default (unmapped) admission cannot take it over.
  assert.equal((await memory.begin(principal, { jobId: jobB, operationId: 'op-h' })).route, null);
  await routes.bind({ hostProject: project2, argv: argvB, providerCheckout: '/y', expectedProjectId: PROJECT_B });
  await assert.rejects(memory.checkpoint(principal, { jobId: jobB, operationId: 'op-h', ...body() }), e => e.code === 'memory_route_changed' && e.details.frozen === null);
  assert.equal(await fs.readFile(pendingFile('op-h'), 'utf8').catch(e => e.code), 'ENOENT', 'no pending record was created for the refused first save');
  // Legacy admission without a route field behaves as default: unmapped project continues; mapped project refuses.
  const { memory: m2, principal: p2, jobA: j2, admissionFile: af2 } = await setup(t);
  assert.equal((await m2.begin(p2, { jobId: j2, operationId: 'op-legacy' })).status, 'admitted');
  const legacy = JSON.parse(await fs.readFile(af2('op-legacy'), 'utf8')); delete legacy.route; await fs.writeFile(af2('op-legacy'), JSON.stringify(legacy));
  assert.equal((await m2.checkpoint(p2, { jobId: j2, operationId: 'op-legacy', ...body() })).status, 'saved');
});

test('invocation gate ordering: an admitted call finishes on its frozen provider while a bind waits; after the bind lands, later calls use the new revision and the old frozen operation is refused', async t => {
  const { memory, principal, project, jobA, routes, argvA, command } = await setup(t);
  const first = await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  assert.equal((await memory.begin(principal, { jobId: jobA, operationId: 'op-race' })).status, 'admitted');
  let release; const gate = new Promise(r => { release = r; }); let saveStarted; const started = new Promise(r => { saveStarted = r; });
  command.hooks.onSave = async () => { saveStarted(); await gate; };
  const saving = memory.checkpoint(principal, { jobId: jobA, operationId: 'op-race', ...body() });
  await started; // the provider call is in flight under the project gate
  let bindDone = false;
  const binding = routes.bind({ hostProject: project, argv: [...argvA, '--extra'], providerCheckout: '/x', expectedProjectId: PROJECT_A }).then(r => { bindDone = true; return r; });
  await new Promise(r => setTimeout(r, 150));
  assert.equal(bindDone, false, 'the bind waits for the admitted call');
  release();
  const saved = await saving;
  assert.equal(saved.status, 'saved'); assert.deepEqual(command.calls.find(c => c.sub === 'save').prefix, argvA, 'the in-flight call finished on its frozen argv');
  const rebound = await binding;
  assert.equal(rebound.revision, 2); assert.equal(bindDone, true);
  command.hooks.onSave = null;
  // After the mutation: a replay of the saved operation is refused (no silent move), a new operation uses the new argv.
  await assert.rejects(memory.checkpoint(principal, { jobId: jobA, operationId: 'op-race' }), e => e.code === 'memory_route_changed');
  command.calls.length = 0;
  assert.equal((await memory.begin(principal, { jobId: jobA, operationId: 'op-after' })).route.revision, 2);
  assert.deepEqual(command.calls[0].prefix, [...argvA, '--extra']);
  // A bind landing between begin and checkpoint (between subcalls) is caught before the save.
  await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  await assert.rejects(memory.checkpoint(principal, { jobId: jobA, operationId: 'op-after', ...body() }), e => e.code === 'memory_route_changed');
  assert.ok(!command.calls.some(c => c.sub === 'save'), 'no save was launched for the refused operation');
  void first;
});

test('operator CLI: bind, unbind, list and show parse; --argv-json and --argv-file give identical records; list never shows argv; bind refuses a missing directory, an invalid Project and an empty argv', async t => {
  const { routes, project, base, argvA } = await setup(t);
  assert.deepEqual(parseArgs(['access', 'memory', 'route', 'bind', '--host-project', '/p', '--expect-project', PROJECT_A, '--provider-checkout', '/c', '--argv-json', '["memy"]', '--label', 'x']).command, 'access memory route bind');
  assert.deepEqual(parseArgs(['access', 'memory', 'route', 'unbind', '--host-project', '/p']).values, { 'host-project': '/p' });
  assert.equal(parseArgs(['access', 'memory', 'route', 'list']).command, 'access memory route list');
  assert.equal(parseArgs(['access', 'memory', 'route', 'show', '--host-project', '/p']).command, 'access memory route show');
  assert.throws(() => parseArgs(['access', 'memory', 'route', 'bind', '--host-project', '/p', '--shell', 'sh']), e => e.code === 'invalid_arguments');
  assert.throws(() => parseArgs(['access', 'memory', 'begin', '--principal', 'g', '--job', 'j', '--operation', 'o', '--argv-json', '["x"]']), e => e.code === 'invalid_arguments', 'tool commands take no route fields');
  const file = path.join(base, 'argv.json'); await fs.writeFile(file, JSON.stringify(argvA));
  const viaJson = await routes.bind({ hostProject: project, argv: JSON.parse(JSON.stringify(argvA)), providerCheckout: '/c', expectedProjectId: PROJECT_A });
  const viaFile = await routes.bind({ hostProject: project, argv: JSON.parse(await fs.readFile(file, 'utf8')), providerCheckout: '/c', expectedProjectId: PROJECT_A });
  assert.deepEqual(viaJson.argv, viaFile.argv); assert.equal(viaJson.argvHash, viaFile.argvHash); assert.equal(viaFile.revision, viaJson.revision + 1);
  const listed = await routes.list();
  assert.equal(listed.routes.length, 1); assert.equal(listed.routes[0].argv, undefined); assert.equal(listed.routes[0].revision, 2);
  assert.deepEqual((await routes.show({ hostProject: project })).argv, argvA);
  await assert.rejects(routes.bind({ hostProject: path.join(base, 'nope'), argv: argvA, providerCheckout: '/c', expectedProjectId: PROJECT_A }), e => e.code === 'invalid_route');
  await assert.rejects(routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/c', expectedProjectId: 'not-a-uuid' }), e => e.code === 'invalid_route');
  await assert.rejects(routes.bind({ hostProject: project, argv: [], providerCheckout: '/c', expectedProjectId: PROJECT_A }), e => e.code === 'invalid_route');
  await assert.rejects(routes.bind({ hostProject: project, argv: ['memy', ''], providerCheckout: '/c', expectedProjectId: PROJECT_A }), e => e.code === 'invalid_route');
  await assert.rejects(routes.unbind({ hostProject: path.join(base, 'p2') }), e => e.code === 'memory_route_not_found');
  // A symlinked host project resolves to the same canonical key.
  const link = path.join(base, 'link'); await fs.symlink(project, link);
  assert.equal((await routes.show({ hostProject: link })).hostProject, project);
  void uuidFromOperationId;
});

test('a provider that cannot take an argv route answers unconfigured/provider_not_routable for a mapped project and keeps serving unmapped ones', async t => {
  const f = await setup(t);
  const plain = { name: 'plain', configured: true, recall: async () => ({ status: 'ok', items: [] }), begin: async () => ({ status: 'admitted', projectId: 'p', writeGeneration: 1 }), save: async () => ({ status: 'saved', memoryIds: ['m'], writeGeneration: 1 }) };
  const memory = new MemoryService({ root: f.stateRoot, provider: plain, principals: f.principals, sessions: f.sessions, jobs: f.access.jobs, orchestrator: f.orchestrator, timeoutMs: 800 });
  await memory.routes.bind({ hostProject: f.project, argv: f.argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  const r = await memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-n' });
  assert.equal(r.status, 'unconfigured'); assert.equal(r.reason, 'provider_not_routable');
  assert.equal((await memory.recall(f.principal, { jobId: f.jobA, question: 'what was decided?' })).reason, 'provider_not_routable');
  assert.equal((await memory.begin(f.principal, { jobId: f.jobB, operationId: 'op-o' })).status, 'admitted');
});

test('gate-wait identity: a job that moved to a new attempt while a repeat begin, a checkpoint or a pending retry waited for the project gate is refused inside the gate with no provider launch and unchanged admission/pending bytes; an unchanged waiter and a fresh operation at the new attempt proceed', async t => {
  const f = await setup(t);
  let revision = 1;
  const inspector = { inspect: async () => ({ attempt: { number: revision, id: `attempt-${revision}`, status: 'running' } }) };
  const memory = new MemoryService({ root: f.stateRoot, provider: f.provider, principals: f.principals, sessions: f.sessions, jobs: f.access.jobs, orchestrator: inspector, timeoutMs: 800 });
  await memory.routes.bind({ hostProject: f.project, argv: f.argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  const launches = () => f.command.calls.length;
  // Hold the project gate; start the call and wait until it has passed its pre-gate checks and asks
  // for the gate; change the attempt exactly then; release. Deterministic, no timing assumptions.
  const during = async (fn, change) => {
    const original = memory.routes.gate.bind(memory.routes);
    let enter, release, queued;
    const entered = new Promise(r => { enter = r; }); const gate = new Promise(r => { release = r; }); const requested = new Promise(r => { queued = r; });
    const held = original(f.project, async () => { enter(); await gate; });
    await entered;
    memory.routes.gate = (project, inner, opts) => { queued(); memory.routes.gate = original; return original(project, inner, opts); };
    const waiting = fn();
    await requested;
    await change();
    release(); await held;
    return waiting;
  };
  // 1. Repeat begin of an operation admitted at attempt 1 while the job advances to attempt 2.
  assert.equal((await memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w1' })).status, 'admitted');
  const admission1 = await fs.readFile(f.admissionFile('op-w1'));
  let before = launches();
  await assert.rejects(during(() => memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w1' }), async () => { revision = 2; }), e => e.code === 'operation_conflict' && e.details.before.intentRevision === 1 && e.details.now.intentRevision === 2);
  assert.equal(launches(), before, 'no provider launch');
  assert.ok(Buffer.compare(await fs.readFile(f.admissionFile('op-w1')), admission1) === 0, 'admission bytes unchanged: still attempt 1');
  assert.equal(JSON.parse(admission1.toString()).target.intentRevision, 1);
  // 2. First checkpoint of an operation admitted at attempt 2 while the job advances to attempt 3: refused, no pending record, no launch.
  assert.equal((await memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w2' })).status, 'admitted');
  before = launches();
  await assert.rejects(during(() => memory.checkpoint(f.principal, { jobId: f.jobA, operationId: 'op-w2', ...body() }), async () => { revision = 3; }), e => e.code === 'operation_conflict');
  assert.equal(launches(), before); assert.equal(await fs.readFile(f.pendingFile('op-w2'), 'utf8').catch(e => e.code), 'ENOENT');
  // 3. Pending retry: an operation with a pending save (provider hung) whose job advances during the wait keeps its pending bytes.
  assert.equal((await memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w3' })).status, 'admitted');
  f.command.hooks.saveMode = 'hang';
  assert.equal((await memory.checkpoint(f.principal, { jobId: f.jobA, operationId: 'op-w3', ...body() })).status, 'pending');
  f.command.hooks.saveMode = 'ok';
  const pending3 = await fs.readFile(f.pendingFile('op-w3'));
  before = launches();
  await assert.rejects(during(() => memory.checkpoint(f.principal, { jobId: f.jobA, operationId: 'op-w3' }), async () => { revision = 4; }), e => e.code === 'operation_conflict');
  assert.equal(launches(), before); assert.ok(Buffer.compare(await fs.readFile(f.pendingFile('op-w3')), pending3) === 0, 'pending bytes unchanged');
  // Controls: an unchanged-identity waiter proceeds (repeat begin repeated, checkpoint saved); a fresh operation at the new attempt is admitted and saved.
  assert.equal((await memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w4' })).status, 'admitted');
  const repeated = await during(() => memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w4' }), async () => {});
  assert.equal(repeated.status, 'admitted'); assert.equal(repeated.repeated, true);
  const saved = await during(() => memory.checkpoint(f.principal, { jobId: f.jobA, operationId: 'op-w4', ...body() }), async () => {});
  assert.equal(saved.status, 'saved');
  revision = 5;
  assert.equal((await memory.begin(f.principal, { jobId: f.jobA, operationId: 'op-w5' })).status, 'admitted');
  assert.equal(JSON.parse(await fs.readFile(f.admissionFile('op-w5'), 'utf8')).target.intentRevision, 5);
  assert.equal((await memory.checkpoint(f.principal, { jobId: f.jobA, operationId: 'op-w5', ...body() })).status, 'saved');
  // Recall during an attempt change is also refused rather than answered for a different identity.
  await assert.rejects(during(() => memory.recall(f.principal, { jobId: f.jobA, question: 'what was decided?' }), async () => { revision = 6; }), e => e.code === 'operation_conflict');
});

test('routed recall: a degraded answer from another Project is denied with no items, a same-Project degraded answer is delivered as degraded, a routed answer without project_id is a protocol error, and unmapped recall is unaffected', async t => {
  const { memory, principal, project, jobA, jobB, routes, argvA, command } = await setup(t);
  await routes.bind({ hostProject: project, argv: argvA, providerCheckout: '/x', expectedProjectId: PROJECT_A });
  const item = { memory_id: crypto.randomUUID(), content: 'SOURCE OF ANOTHER PROJECT', memory_type: 'handoff', provenance: { source: 'test' } };
  // Review case R2-degraded: valid memy.handoff.v1 recall receipt, status ok, degraded true, project_id B while the route expects A.
  command.hooks.recall = out => ({ ...out, degraded: true, project_id: PROJECT_B, items: [item] });
  const foreign = await memory.recall(principal, { jobId: jobA, question: 'what is known?' });
  assert.equal(foreign.status, 'denied'); assert.equal(foreign.reason, 'project_mismatch'); assert.deepEqual(foreign.items, []); assert.equal(foreign.truncated, false);
  assert.ok(!JSON.stringify(foreign).includes('SOURCE OF ANOTHER PROJECT'), 'no foreign item content reaches the caller');
  assert.equal(foreign.route.expectedProjectId, PROJECT_A);
  // Non-degraded ok from the other Project: same refusal.
  command.hooks.recall = out => ({ ...out, project_id: PROJECT_B, items: [item] });
  assert.equal((await memory.recall(principal, { jobId: jobA, question: 'what is known?' })).reason, 'project_mismatch');
  // Control: same Project, degraded, keeps working as degraded with its items.
  command.hooks.recall = out => ({ ...out, degraded: true, project_id: PROJECT_A, items: [item], notice: 'partial index' });
  const same = await memory.recall(principal, { jobId: jobA, question: 'what is known?' });
  assert.equal(same.status, 'degraded'); assert.equal(same.items.length, 1); assert.equal(same.items[0].content, item.content); assert.equal(same.route.expectedProjectId, PROJECT_A);
  // Control: same Project, ok.
  command.hooks.recall = out => ({ ...out, items: [item] });
  assert.equal((await memory.recall(principal, { jobId: jobA, question: 'what is known?' })).status, 'ok');
  // A routed answer without project_id cannot be delivered: protocol error, no items (even when degraded, even with items).
  for (const shape of [out => { const { project_id: _p, ...rest } = out; return { ...rest, items: [item] }; }, out => { const { project_id: _p, ...rest } = out; return { ...rest, degraded: true, items: [item] }; }]) {
    command.hooks.recall = shape;
    const missing = await memory.recall(principal, { jobId: jobA, question: 'what is known?' });
    assert.equal(missing.status, 'error'); assert.equal(missing.reason, 'protocol'); assert.deepEqual(missing.items, []);
  }
  // Unmapped project: the same-machine default is unchanged by routing, degraded or not, whatever project_id it reports.
  command.hooks.recall = out => ({ ...out, degraded: true, project_id: PROJECT_B, items: [item] });
  const unmapped = await memory.recall(principal, { jobId: jobB, question: 'what is known?' });
  assert.equal(unmapped.status, 'degraded'); assert.equal(unmapped.items.length, 1); assert.equal(unmapped.route, null);
  assert.ok(!command.calls.filter(c => c.cwd !== project).some(c => c.argv.includes('--expect-project')));
  // Existing protocol refusals for missing or invalid project_id on status/begin/save are untouched.
  command.hooks.recall = null;
  const routed = memory.provider.withArgv(argvA);
  const st = await routed.status({ project, agent: 'claude', expectProject: PROJECT_A });
  assert.equal(st.status, 'ok');
});
