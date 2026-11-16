import { existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';

export interface DataLayoutPaths {
  rootDir: string;
  dbDir: string;
  secretsDir: string;
  configDir: string;
  stateDir: string;
  storageDir: string;
  runtimeDir: string;
  dbPath: string;
  vaultPath: string;
  vaultKeyPath: string;
  pairingSecretPath: string;
  configPath: string;
  memoryPath: string;
  agentsDir: string;
  channelsDir: string;
  attachmentsDir: string;
  artifactsDir: string;
  sandboxesDir: string;
  browserSessionsDir: string;
}

export interface DataMigrationResult {
  moved: string[];
  skipped: string[];
}

export function getDataRootDir(): string {
  const override = process.env.OPEN_EMPLOYEE_DATA_DIR?.trim();
  return override ? resolve(override) : resolve(process.cwd(), '.data');
}

export function getDataPath(...segments: string[]): string {
  return resolve(getDataRootDir(), ...segments);
}

/**
 * Resolves lifecycle-grouped subdirectories and canonical file paths under the data root.
 */
export function getDataLayoutPaths(dataRoot?: string): DataLayoutPaths {
  const rootDir = dataRoot ? resolve(dataRoot) : getDataRootDir();
  const dbDir = resolve(rootDir, 'db');
  const secretsDir = resolve(rootDir, 'secrets');
  const configDir = resolve(rootDir, 'config');
  const stateDir = resolve(rootDir, 'state');
  const storageDir = resolve(rootDir, 'storage');
  const runtimeDir = resolve(rootDir, 'runtime');

  return {
    rootDir,
    dbDir,
    secretsDir,
    configDir,
    stateDir,
    storageDir,
    runtimeDir,
    dbPath: resolve(dbDir, 'open-employee.db'),
    vaultPath: resolve(secretsDir, 'vault.json'),
    vaultKeyPath: resolve(secretsDir, '.vault.key'),
    pairingSecretPath: resolve(secretsDir, '.pairing-secret'),
    configPath: resolve(configDir, 'config.json'),
    memoryPath: resolve(stateDir, 'memory.json'),
    agentsDir: resolve(stateDir, 'agents'),
    channelsDir: resolve(stateDir, 'channels'),
    attachmentsDir: resolve(storageDir, 'attachments'),
    artifactsDir: resolve(storageDir, 'artifacts'),
    sandboxesDir: resolve(storageDir, 'sandboxes'),
    browserSessionsDir: resolve(runtimeDir, 'browser-sessions')
  };
}

/**
 * Non-destructively migrates legacy flat `.data/` files and directories into lifecycle subdirectories.
 * Never overwrites an existing target path.
 */
export function migrateLegacyDataLayout(dataRoot?: string): DataMigrationResult {
  const layout = getDataLayoutPaths(dataRoot);
  const moved: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(layout.rootDir)) {
    return { moved, skipped };
  }

  const mappings: Array<[string, string]> = [
    ['open-employee.db', layout.dbPath],
    ['open-employee.db-wal', `${layout.dbPath}-wal`],
    ['open-employee.db-shm', `${layout.dbPath}-shm`],
    ['vault.json', layout.vaultPath],
    ['.vault.key', layout.vaultKeyPath],
    ['.pairing-secret', layout.pairingSecretPath],
    ['config.json', layout.configPath],
    ['memory.json', layout.memoryPath],
    ['agents', layout.agentsDir],
    ['channels', layout.channelsDir],
    ['attachments', layout.attachmentsDir],
    ['artifacts', layout.artifactsDir],
    ['sandboxes', layout.sandboxesDir],
    ['browser-sessions', layout.browserSessionsDir]
  ];

  for (const [legacyName, targetPath] of mappings) {
    const legacyPath = resolve(layout.rootDir, legacyName);
    if (!existsSync(legacyPath)) {
      continue;
    }
    if (existsSync(targetPath)) {
      skipped.push(legacyName);
      continue;
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    renameSync(legacyPath, targetPath);
    moved.push(legacyName);
  }

  return { moved, skipped };
}
