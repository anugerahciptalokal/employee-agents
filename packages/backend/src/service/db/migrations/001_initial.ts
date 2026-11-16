import type { Migration } from './types';

export const migration001: Migration = {
  version: 1,
  name: 'initial_execution_schema',
  up(database) {
    database.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        current_plan_id TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        version INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE plans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, version),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT
      );

      CREATE TABLE run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        depends_on_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 0,
        UNIQUE (plan_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT,
        FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT
      );

      CREATE TABLE events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (run_id, seq),
        FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_runs_status ON runs(status);
      CREATE INDEX idx_plans_run_id ON plans(run_id);
      CREATE INDEX idx_run_steps_run_id ON run_steps(run_id);
      CREATE INDEX idx_run_steps_plan_id ON run_steps(plan_id);
    `);
  }
};
