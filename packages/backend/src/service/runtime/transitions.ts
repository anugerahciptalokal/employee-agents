import { createEmptyPlanDocument } from '@open-employee/contracts/contracts/service';
import type {
  BootstrapOutcome,
  EntityKind,
  Plan,
  PlanStatus,
  PlanTransition,
  Run,
  RunStatus,
  RunStep,
  RunTransition,
  StepStatus,
  StepTransition,
  TransitionError,
  TransitionEvent,
  TransitionResult
} from '@open-employee/contracts/contracts/service';

const NON_TERMINAL_RUN_STATUSES: RunStatus[] = [
  'queued',
  'planning',
  'running',
  'waiting_approval',
  'paused',
  'verifying'
];

const SUPERSEDABLE_STEP_STATUSES: StepStatus[] = [
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'retrying',
  'blocked',
  'needs_verification',
  'interrupted'
];

const interruptRunTransitions: RunTransition[] = NON_TERMINAL_RUN_STATUSES.map((from) => ({
  from,
  to: 'interrupted',
  event: 'run.interrupted',
  owner: 'Recovery manager',
  guard: 'Service crash or lease loss'
}));

const supersedeStepTransitions: StepTransition[] = SUPERSEDABLE_STEP_STATUSES.map((from) => ({
  from,
  to: 'superseded',
  event: 'step.superseded',
  owner: 'Plan revision engine',
  guard: 'New plan version invalidates the step'
}));

export const RUN_TRANSITIONS: readonly RunTransition[] = [
  {
    from: 'queued',
    to: 'planning',
    event: 'run.planning_started',
    owner: 'Run engine',
    guard: 'Run persisted and policy valid'
  },
  {
    from: 'planning',
    to: 'running',
    event: 'run.started',
    owner: 'Run engine',
    guard: 'Plan validated'
  },
  {
    from: 'planning',
    to: 'failed',
    event: 'run.failed',
    owner: 'Run engine',
    guard: 'Plan invalid after one repair'
  },
  {
    from: 'planning',
    to: 'paused',
    event: 'run.paused',
    owner: 'Run engine',
    guard: 'User pause or provider unavailable'
  },
  {
    from: 'running',
    to: 'waiting_approval',
    event: 'approval.requested',
    owner: 'Run engine',
    guard: 'A step requests approval'
  },
  {
    from: 'waiting_approval',
    to: 'running',
    event: 'approval.approved',
    owner: 'Run engine',
    guard: 'Approval granted'
  },
  {
    from: 'waiting_approval',
    to: 'cancelled',
    event: 'run.cancelled',
    owner: 'Run engine',
    guard: 'User cancels or approval expires and policy blocks'
  },
  {
    from: 'running',
    to: 'paused',
    event: 'run.paused',
    owner: 'Run engine',
    guard: 'User pause or provider unavailable'
  },
  {
    from: 'paused',
    to: 'running',
    event: 'run.resumed',
    owner: 'Run engine',
    guard: 'User resume and budget remains'
  },
  {
    from: 'paused',
    to: 'cancelled',
    event: 'run.cancelled',
    owner: 'Run engine',
    guard: 'User cancels a paused run'
  },
  {
    from: 'running',
    to: 'verifying',
    event: 'verification.started',
    owner: 'Run engine',
    guard: 'All required steps completed'
  },
  {
    from: 'verifying',
    to: 'completed',
    event: 'run.completed',
    owner: 'Verification engine',
    guard: 'All deterministic checks pass and no blocking judge failure'
  },
  {
    from: 'verifying',
    to: 'running',
    event: 'plan.revised',
    owner: 'Run engine',
    guard: 'Verification failed and plan revision adds work'
  },
  {
    from: 'verifying',
    to: 'failed',
    event: 'run.failed',
    owner: 'Verification engine',
    guard: 'Verification failed and no revision is possible'
  },
  {
    from: 'running',
    to: 'failed',
    event: 'run.failed',
    owner: 'Run engine',
    guard: 'Non-recoverable step failure'
  },
  {
    from: 'running',
    to: 'cancelled',
    event: 'run.cancelled',
    owner: 'Run engine',
    guard: 'User cancellation'
  },
  ...interruptRunTransitions,
  {
    from: 'interrupted',
    to: 'running',
    event: 'run.recovered',
    owner: 'Recovery manager',
    guard: 'Safe steps only, policy re-checked'
  },
  {
    from: 'interrupted',
    to: 'failed',
    event: 'run.failed',
    owner: 'Recovery manager',
    guard: 'Unsafe side effect cannot be verified'
  }
];

export const PLAN_TRANSITIONS: readonly PlanTransition[] = [
  {
    from: 'draft',
    to: 'validated',
    event: 'plan.validated',
    owner: 'Plan validator',
    guard: 'Schema, references, cycles, and budget pass'
  },
  {
    from: 'draft',
    to: 'rejected',
    event: 'plan.rejected',
    owner: 'Plan validator',
    guard: 'Invalid after one repair'
  },
  {
    from: 'validated',
    to: 'active',
    event: 'plan.activated',
    owner: 'Run engine',
    guard: 'Run starts execution'
  },
  {
    from: 'active',
    to: 'superseded',
    event: 'plan.revised',
    owner: 'Plan revision engine',
    guard: 'New version applied'
  },
  {
    from: 'validated',
    to: 'superseded',
    event: 'plan.revised',
    owner: 'Plan revision engine',
    guard: 'New version applied before execution'
  },
  {
    from: 'rejected',
    to: 'draft',
    event: 'plan.retry',
    owner: 'Plan validator',
    guard: 'User or system retries with new constraints'
  }
];

export const STEP_TRANSITIONS: readonly StepTransition[] = [
  {
    from: 'pending',
    to: 'ready',
    event: 'step.ready',
    owner: 'Scheduler',
    guard: 'Dependencies completed and policy valid'
  },
  {
    from: 'ready',
    to: 'running',
    event: 'step.started',
    owner: 'Scheduler',
    guard: 'Lease acquired and budget available'
  },
  {
    from: 'running',
    to: 'waiting_approval',
    event: 'step.waiting_approval',
    owner: 'Executor',
    guard: 'Tool or action needs approval'
  },
  {
    from: 'waiting_approval',
    to: 'running',
    event: 'step.approval_granted',
    owner: 'Executor',
    guard: 'Approval granted and not expired'
  },
  {
    from: 'waiting_approval',
    to: 'blocked',
    event: 'step.blocked',
    owner: 'Executor',
    guard: 'Approval denied or expired'
  },
  {
    from: 'waiting_approval',
    to: 'cancelled',
    event: 'step.cancelled',
    owner: 'Executor',
    guard: 'User cancels'
  },
  {
    from: 'running',
    to: 'completed',
    event: 'step.completed',
    owner: 'Executor',
    guard: 'Tool or model result satisfies step contract'
  },
  {
    from: 'running',
    to: 'failed',
    event: 'step.failed',
    owner: 'Executor',
    guard: 'Non-retryable error'
  },
  {
    from: 'running',
    to: 'retrying',
    event: 'step.retrying',
    owner: 'Executor',
    guard: 'Retryable error and attempts remain'
  },
  {
    from: 'retrying',
    to: 'running',
    event: 'step.retry_started',
    owner: 'Executor',
    guard: 'Backoff elapsed'
  },
  {
    from: 'retrying',
    to: 'failed',
    event: 'step.failed',
    owner: 'Executor',
    guard: 'Attempts exhausted'
  },
  {
    from: 'running',
    to: 'needs_verification',
    event: 'step.needs_verification',
    owner: 'Executor',
    guard: 'Timeout after possible side effect'
  },
  {
    from: 'needs_verification',
    to: 'completed',
    event: 'step.verified',
    owner: 'Verification engine',
    guard: 'Evidence confirms the side effect'
  },
  {
    from: 'needs_verification',
    to: 'failed',
    event: 'step.failed',
    owner: 'Verification engine',
    guard: 'Evidence shows failure or duplicate risk'
  },
  {
    from: 'running',
    to: 'interrupted',
    event: 'step.interrupted',
    owner: 'Recovery manager',
    guard: 'Crash or lease loss'
  },
  {
    from: 'interrupted',
    to: 'ready',
    event: 'step.recovered',
    owner: 'Recovery manager',
    guard: 'Read-only or idempotent and policy re-checked'
  },
  {
    from: 'interrupted',
    to: 'needs_verification',
    event: 'step.needs_verification',
    owner: 'Recovery manager',
    guard: 'Write or destructive with unknown outcome'
  },
  {
    from: 'pending',
    to: 'cancelled',
    event: 'step.cancelled',
    owner: 'Scheduler',
    guard: 'Run cancelled before start'
  },
  ...supersedeStepTransitions
];

export function getRunTransition(
  from: RunStatus,
  to: RunStatus
): RunTransition | undefined {
  return RUN_TRANSITIONS.find((transition) => transition.from === from && transition.to === to);
}

export function getPlanTransition(
  from: PlanStatus,
  to: PlanStatus
): PlanTransition | undefined {
  return PLAN_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to
  );
}

export function getStepTransition(
  from: StepStatus,
  to: StepStatus
): StepTransition | undefined {
  return STEP_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to
  );
}

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return getRunTransition(from, to) !== undefined;
}

export function canTransitionPlan(from: PlanStatus, to: PlanStatus): boolean {
  return getPlanTransition(from, to) !== undefined;
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return getStepTransition(from, to) !== undefined;
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isTerminalPlanStatus(status: PlanStatus): boolean {
  return status === 'superseded';
}

export function isTerminalStepStatus(status: StepStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'superseded'
  );
}

function invalidTransition(entity: EntityKind, from: string, to: string): TransitionError {
  return {
    code: 'INVALID_TRANSITION',
    entity,
    from,
    to,
    message: `Invalid ${entity} transition: ${from} -> ${to}`
  };
}

export function transitionRun(run: Run, to: RunStatus, now = Date.now()): TransitionResult<Run> {
  const definition = getRunTransition(run.status, to);
  if (!definition) {
    return { ok: false, error: invalidTransition('run', run.status, to) };
  }

  const next: Run = {
    ...run,
    status: to,
    cancelRequested: to === 'cancelled' ? true : run.cancelRequested,
    startedAt: to === 'running' && run.startedAt === null ? now : run.startedAt,
    completedAt: isTerminalRunStatus(to) ? now : run.completedAt
  };

  return {
    ok: true,
    value: next,
    event: {
      type: definition.event,
      payload: {
        runId: run.id,
        from: run.status,
        to
      }
    }
  };
}

export function transitionPlan(plan: Plan, to: PlanStatus): TransitionResult<Plan> {
  const definition = getPlanTransition(plan.status, to);
  if (!definition) {
    return { ok: false, error: invalidTransition('plan', plan.status, to) };
  }

  return {
    ok: true,
    value: { ...plan, status: to },
    event: {
      type: definition.event,
      payload: {
        planId: plan.id,
        runId: plan.runId,
        from: plan.status,
        to
      }
    }
  };
}

export function transitionStep(step: RunStep, to: StepStatus): TransitionResult<RunStep> {
  const definition = getStepTransition(step.status, to);
  if (!definition) {
    return { ok: false, error: invalidTransition('step', step.status, to) };
  }

  return {
    ok: true,
    value: { ...step, status: to },
    event: {
      type: definition.event,
      payload: {
        stepId: step.id,
        runId: step.runId,
        planId: step.planId,
        from: step.status,
        to
      }
    }
  };
}

export function bootstrapRun(
  run: Run,
  planId: string,
  now = Date.now()
): BootstrapOutcome {
  if (run.status !== 'queued') {
    return { ok: false, error: invalidTransition('run', run.status, 'planning') };
  }

  const plan: Plan = {
    id: planId,
    runId: run.id,
    version: 1,
    status: 'draft',
    plan: createEmptyPlanDocument(),
    createdAt: now
  };

  const events: TransitionEvent[] = [
    {
      type: 'plan.created',
      payload: {
        runId: run.id,
        planId,
        version: plan.version
      }
    }
  ];

  const planning = transitionRun(run, 'planning', now);
  if (!planning.ok) return planning;
  events.push(planning.event);

  const validated = transitionPlan(plan, 'validated');
  if (!validated.ok) return validated;
  events.push(validated.event);

  const active = transitionPlan(validated.value, 'active');
  if (!active.ok) return active;
  events.push(active.event);

  const started = transitionRun(
    { ...planning.value, currentPlanId: planId },
    'running',
    now
  );
  if (!started.ok) return started;
  events.push(started.event);

  return {
    ok: true,
    value: {
      run: started.value,
      plan: active.value,
      events
    }
  };
}
