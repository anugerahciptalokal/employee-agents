import fs from 'fs';
import path from 'path';
import { WorkspaceDatabase } from '../core/db';
import { FileManager } from '../core/file/file-manager';
import { VaultManager } from '../core/vault/vault-manager';
import { NodeSafeStorageAdapter } from './node-safe-storage';
import { getDataLayoutPaths } from '../core/data-root';
import {
  resolveOwnerConfigDir,
  resolveOwnerSecretsDir,
  resolveWorkspaceRoot
} from './tenant-paths';

export interface WorkspaceRuntimeContext {
  ownerUserId: string;
  workspaceId: string;
  workspaceRoot: string;
  db: WorkspaceDatabase;
  fileManager: FileManager;
  vault: VaultManager;
  memoryPath: string;
}

export interface EnterpriseTenantPoolOptions {
  dataDir: string;
}

/**
 * Manages global defaults alongside per-owner (Vault, Config) and per-workspace
 * (WorkspaceDatabase, FileManager, memory) runtime instances in Enterprise mode.
 */
export class EnterpriseTenantPool {
  private readonly dataDir: string;
  private readonly ownerVaults = new Map<string, VaultManager>();
  private readonly workspaceRuntimes = new Map<string, WorkspaceRuntimeContext>();

  constructor(options: EnterpriseTenantPoolOptions) {
    this.dataDir = options.dataDir;
  }

  private readJsonSafe(filePath: string): Record<string, unknown> {
    try {
      if (!fs.existsSync(filePath)) return {};
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Merges global system config (`<dataDir>/config/config.json`) with
   * owner-specific overrides (`<dataDir>/users/<ownerId>/config/config.json`).
   */
  public getEffectiveConfig(ownerUserId?: string): Record<string, unknown> {
    const globalConfigPath = path.join(this.dataDir, 'config', 'config.json');
    const globalConfig = this.readJsonSafe(globalConfigPath);
    if (!ownerUserId) return globalConfig;

    const ownerConfigPath = path.join(resolveOwnerConfigDir(this.dataDir, ownerUserId), 'config.json');
    const ownerConfig = this.readJsonSafe(ownerConfigPath);
    return { ...globalConfig, ...ownerConfig };
  }

  /**
   * Returns an isolated VaultManager stored strictly inside `<dataDir>/users/<ownerId>/secrets/`.
   */
  public getOwnerVault(ownerUserId: string): VaultManager {
    const existing = this.ownerVaults.get(ownerUserId);
    if (existing) return existing;

    const secretsDir = resolveOwnerSecretsDir(this.dataDir, ownerUserId);
    fs.mkdirSync(secretsDir, { recursive: true });
    const vaultPath = path.join(secretsDir, 'vault.json');
    const vaultKeyPath = path.join(secretsDir, '.vault.key');
    const safeStorage = new NodeSafeStorageAdapter({ keyFilePath: vaultKeyPath });
    const vault = new VaultManager(vaultPath, { safeStorage });

    this.ownerVaults.set(ownerUserId, vault);
    return vault;
  }

  /**
   * Returns an isolated WorkspaceDatabase, FileManager, and memory path for `<ownerId>/workspaces/<workspaceId>`.
   */
  public getWorkspaceRuntime(ownerUserId: string, workspaceId: string): WorkspaceRuntimeContext {
    const cacheKey = `${ownerUserId}:${workspaceId}`;
    const existing = this.workspaceRuntimes.get(cacheKey);
    if (existing) return existing;

    const workspaceRoot = resolveWorkspaceRoot(this.dataDir, ownerUserId, workspaceId);
    const layout = getDataLayoutPaths(workspaceRoot);
    fs.mkdirSync(layout.dbDir, { recursive: true });
    fs.mkdirSync(layout.stateDir, { recursive: true });
    fs.mkdirSync(layout.storageDir, { recursive: true });

    const vault = this.getOwnerVault(ownerUserId);
    const db = new WorkspaceDatabase(layout.dbPath, {
      secretRedactor: (text) => vault.redactSecrets(text)
    });
    const fileManager = new FileManager(workspaceRoot);

    const ctx: WorkspaceRuntimeContext = {
      ownerUserId,
      workspaceId,
      workspaceRoot,
      db,
      fileManager,
      vault,
      memoryPath: layout.memoryPath
    };
    this.workspaceRuntimes.set(cacheKey, ctx);
    return ctx;
  }
}
