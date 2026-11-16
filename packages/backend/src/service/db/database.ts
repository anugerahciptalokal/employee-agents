import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { resolveAgentHarnessDbPath } from './paths';
import { runMigrations } from './migrations';

export interface ExecutionDatabaseOptions {
  dataDir?: string;
  dbPath?: string;
}

export class ExecutionDatabase {
  private readonly database: Database.Database;
  private readonly readDatabase!: Database.Database;
  private readonly filePath: string;
  private writing = false;

  constructor(options: ExecutionDatabaseOptions) {
    const dbPath =
      options.dbPath ?? (options.dataDir ? resolveAgentHarnessDbPath(options.dataDir) : null);

    if (!dbPath) {
      throw new Error('ExecutionDatabase requires a dataDir or dbPath.');
    }

    const directory = dirname(dbPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    this.filePath = dbPath;
    this.database = new Database(dbPath);

    try {
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('foreign_keys = ON');
      this.database.pragma('busy_timeout = 5000');
      runMigrations(this.database);

      this.readDatabase = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.readDatabase.pragma('foreign_keys = ON');
      this.readDatabase.pragma('busy_timeout = 5000');
    } catch (error) {
      if (this.readDatabase?.open) this.readDatabase.close();
      this.database.close();
      throw error;
    }
  }

  public get path(): string {
    return this.filePath;
  }

  public get userVersion(): number {
    return this.database.pragma('user_version', { simple: true }) as number;
  }

  public read<T>(reader: (database: Database.Database) => T): T {
    return reader(this.readDatabase);
  }

  public write<T>(writer: (database: Database.Database) => T): T {
    if (this.writing) {
      throw new Error('Nested execution database write is not allowed.');
    }

    this.writing = true;
    try {
      return this.database.transaction(() => writer(this.database)).immediate();
    } finally {
      this.writing = false;
    }
  }

  public close(): void {
    if (this.readDatabase?.open) {
      this.readDatabase.close();
    }
    if (this.database.open) {
      this.database.close();
    }
  }
}
