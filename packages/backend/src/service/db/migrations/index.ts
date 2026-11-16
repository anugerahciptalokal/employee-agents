import type Database from 'better-sqlite3';
import { migration001 } from './001_initial';
import type { Migration } from './types';

export type { Migration } from './types';

export const MIGRATIONS: readonly Migration[] = [migration001];

export type MigrationErrorCode =
  | 'MIGRATION_PLAN_INVALID'
  | 'DATABASE_NEWER_THAN_SERVICE'
  | 'MIGRATION_FAILED';

export class MigrationError extends Error {
  public readonly code: MigrationErrorCode;
  public readonly version?: number;

  constructor(
    code: MigrationErrorCode,
    message: string,
    options: { cause?: unknown; version?: number } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MigrationError';
    this.code = code;
    this.version = options.version;
  }
}

function getUserVersion(database: Database.Database): number {
  return database.pragma('user_version', { simple: true }) as number;
}

function validateMigrationPlan(migrations: readonly Migration[]): void {
  const seen = new Set<number>();

  for (const migration of migrations) {
    if (seen.has(migration.version)) {
      throw new MigrationError(
        'MIGRATION_PLAN_INVALID',
        `Migration plan contains duplicate versions at ${migration.version}.`
      );
    }
    seen.add(migration.version);
  }

  for (let index = 1; index < migrations.length; index += 1) {
    const previous = migrations[index - 1];
    const current = migrations[index];
    if (current.version < previous.version) {
      throw new MigrationError(
        'MIGRATION_PLAN_INVALID',
        `Migration plan must be sorted by version; found ${current.version} after ${previous.version}.`
      );
    }
  }

  if (migrations.length > 0 && migrations[0].version !== 1) {
    throw new MigrationError(
      'MIGRATION_PLAN_INVALID',
      'Migration plan must start at version 1.'
    );
  }

  for (let index = 1; index < migrations.length; index += 1) {
    const expected = migrations[index - 1].version + 1;
    if (migrations[index].version !== expected) {
      throw new MigrationError(
        'MIGRATION_PLAN_INVALID',
        `Migration plan must be contiguous; expected version ${expected}, found ${migrations[index].version}.`
      );
    }
  }
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS
): number {
  validateMigrationPlan(migrations);

  const currentVersion = getUserVersion(database);
  const latestVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;

  if (currentVersion > latestVersion) {
    throw new MigrationError(
      'DATABASE_NEWER_THAN_SERVICE',
      `Execution database version ${currentVersion} is newer than the service version ${latestVersion}.`
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    try {
      database
        .transaction(() => {
          migration.up(database);
          database.pragma(`user_version = ${migration.version}`);
        })
        .immediate();
    } catch (error) {
      throw new MigrationError(
        'MIGRATION_FAILED',
        `Migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error, version: migration.version }
      );
    }

    if (getUserVersion(database) !== migration.version) {
      throw new MigrationError(
        'MIGRATION_FAILED',
        `Migration ${migration.version} (${migration.name}) did not commit its user_version.`,
        { version: migration.version }
      );
    }
  }

  return getUserVersion(database);
}
