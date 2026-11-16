import { randomUUID } from 'crypto';
import {
  STEP_KINDS,
  type RunStep,
  type StepKind
} from '@open-employee/contracts/contracts/service';
import type { ExecutionDatabase } from '../db/database';

export type RunStepCreateErrorCode =
  | 'RUN_NOT_FOUND'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_NOT_IN_RUN'
  | 'VALIDATION_ERROR';

export interface RunStepCreateError {
  code: RunStepCreateErrorCode;
  message: string;
}

export type RunStepCreateResult =
  | {
      ok: true;
      value: RunStep;
    }
  | {
      ok: false;
      error: RunStepCreateError;
    };

export interface CreateRunStepInput {
  runId: string;
  planId: string;
  title: string;
  kind: StepKind;
  dependsOn?: string[];
}

function errorResult(
  code: RunStepCreateErrorCode,
  message: string
): RunStepCreateResult {
  return { ok: false, error: { code, message } };
}

export class RunStepRepository {
  constructor(private readonly database: ExecutionDatabase) {}

  public create(input: CreateRunStepInput): RunStepCreateResult {
    const title = input.title.trim();
    if (!title) {
      return errorResult('VALIDATION_ERROR', 'Run step title is required.');
    }

    if (!STEP_KINDS.includes(input.kind)) {
      return errorResult('VALIDATION_ERROR', `Unknown run step kind: ${input.kind}`);
    }

    return this.database.write((connection) => {
      const run = connection
        .prepare('SELECT id FROM runs WHERE id = ?')
        .get(input.runId);

      if (!run) {
        return errorResult('RUN_NOT_FOUND', `Run ${input.runId} was not found.`);
      }

      const plan = connection
        .prepare('SELECT run_id AS runId FROM plans WHERE id = ?')
        .get(input.planId) as { runId: string } | undefined;

      if (!plan) {
        return errorResult('PLAN_NOT_FOUND', `Plan ${input.planId} was not found.`);
      }

      if (plan.runId !== input.runId) {
        return errorResult(
          'PLAN_NOT_IN_RUN',
          `Plan ${input.planId} does not belong to run ${input.runId}.`
        );
      }

      const sequence = connection
        .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM run_steps WHERE plan_id = ?')
        .get(input.planId) as { seq: number };

      const step: RunStep = {
        id: randomUUID(),
        runId: input.runId,
        planId: input.planId,
        seq: sequence.seq + 1,
        title,
        kind: input.kind,
        status: 'pending',
        dependsOn: input.dependsOn ?? [],
        createdAt: Date.now()
      };

      connection
        .prepare(
          `INSERT INTO run_steps
            (id, run_id, plan_id, seq, title, kind, status, depends_on_json, created_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          step.id,
          step.runId,
          step.planId,
          step.seq,
          step.title,
          step.kind,
          step.status,
          JSON.stringify(step.dependsOn),
          step.createdAt,
          0
        );

      return { ok: true, value: step };
    });
  }
}
