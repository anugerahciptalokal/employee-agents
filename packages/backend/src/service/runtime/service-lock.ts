import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'fs';
import { hostname } from 'os';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';

export const AGENT_HARNESS_LOCK_FILENAME = 'agent-harness.lock';

export function resolveServiceLockPath(dataDir: string): string {
  return resolve(dataDir, AGENT_HARNESS_LOCK_FILENAME);
}

export type LockMode = 'fresh' | 'clean' | 'crash';

export type ServiceLockErrorCode = 'LOCKED' | 'LOCK_INVALID' | 'LOCK_LOST' | 'LOCK_IO';

export interface ServiceLockFile {
  version: 1;
  instanceId: string;
  pid: number;
  hostname: string;
  startedAt: number;
  heartbeatAt: number;
  cleanShutdown: boolean;
  releasedAt?: number;
}

export interface LockAcquisition {
  mode: LockMode;
  previous?: ServiceLockFile;
}

export interface ServiceLockOptions {
  dataDir: string;
  lockPath?: string;
  instanceId?: string;
  pid?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}

export class ServiceLockError extends Error {
  constructor(
    public readonly code: ServiceLockErrorCode,
    message: string,
    public readonly lockPath?: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ServiceLockError';
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function isValidLock(value: unknown): value is ServiceLockFile {
  if (!value || typeof value !== 'object') return false;

  const lock = value as Record<string, unknown>;
  return (
    lock.version === 1 &&
    typeof lock.instanceId === 'string' &&
    typeof lock.pid === 'number' &&
    Number.isInteger(lock.pid) &&
    lock.pid > 0 &&
    typeof lock.hostname === 'string' &&
    typeof lock.startedAt === 'number' &&
    typeof lock.heartbeatAt === 'number' &&
    typeof lock.cleanShutdown === 'boolean'
  );
}

export class ServiceLock {
  private readonly lockPathValue: string;
  private readonly claimPathValue: string;
  private readonly instanceIdValue: string;
  private readonly pidValue: number;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: ServiceLockOptions) {
    this.lockPathValue = options.lockPath ?? resolveServiceLockPath(options.dataDir);
    this.claimPathValue = `${this.lockPathValue}.claim`;
    this.instanceIdValue = options.instanceId ?? randomUUID();
    this.pidValue = options.pid ?? process.pid;
    this.now = options.now ?? (() => Date.now());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15_000;
  }

  public get lockPath(): string {
    return this.lockPathValue;
  }

  public get instanceId(): string {
    return this.instanceIdValue;
  }

  public get claimPath(): string {
    return this.claimPathValue;
  }

  public acquire(): LockAcquisition {
    const directory = dirname(this.lockPathValue);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    const now = this.now();
    const existing = this.readLock();

    if (!existing) {
      this.writeNewLock(this.createLock(now));
      return { mode: 'fresh' };
    }

    const alive = this.isProcessAlive(existing.pid);
    const heartbeatStale = now - existing.heartbeatAt > this.heartbeatTimeoutMs;

    if (existing.cleanShutdown) {
      if (existing.pid !== this.pidValue && alive) {
        throw new ServiceLockError(
          'LOCKED',
          `Execution database lock is held by live process ${existing.pid}.`,
          this.lockPathValue
        );
      }

      return this.claimAndTakeOver(now, existing);
    }

    if (existing.pid === this.pidValue || alive) {
      throw new ServiceLockError(
        'LOCKED',
        `Execution database lock is held by process ${existing.pid}${
          heartbeatStale ? ' with a stale heartbeat' : ''
        }. Refusing to create a second writer.`,
        this.lockPathValue
      );
    }

    return this.claimAndTakeOver(now, existing);
  }

  public heartbeat(): void {
    const lock = this.readLock();
    if (!lock || lock.instanceId !== this.instanceIdValue) {
      throw new ServiceLockError(
        'LOCK_LOST',
        'Execution database lock is no longer owned by this instance.',
        this.lockPathValue
      );
    }

    lock.heartbeatAt = this.now();
    this.writeLockAtomically(lock);
  }

  public startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        this.stopHeartbeat();
      }
    }, this.heartbeatIntervalMs);
    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public release(clean = true): void {
    this.stopHeartbeat();

    const lock = this.readLock();
    if (!lock || lock.instanceId !== this.instanceIdValue) {
      throw new ServiceLockError(
        'LOCK_LOST',
        'Execution database lock is no longer owned by this instance.',
        this.lockPathValue
      );
    }

    const now = this.now();
    lock.cleanShutdown = clean;
    lock.heartbeatAt = now;
    lock.releasedAt = now;
    this.writeLockAtomically(lock);
  }

  private createLock(now: number): ServiceLockFile {
    return {
      version: 1,
      instanceId: this.instanceIdValue,
      pid: this.pidValue,
      hostname: hostname(),
      startedAt: now,
      heartbeatAt: now,
      cleanShutdown: false
    };
  }

  private readLock(): ServiceLockFile | null {
    if (!existsSync(this.lockPathValue)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.lockPathValue, 'utf-8'));
    } catch (error) {
      throw new ServiceLockError(
        'LOCK_INVALID',
        'Execution database lock file is not valid JSON.',
        this.lockPathValue,
        { cause: error }
      );
    }

    if (!isValidLock(parsed)) {
      throw new ServiceLockError(
        'LOCK_INVALID',
        'Execution database lock file has an invalid shape.',
        this.lockPathValue
      );
    }

    return parsed;
  }

  private writeNewLock(lock: ServiceLockFile): void {
    try {
      writeFileSync(this.lockPathValue, JSON.stringify(lock, null, 2), {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ServiceLockError(
          'LOCKED',
          'Execution database lock was created by another process.',
          this.lockPathValue,
          { cause: error }
        );
      }

      throw new ServiceLockError(
        'LOCK_IO',
        'Execution database lock could not be created.',
        this.lockPathValue,
        { cause: error }
      );
    }
  }

  private claimAndTakeOver(now: number, previous: ServiceLockFile): LockAcquisition {
    this.writeClaim(now);

    try {
      const current = this.readLock();

      if (!current) {
        this.writeNewLock(this.createLock(now));
        return {
          mode: previous.cleanShutdown ? 'clean' : 'crash',
          previous
        };
      }

      const alive = this.isProcessAlive(current.pid);

      if (current.cleanShutdown) {
        if (current.pid !== this.pidValue && alive) {
          throw new ServiceLockError(
            'LOCKED',
            `Execution database lock is held by live process ${current.pid}.`,
            this.lockPathValue
          );
        }

        this.replaceLock(now);
        return { mode: 'clean', previous: current };
      }

      if (current.pid === this.pidValue || alive) {
        throw new ServiceLockError(
          'LOCKED',
          `Execution database lock is held by process ${current.pid}. Refusing to create a second writer.`,
          this.lockPathValue
        );
      }

      this.replaceLock(now);
      return { mode: 'crash', previous: current };
    } finally {
      this.removeClaim();
    }
  }

  private writeClaim(now: number): void {
    try {
      writeFileSync(
        this.claimPathValue,
        JSON.stringify(
          {
            version: 1,
            instanceId: this.instanceIdValue,
            pid: this.pidValue,
            claimedAt: now
          },
          null,
          2
        ),
        {
          encoding: 'utf-8',
          flag: 'wx',
          mode: 0o600
        }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ServiceLockError(
          'LOCKED',
          'Another process is currently claiming the execution database lock.',
          this.lockPathValue,
          { cause: error }
        );
      }

      throw new ServiceLockError(
        'LOCK_IO',
        'Execution database lock claim could not be created.',
        this.lockPathValue,
        { cause: error }
      );
    }
  }

  private removeClaim(): void {
    try {
      unlinkSync(this.claimPathValue);
    } catch {
      // A stale claim blocks future takeover rather than allowing a second writer.
    }
  }

  private replaceLock(now: number): void {
    try {
      unlinkSync(this.lockPathValue);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ServiceLockError(
          'LOCK_IO',
          'Stale execution database lock could not be removed.',
          this.lockPathValue,
          { cause: error }
        );
      }
    }

    this.writeNewLock(this.createLock(now));
  }

  private writeLockAtomically(lock: ServiceLockFile): void {
    const temporaryPath = `${this.lockPathValue}.tmp-${process.pid}-${randomUUID()}`;

    try {
      writeFileSync(temporaryPath, JSON.stringify(lock, null, 2), {
        encoding: 'utf-8',
        mode: 0o600
      });
      renameSync(temporaryPath, this.lockPathValue);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // ignore cleanup failure
      }
      throw new ServiceLockError(
        'LOCK_IO',
        'Execution database lock could not be updated.',
        this.lockPathValue,
        { cause: error }
      );
    }
  }
}
