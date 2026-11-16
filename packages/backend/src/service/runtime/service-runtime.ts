import { ExecutionDatabase } from '../db/database';
import { ServiceApiServer, type ServiceApiAddress } from '../api/server';
import { EventStore } from './event-store';
import { RunEngine } from './run-engine';
import { RecoveryManager, type RecoveryResult } from './recovery';
import { ServiceLock, type LockMode } from './service-lock';
import type { CredentialBroker } from '../credentials/credential-broker';
import type { ProviderTurnService } from '../providers/provider-turn-service';

export interface StartServiceOptions {
  dataDir: string;
  token: string;
  heartbeatIntervalMs?: number;
  credentialBroker?: CredentialBroker;
  providerTurnService?: ProviderTurnService;
}

export class ServiceRuntime {
  private stopped = false;

  constructor(
    private readonly lock: ServiceLock,
    private readonly database: ExecutionDatabase,
    private readonly api: ServiceApiServer,
    public readonly recoveryResult: RecoveryResult,
    public readonly lockMode: LockMode,
    public readonly credentialBroker?: CredentialBroker,
    public readonly providerTurnService?: ProviderTurnService
  ) {}

  public get address(): ServiceApiAddress {
    const address = this.api.address;
    if (!address) {
      throw new Error('Service API is not running.');
    }
    return address;
  }

  public get lockPath(): string {
    return this.lock.lockPath;
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.credentialBroker?.dispose?.();

    let firstError: unknown;

    try {
      await this.api.stop();
    } catch (error) {
      firstError = error;
    }

    try {
      this.lock.stopHeartbeat();
      this.database.close();
      this.lock.release(true);
    } catch (error) {
      if (firstError === undefined) {
        firstError = error;
      }
    }

    if (firstError !== undefined) {
      throw firstError;
    }
  }
}

export async function startService(
  options: StartServiceOptions
): Promise<ServiceRuntime> {
  if (!options.dataDir) {
    options.credentialBroker?.dispose?.();
    throw new Error('Service data directory is required.');
  }
  if (!options.token) {
    options.credentialBroker?.dispose?.();
    throw new Error('Service token is required.');
  }

  // The lock must be acquired before the execution database is opened.
  const lock = new ServiceLock({
    dataDir: options.dataDir,
    heartbeatIntervalMs: options.heartbeatIntervalMs
  });
  let acquisition: ReturnType<typeof lock.acquire>;
  try {
    acquisition = lock.acquire();
  } catch (error) {
    options.credentialBroker?.dispose?.();
    throw error;
  }
  lock.startHeartbeat();

  let database: ExecutionDatabase | null = null;
  let api: ServiceApiServer | null = null;

  try {
    database = new ExecutionDatabase({ dataDir: options.dataDir });
    const events = new EventStore(database);
    const engine = new RunEngine(database, events);
    const recovery = new RecoveryManager(database, events);
    const recoveryResult = recovery.recover(acquisition.mode);

    api = new ServiceApiServer({
      runEngine: engine,
      token: options.token,
      heartbeatIntervalMs: options.heartbeatIntervalMs
    });
    await api.start();

    return new ServiceRuntime(
      lock,
      database,
      api,
      recoveryResult,
      acquisition.mode,
      options.credentialBroker,
      options.providerTurnService
    );
  } catch (error) {
    if (api) {
      try {
        await api.stop();
      } catch {
        // preserve the startup error
      }
    }
    if (database) {
      try {
        database.close();
      } catch {
        // preserve the startup error
      }
    }

    lock.stopHeartbeat();
    try {
      lock.release(false);
    } catch {
      // preserve the startup error
    }

    options.credentialBroker?.dispose?.();
    throw error;
  }
}
