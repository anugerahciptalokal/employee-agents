import type {
  RunStatus,
  ServiceEvent,
  StepKind,
  StepStatus
} from '@open-employee/contracts/contracts/service';
import type { ExecutionDatabase } from '../db/database';
import { EventStore } from './event-store';
import type { LockMode } from './service-lock';
import { canTransitionRun, canTransitionStep } from './transitions';

const ALL_NON_TERMINAL_RUN_STATUSES = [
  'queued',
  'planning',
  'running',
  'waiting_approval',
  'paused',
  'verifying'
] as const;

const CLEAN_ACTIVE_RUN_STATUSES = [
  'planning',
  'running',
  'waiting_approval',
  'verifying'
] as const;

interface RunRow {
  id: string;
  status: string;
}

interface StepRow {
  id: string;
  runId: string;
  planId: string;
  kind: StepKind;
}

export interface RecoveryResult {
  mode: LockMode;
  runsInterrupted: number;
  stepsInterrupted: number;
  stepsNeedingVerification: number;
  events: ServiceEvent[];
}

export class RecoveryManager {
  constructor(
    private readonly database: ExecutionDatabase,
    private readonly events = new EventStore(database)
  ) {}

  public recover(mode: LockMode): RecoveryResult {
    const statuses =
      mode === 'clean' ? CLEAN_ACTIVE_RUN_STATUSES : ALL_NON_TERMINAL_RUN_STATUSES;
    const placeholders = statuses.map(() => '?').join(', ');

    return this.database.write((connection) => {
      const runs = connection
        .prepare(
          `SELECT id, status FROM runs
           WHERE status IN (${placeholders})
           ORDER BY created_at ASC`
        )
        .all(...statuses) as RunRow[];

      const events: ServiceEvent[] = [];
      let runsInterrupted = 0;
      let stepsInterrupted = 0;
      let stepsNeedingVerification = 0;

      for (const run of runs) {
        const fromStatus = run.status as RunStatus;
        if (!canTransitionRun(fromStatus, 'interrupted')) {
          throw new Error(
            `Recovery cannot move run ${run.id} from ${fromStatus} to interrupted.`
          );
        }

        const runUpdate = connection
          .prepare(
            `UPDATE runs
             SET status = 'interrupted', version = version + 1
             WHERE id = ? AND status = ?`
          )
          .run(run.id, run.status);

        if (runUpdate.changes !== 1) continue;
        runsInterrupted += 1;

        events.push(
          this.events.appendInTransaction(
            connection,
            run.id,
            'run.interrupted',
            {
              runId: run.id,
              from: run.status,
              to: 'interrupted',
              reason: mode
            }
          )
        );

        const steps = connection
          .prepare(
            `SELECT id, run_id AS runId, plan_id AS planId, kind
             FROM run_steps
             WHERE run_id = ? AND status = 'running'
             ORDER BY seq ASC`
          )
          .all(run.id) as StepRow[];

        for (const step of steps) {
          const target: StepStatus =
            step.kind === 'read' ? 'interrupted' : 'needs_verification';

          if (!canTransitionStep('running', target)) {
            throw new Error(
              `Recovery cannot move step ${step.id} from running to ${target}.`
            );
          }

          const stepUpdate = connection
            .prepare(
              `UPDATE run_steps
               SET status = ?, version = version + 1
               WHERE id = ? AND status = 'running'`
            )
            .run(target, step.id);

          if (stepUpdate.changes !== 1) continue;

          if (target === 'interrupted') {
            stepsInterrupted += 1;
          } else {
            stepsNeedingVerification += 1;
          }

          events.push(
            this.events.appendInTransaction(
              connection,
              run.id,
              target === 'interrupted'
                ? 'step.interrupted'
                : 'step.needs_verification',
              {
                stepId: step.id,
                runId: step.runId,
                planId: step.planId,
                from: 'running',
                to: target,
                kind: step.kind,
                reason: mode
              }
            )
          );
        }
      }

      return {
        mode,
        runsInterrupted,
        stepsInterrupted,
        stepsNeedingVerification,
        events
      };
    });
  }
}
