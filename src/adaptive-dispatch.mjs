import path from 'node:path';
import crypto from 'node:crypto';
import { invariant } from './errors.mjs';
import { taskDigest, validateTask } from './task.mjs';
import { withLock, runPath } from './state.mjs';
import { ResourceService } from './resources/index.mjs';
import { planAdaptive } from './adaptive-selection.mjs';
import { CalibrationRunner } from './calibration/runner.mjs';
import { prepareAdaptiveResources, preparationRequestFields, normalizePreparationOptions } from './adaptive-preparation.mjs';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeStatuses = new Set(['integrating', 'preparing', 'launching', 'ready', 'sending', 'running', 'uncertain', 'needs_input', 'submitted', 'verifying', 'cancelling']);
const currentAttempt = record => record.attempts.find(attempt => attempt.id === record.currentAttempt);

function requestContract(input, options) {
  const preparation = preparationRequestFields(options);
  return hash({ inputDigest: taskDigest(input), explicitAgent: input.agent || null, explicitIsolation: input.isolation || null,
    preference: options.preference || 'balanced', resources: options.allowedResourceIds?.slice().sort() ?? null,
    fixedAgent: options.fixedAgent || null, fixedProfileId: options.fixedProfileId || null,
    executor: options.fixedExecutorKind || null, thread: options.thread || null,
    ...(Object.keys(preparation).length ? { preparation } : {}) });
}

function runHistory(run) {
  return Object.values(run.tasks).flatMap(task => task.attempts.flatMap(attempt => {
    const fingerprint = attempt.routeDecision?.resource?.fingerprint;
    const taskKind = task.definition.brief?.taskKind;
    const end = attempt.operation?.finishedAt || attempt.verification?.finishedAt || attempt.performance?.updatedAt;
    if (!fingerprint || !taskKind || !end) return [];
    const elapsedMs = Date.parse(end) - Date.parse(attempt.createdAt);
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return [];
    return [{ fingerprint, taskKind, status: attempt.deadlineExceededAt ? 'timed_out' : attempt.status, elapsedMs, observedAt: end }];
  }));
}

function assertPreparationFeasible(run, task) {
  invariant(!run.closedAt, 'run_closed', 'This run was cleaned up. Create a new run for more work.');
  for (const dependency of task.dependsOn) {
    const predecessor = Object.hasOwn(run.tasks, dependency) ? run.tasks[dependency] : null;
    invariant(predecessor && ['accepted', 'integrated'].includes(currentAttempt(predecessor).status), 'dependency_not_ready', `Dependency ${dependency} is not accepted.`);
    invariant(currentAttempt(predecessor).status === 'integrated' || task.isolation === 'checkout', 'dependency_not_integrated', `Integrate ${dependency} before creating a dependent worktree.`);
  }
  const activeExternal = Object.values(run.tasks).filter(record => currentAttempt(record).executorKind !== 'host' && activeStatuses.has(currentAttempt(record).status)).length;
  invariant(activeExternal < run.maxParallel, 'capacity_exceeded', 'Run capacity reached. Collect and verify or cancel existing work.');
}

// This controller binds a choice to one attempt. It never reapplies a saved
// recommendation blindly, and a repeated request never creates another worker.
export class AdaptiveDispatcher {
  constructor({ orchestrator, resources, calibrationRunner, calibrationRunnerFactory, decisionProvider = null, decisionMode = 'shadow' } = {}) {
    invariant(orchestrator?.root, 'invalid_adaptive_controller', 'An orchestrator is required.');
    this.orchestrator = orchestrator;
    this.decisionProvider = decisionProvider;
    this.decisionMode = decisionMode;
    this.resources = resources || new ResourceService({ root: orchestrator.root });
    this.calibrationRunnerFactory = calibrationRunnerFactory || (() => calibrationRunner || new CalibrationRunner({
      root: this.orchestrator.root,
      resources: this.resources,
      profiles: this.resources.profiles || this.orchestrator.profiles,
      environment: this.resources.environment,
      home: this.resources.home,
    }));
  }

  async dispatch(runId, input, options = {}) {
    const task = validateTask(input);
    await this.orchestrator.loadRun(runId);
    const thread = options.thread || this.orchestrator.coordinatorId;
    const preparation = normalizePreparationOptions(options);
    const selection = { ...options, ...preparation, thread };
    const requestDigest = requestContract(input, selection);
    return withLock(path.join(runPath(this.orchestrator.root, runId), `adaptive-${task.id}.lock`), async () => {
      const run = await this.orchestrator.loadRun(runId);
      const existing = run.tasks[task.id];
      if (existing) {
        const attempt = existing.attempts.find(a => a.id === existing.currentAttempt);
        invariant(attempt?.routeDecision?.requestDigest === requestDigest, 'task_conflict', 'This task id is already bound to a different request or execution path.');
        return { ...(await this.orchestrator.inspect(runId, task.id)), duplicate: true, adaptive: true };
      }
      let inventory = await this.resources.discover();
      const history = runHistory(run);
      let plan = await planAdaptive({
        input,
        inventory,
        ...selection,
        hostAvailable: Boolean(thread),
        history,
        decisionProvider: options.decisionProvider || this.decisionProvider,
        decisionMode: options.decisionMode || this.decisionMode,
      });
      let preparationEvidence = null;
      if (!plan.decision.selected && preparation.calibrationPolicy === 'on-demand') {
        const prepared = await prepareAdaptiveResources({
          input,
          inventory,
          plan,
          selection: { ...selection, hostAvailable: Boolean(thread), history },
          resources: this.resources,
          runner: this.calibrationRunnerFactory(),
          preflight: async candidate => {
            assertPreparationFeasible(run, candidate);
            await this.orchestrator.preflight(runId, candidate);
          },
        });
        inventory = prepared.inventory;
        plan = prepared.plan;
        preparationEvidence = prepared.evidence;
      }
      invariant(plan.effectiveTask && plan.decision.selected, 'adaptive_route_unavailable', 'No eligible execution path satisfies the request.', {
        decision: preparationEvidence ? { ...plan.decision, evidence: { ...plan.decision.evidence, preparation: preparationEvidence } } : plan.decision,
      });
      if (plan.selectedResource?.kind !== 'host') {
        const fresh = await this.resources.get(plan.selectedResource.id);
        invariant(fresh.fingerprint === plan.selectedResource.fingerprint, 'resource_configuration_changed', 'Selected configuration changed before dispatch.');
      }
      const routeDecision = {
        schemaVersion: 1, mode: 'adaptive', applied: true, appliedMeaning: 'bound-to-attempt-not-acceptance',
        requestDigest, inputDigest: plan.inputDigest, decidedAt: new Date().toISOString(),
        selected: plan.decision.selected, resource: plan.selectedResource?.kind === 'host' ? null : plan.selectedResource,
        preference: selection.preference || 'balanced',
        reasons: [...plan.decision.reasons.filter(reason => reason !== 'shadow_advisory_only_not_dispatched'), 'adaptive_bound_to_attempt'],
        evidence: preparationEvidence ? { ...plan.evidence, preparation: preparationEvidence } : plan.evidence,
        configurationScope: 'observed-user-config-not-all-project-plugins',
      };
      const result = plan.decision.selected.executorKind === 'host'
        ? await this.orchestrator.hostStart(runId, plan.effectiveTask, { thread, routeDecision })
        : await this.orchestrator.dispatch(runId, plan.effectiveTask, { routeDecision });
      return { ...result, adaptive: true };
    });
  }
}
