import crypto from 'node:crypto';
import { invariant } from './errors.mjs';
import { CONTEXT_PACKET_SCHEMA_VERSION, contextDigest } from './context-packet.mjs';

export const WORKFLOW_SCHEMA_VERSION = 1;

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function currentAttempt(task) {
  return Array.isArray(task?.attempts) ? task.attempts.find(attempt => attempt.id === task.currentAttempt) || null : null;
}

function evidenceReference(kind, id, value) {
  return { kind, id, digest: digest(value) };
}

function taskNode(task) {
  const attempt = currentAttempt(task);
  const invalidCurrentAttempt = Array.isArray(task?.attempts) && task.attempts.length > 0 && !attempt;
  const status = invalidCurrentAttempt ? 'unknown' : attempt?.status || 'pending';
  const verification = attempt?.verification || null;
  const integration = attempt?.integration || null;
  const accepted = ['accepted', 'integrated'].includes(status) && verification?.passed === true;
  const references = [];
  if (attempt?.routeDecision) references.push(evidenceReference('decision', attempt.id, attempt.routeDecision));
  if (verification) references.push(evidenceReference('verification', attempt.id, verification));
  if (integration) references.push(evidenceReference('integration', attempt.id, integration));
  return {
    id: task?.definition?.id || null,
    status,
    attemptId: attempt?.id || null,
    accepted,
    integrated: status === 'integrated' && integration?.passed === true,
    checks: Array.isArray(verification?.checks) ? verification.checks.map(check => ({ name: check.name, status: check.status })) : [],
    references,
    blocker: accepted ? null : (attempt?.lastError?.code || (invalidCurrentAttempt ? 'invalid_current_attempt' : status === 'pending' ? 'task_not_started' : `task_${status}`)),
  };
}

export function createReleaseReadinessPlan({
  outcome = 'release-readiness',
  requireIntegration = true,
  deadlineAt = null,
} = {}) {
  invariant(outcome === 'release-readiness', 'workflow_invalid', 'Only release-readiness workflow is registered.');
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId: outcome,
    outcome,
    requireIntegration: requireIntegration === true,
    deadlineAt: typeof deadlineAt === 'string' ? deadlineAt : null,
    authority: 'run.json, independent verification and integration evidence',
  };
}

export function buildWorkflowGraph({ run, plan = createReleaseReadinessPlan(), contextPacket = null } = {}) {
  invariant(run && typeof run === 'object', 'workflow_invalid_run', 'Workflow requires a run snapshot.');
  const calculatedContextDigest = contextPacket?.schemaVersion === CONTEXT_PACKET_SCHEMA_VERSION ? contextDigest(contextPacket) : null;
  const contextObserved = Boolean(contextPacket
    && calculatedContextDigest
    && contextPacket.packetDigest === calculatedContextDigest
    && contextPacket.project?.root === run.project);
  const tasks = Object.values(run.tasks || {}).map(taskNode);
  const nodes = [
    {
      id: 'project-context',
      kind: 'context',
      status: contextObserved ? 'observed' : 'unknown',
      authority: 'context-packet',
      references: contextObserved ? [{ kind: 'context', id: contextPacket.packetId || null, digest: contextPacket.packetDigest }] : [],
    },
    ...tasks.map(task => ({ id: `task:${task.id}`, kind: 'task', ...task })),
    { id: 'release-readiness', kind: 'outcome', status: 'pending', dependsOn: tasks.map(task => `task:${task.id}`) },
  ];
  const blockers = [
    ...(contextObserved ? [] : [{ taskId: null, reason: 'context_packet_missing' }]),
    ...tasks.filter(task => !task.accepted).map(task => ({ taskId: task.id, reason: task.blocker })),
  ];
  const integrated = tasks.length > 0 && tasks.every(task => task.integrated);
  const accepted = tasks.length > 0 && tasks.every(task => task.accepted);
  const checksPassed = tasks.length > 0 && tasks.every(task => task.checks.length > 0 && task.checks.every(check => check.status === 'passed'));
  const projectAcceptance = contextObserved && accepted && (!plan.requireIntegration || integrated) && checksPassed ? 'accepted' : 'unknown';
  const readiness = projectAcceptance === 'accepted' ? 'ready' : blockers.length ? 'blocked' : 'unknown';
  nodes.at(-1).status = readiness;
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowId: plan.workflowId,
    outcome: plan.outcome,
    nodes,
    gates: { contextObserved: Boolean(contextObserved), accepted, integrated, checksPassed, projectAcceptance, readiness },
    blockers,
  };
}

export function evaluateReleaseReadiness({ run, plan = createReleaseReadinessPlan(), contextPacket = null } = {}) {
  const graph = buildWorkflowGraph({ run, plan, contextPacket });
  const outcomeDigest = digest(graph);
  const report = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    reportId: crypto.randomUUID(),
    workflowId: plan.workflowId,
    outcome: plan.outcome,
    runId: run.id || null,
    project: run.project || null,
    generatedAt: new Date().toISOString(),
    taskGraph: graph,
    projectAcceptance: graph.gates.projectAcceptance,
    evidence: {
      runState: 'run.json',
      contextDigest: contextPacket?.packetDigest || null,
      verificationCount: graph.nodes.filter(node => node.kind === 'task' && node.checks.length > 0).length,
      references: [
        { kind: 'run', id: run.id || null, digest: digest(run) },
        ...(contextPacket ? [{ kind: 'context', id: contextPacket.packetId || null, digest: contextPacket.packetDigest || null }] : []),
        ...graph.nodes.filter(node => node.kind === 'task').flatMap(node => node.references || []),
        { kind: 'outcome', id: plan.outcome, digest: outcomeDigest },
      ],
    },
    reportDigest: null,
  };
  report.reportDigest = digest({ ...report, reportDigest: undefined });
  return report;
}

export class WorkflowRegistry {
  constructor() {
    this.workflows = new Map([['release-readiness', { id: 'release-readiness', createPlan: createReleaseReadinessPlan, evaluate: evaluateReleaseReadiness }]]);
  }

  get(id) {
    return this.workflows.get(id) || null;
  }

  list() {
    return [...this.workflows.values()].map(workflow => ({ id: workflow.id }));
  }

  evaluate(id, input) {
    const workflow = this.get(id);
    invariant(workflow, 'workflow_not_found', `Unknown workflow: ${id}`);
    return workflow.evaluate(input);
  }
}
