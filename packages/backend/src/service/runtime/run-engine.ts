import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import {
  createEmptyPlanDocument,
  type Plan,
  type PlanDocument,
  type PlanStatus,
  type Run,
  type RunStatus,
  type ServiceEvent,
  type TransitionError
} from '@open-employee/contracts/contracts/service';
import type { ExecutionDatabase } from '../db/database';
import { EventStore } from './event-store';
import { transitionPlan, transitionRun } from './transitions';

export interface RunRecord extends Run {
  version: number;
}

export type RunEngineErrorCode =
  | 'RUN_NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_TRANSITION'
  | 'VALIDATION_ERROR';

export interface RunEngineError {
  code: RunEngineErrorCode;
  message: string;
  runId?: string;
  expectedVersion?: number;
  actualVersion?: number;
  from?: string;
  to?: string;
}

export type RunEngineResult<T> =
  | {
      ok: true;
      value: T;
      events: ServiceEvent[];
    }
  | {
      ok: false;
      error: RunEngineError;
    };

export interface RunBootstrapResult {
  run: RunRecord;
  plan: Plan;
  events: ServiceEvent[];
}

interface RunRow {
  id: string;
  goal: string;
  status: RunStatus;
  currentPlanId: string | null;
  cancelRequested: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  version: number;
}

interface PlanRow {
  id: string;
  runId: string;
  version: number;
  status: PlanStatus;
  planJson: string;
  createdAt: number;
}

class RunVersionConflictError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expectedVersion: number
  ) {
    super(`Run ${runId} version conflict at version ${expectedVersion}.`);
    this.name = 'RunVersionConflictError';
  }
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    goal: row.goal,
    status: row.status,
    currentPlanId: row.currentPlanId,
    cancelRequested: Boolean(row.cancelRequested),
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    version: row.version
  };
}

function mapPlanRow(row: PlanRow): Plan {
  return {
    id: row.id,
    runId: row.runId,
    version: row.version,
    status: row.status,
    plan: JSON.parse(row.planJson) as PlanDocument,
    createdAt: row.createdAt
  };
}

function conflictError(
  runId: string,
  expectedVersion: number,
  actualVersion?: number
): RunEngineResult<never> {
  return {
    ok: false,
    error: {
      code: 'CONFLICT',
      message: `Run ${runId} version conflict; expected version ${expectedVersion}.`,
      runId,
      expectedVersion,
      actualVersion
    }
  };
}

function invalidTransitionError(
  error: TransitionError,
  runId?: string
): RunEngineResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_TRANSITION',
      message: error.message,
      runId,
      from: error.from,
      to: error.to
    }
  };
}

export class RunEngine {
  private readonly events: EventStore;

  constructor(
    private readonly database: ExecutionDatabase,
    events?: EventStore
  ) {
    this.events = events ?? new EventStore(database);
  }

  public createRun(goal: string): RunEngineResult<RunRecord> {
    const trimmed = goal.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'Run goal is required.' }
      };
    }

    const now = Date.now();
    const run: RunRecord = {
      id: randomUUID(),
      goal: trimmed,
      status: 'queued',
      currentPlanId: null,
      cancelRequested: false,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      version: 0
    };

    return this.database.write((connection) => {
      connection
        .prepare(
          `INSERT INTO runs
            (id, goal, status, current_plan_id, cancel_requested, created_at, started_at, completed_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.id,
          run.goal,
          run.status,
          null,
          0,
          run.createdAt,
          null,
          null,
          run.version
        );

      const event = this.events.appendInTransaction(
        connection,
        run.id,
        'run.created',
        { runId: run.id, goal: run.goal },
        now
      );

      return { ok: true, value: run, events: [event] };
    });
  }

  public bootstrapRun(runId: string): RunEngineResult<RunBootstrapResult> {
    const loaded = this.getRun(runId);
    if (!loaded) {
      return {
        ok: false,
        error: { code: 'RUN_NOT_FOUND', message: `Run ${runId} was not found.`, runId }
      };
    }

    if (loaded.status !== 'queued') {
      return {
        ok: false,
        error: {
          code: 'INVALID_TRANSITION',
          message: `Invalid run transition: ${loaded.status} -> planning`,
          runId,
          from: loaded.status,
          to: 'planning'
        }
      };
    }

    const now = Date.now();
    const planId = randomUUID();
    const draft: Plan = {
      id: planId,
      runId,
      version: 1,
      status: 'draft',
      plan: createEmptyPlanDocument(),
      createdAt: now
    };

    const planning = transitionRun(loaded, 'planning', now);
    if (!planning.ok) return invalidTransitionError(planning.error, runId);

    const validated = transitionPlan(draft, 'validated');
    if (!validated.ok) return invalidTransitionError(validated.error, runId);

    const active = transitionPlan(validated.value, 'active');
    if (!active.ok) return invalidTransitionError(active.error, runId);

    const running = transitionRun(
      { ...planning.value, currentPlanId: planId },
      'running',
      now
    );
    if (!running.ok) return invalidTransitionError(running.error, runId);

    try {
      return this.database.write((connection) => {
        connection
          .prepare(
            `INSERT INTO plans (id, run_id, version, status, plan_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            draft.id,
            draft.runId,
            draft.version,
            draft.status,
            JSON.stringify(draft.plan),
            draft.createdAt
          );

        const events: ServiceEvent[] = [
          this.events.appendInTransaction(
            connection,
            runId,
            'plan.created',
            { runId, planId, version: draft.version },
            now
          )
        ];

        this.updateRunCas(connection, planning.value, loaded.version);
        events.push(
          this.events.appendInTransaction(
            connection,
            runId,
            planning.event.type,
            planning.event.payload,
            now
          )
        );

        this.updatePlanStatus(connection, planId, 'validated');
        events.push(
          this.events.appendInTransaction(
            connection,
            runId,
            validated.event.type,
            validated.event.payload,
            now
          )
        );

        this.updatePlanStatus(connection, planId, 'active');
        events.push(
          this.events.appendInTransaction(
            connection,
            runId,
            active.event.type,
            active.event.payload,
            now
          )
        );

        this.updateRunCas(connection, running.value, loaded.version + 1);
        events.push(
          this.events.appendInTransaction(
            connection,
            runId,
            running.event.type,
            running.event.payload,
            now
          )
        );

        return {
          ok: true,
          value: {
            run: { ...running.value, version: loaded.version + 2 },
            plan: active.value,
            events
          },
          events
        };
      });
    } catch (error) {
      if (error instanceof RunVersionConflictError) {
        return conflictError(runId, error.expectedVersion);
      }
      throw error;
    }
  }

  public pauseRun(
    runId: string,
    expectedVersion?: number
  ): RunEngineResult<RunRecord> {
    return this.applyRunTransition(runId, 'paused', expectedVersion);
  }

  public resumeRun(
    runId: string,
    expectedVersion?: number
  ): RunEngineResult<RunRecord> {
    return this.applyRunTransition(runId, 'running', expectedVersion);
  }

  public cancelRun(
    runId: string,
    expectedVersion?: number
  ): RunEngineResult<RunRecord> {
    return this.applyRunTransition(runId, 'cancelled', expectedVersion);
  }

  public getRun(runId: string): RunRecord | null {
    const row = this.database.read(
      (connection) =>
        connection
          .prepare(
            `SELECT id, goal, status, current_plan_id AS currentPlanId,
                    cancel_requested AS cancelRequested, created_at AS createdAt,
                    started_at AS startedAt, completed_at AS completedAt, version
             FROM runs
             WHERE id = ?`
          )
          .get(runId) as RunRow | undefined
    );

    return row ? mapRunRow(row) : null;
  }

  public getActivePlan(runId: string): Plan | null {
    const row = this.database.read(
      (connection) =>
        connection
          .prepare(
            `SELECT id, run_id AS runId, version, status,
                    plan_json AS planJson, created_at AS createdAt
             FROM plans
             WHERE run_id = ? AND status = 'active'
             ORDER BY version DESC
             LIMIT 1`
          )
          .get(runId) as PlanRow | undefined
    );

    return row ? mapPlanRow(row) : null;
  }

  public getEvents(runId: string, afterSeq = 0): ServiceEvent[] {
    return this.events.listAfter(runId, afterSeq);
  }

  private applyRunTransition(
    runId: string,
    to: RunStatus,
    expectedVersion?: number
  ): RunEngineResult<RunRecord> {
    const loaded = this.getRun(runId);
    if (!loaded) {
      return {
        ok: false,
        error: { code: 'RUN_NOT_FOUND', message: `Run ${runId} was not found.`, runId }
      };
    }

    if (expectedVersion !== undefined && loaded.version !== expectedVersion) {
      return conflictError(runId, expectedVersion, loaded.version);
    }

    const transition = transitionRun(loaded, to);
    if (!transition.ok) {
      return invalidTransitionError(transition.error, runId);
    }

    try {
      return this.database.write((connection) => {
        this.updateRunCas(connection, transition.value, loaded.version);
        const event = this.events.appendInTransaction(
          connection,
          runId,
          transition.event.type,
          transition.event.payload
        );

        return {
          ok: true,
          value: { ...transition.value, version: loaded.version + 1 },
          events: [event]
        };
      });
    } catch (error) {
      if (error instanceof RunVersionConflictError) {
        return conflictError(runId, error.expectedVersion);
      }
      throw error;
    }
  }

  private updateRunCas(
    connection: Database.Database,
    next: Run,
    expectedVersion: number
  ): void {
    const result = connection
      .prepare(
        `UPDATE runs
         SET status = ?, current_plan_id = ?, cancel_requested = ?,
             started_at = ?, completed_at = ?, version = ?
         WHERE id = ? AND version = ?`
      )
      .run(
        next.status,
        next.currentPlanId,
        next.cancelRequested ? 1 : 0,
        next.startedAt,
        next.completedAt,
        expectedVersion + 1,
        next.id,
        expectedVersion
      );

    if (result.changes !== 1) {
      throw new RunVersionConflictError(next.id, expectedVersion);
    }
  }

  private updatePlanStatus(
    connection: Database.Database,
    planId: string,
    status: PlanStatus
  ): void {
    const result = connection
      .prepare('UPDATE plans SET status = ? WHERE id = ?')
      .run(status, planId);

    if (result.changes !== 1) {
      throw new Error(`Plan ${planId} could not be updated to ${status}.`);
    }
  }
}
