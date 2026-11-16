export const RUN_STATUSES = [
  'queued',
  'planning',
  'running',
  'waiting_approval',
  'paused',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'interrupted'
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const PLAN_STATUSES = [
  'draft',
  'validated',
  'active',
  'superseded',
  'rejected'
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const STEP_STATUSES = [
  'pending',
  'ready',
  'running',
  'waiting_approval',
  'retrying',
  'blocked',
  'needs_verification',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'superseded'
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const STEP_KINDS = ['read', 'write', 'destructive'] as const;

export type StepKind = (typeof STEP_KINDS)[number];

export interface PlanDocumentStep {
  title: string;
  kind: StepKind;
  dependsOn?: string[];
}

export interface PlanDocument {
  steps: PlanDocumentStep[];
}

export function createEmptyPlanDocument(): PlanDocument {
  return { steps: [] };
}

export interface Run {
  id: string;
  goal: string;
  status: RunStatus;
  currentPlanId: string | null;
  cancelRequested: boolean;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface Plan {
  id: string;
  runId: string;
  version: number;
  status: PlanStatus;
  plan: PlanDocument;
  createdAt: number;
}

export interface RunStep {
  id: string;
  runId: string;
  planId: string;
  seq: number;
  title: string;
  kind: StepKind;
  status: StepStatus;
  dependsOn: string[];
  createdAt: number;
}

export interface ServiceEvent {
  id: string;
  runId: string;
  seq: number;
  type: ServiceEventType;
  payload: unknown;
  createdAt: number;
}

export const SERVICE_EVENT_TYPES = [
  'run.created',
  'run.planning_started',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.cancelled',
  'run.failed',
  'run.completed',
  'run.interrupted',
  'run.recovered',
  'plan.created',
  'plan.validated',
  'plan.activated',
  'plan.revised',
  'plan.rejected',
  'plan.retry',
  'step.ready',
  'step.started',
  'step.waiting_approval',
  'step.approval_granted',
  'step.blocked',
  'step.cancelled',
  'step.completed',
  'step.failed',
  'step.retrying',
  'step.retry_started',
  'step.needs_verification',
  'step.verified',
  'step.interrupted',
  'step.recovered',
  'step.superseded',
  'approval.requested',
  'approval.approved',
  'verification.started'
] as const;

export type ServiceEventType = (typeof SERVICE_EVENT_TYPES)[number];

export interface TransitionEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>
> {
  type: ServiceEventType;
  payload: TPayload;
}

export type EntityKind = 'run' | 'plan' | 'step';

export interface TransitionError {
  code: 'INVALID_TRANSITION';
  entity: EntityKind;
  from: string;
  to: string;
  message: string;
}

export type TransitionResult<T> =
  | {
      ok: true;
      value: T;
      event: TransitionEvent;
    }
  | {
      ok: false;
      error: TransitionError;
    };

export type TransitionOwner =
  | 'Run engine'
  | 'Plan validator'
  | 'Plan revision engine'
  | 'Scheduler'
  | 'Executor'
  | 'Approval service'
  | 'Verification engine'
  | 'Recovery manager';

export interface TransitionDefinition<TFrom extends string, TTo extends string> {
  from: TFrom;
  to: TTo;
  event: ServiceEventType;
  owner: TransitionOwner;
  guard: string;
}

export type RunTransition = TransitionDefinition<RunStatus, RunStatus>;
export type PlanTransition = TransitionDefinition<PlanStatus, PlanStatus>;
export type StepTransition = TransitionDefinition<StepStatus, StepStatus>;

export interface BootstrapResult {
  run: Run;
  plan: Plan;
  events: TransitionEvent[];
}

export type BootstrapOutcome =
  | {
      ok: true;
      value: BootstrapResult;
    }
  | {
      ok: false;
      error: TransitionError;
    };
