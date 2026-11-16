import type { ProviderError } from '@open-employee/contracts/contracts/provider';
import { providerError } from './adapter-shared';
import type {
  OpenRouterModel,
  OpenRouterModelCatalogResult
} from './model-catalog';

export interface ModelCatalogSource {
  getConfiguredModel(): OpenRouterModel;
  discover(signal?: AbortSignal): Promise<OpenRouterModelCatalogResult>;
}

export interface ModelCatalogManagerOptions {
  catalog: ModelCatalogSource;
  ttlMs?: number;
  now?: () => number;
}

export type ModelSelectionResult =
  | {
      ok: true;
      model: OpenRouterModel;
      source: 'discovery' | 'configured';
    }
  | {
      ok: false;
      error: ProviderError;
    };

const DEFAULT_TTL_MS = 300_000;

interface InflightCaller {
  resolve: (result: OpenRouterModelCatalogResult) => void;
  cleanup: () => void;
  settled: boolean;
}

interface InflightDiscovery {
  sharedController: AbortController;
  activeCallers: Set<InflightCaller>;
  aborted: boolean;
  promise: Promise<OpenRouterModelCatalogResult>;
}

function createCancelledResult(
  configuredModel: OpenRouterModel
): OpenRouterModelCatalogResult {
  return {
    models: [configuredModel],
    configuredModel,
    source: 'configured',
    error: providerError(
      'cancelled',
      'Provider request was cancelled.',
      { retryable: false }
    )
  };
}

export class ModelCatalogManager {
  private readonly catalog: ModelCatalogSource;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private cached: OpenRouterModelCatalogResult | null = null;
  private fetchedAt = 0;
  private inflight: InflightDiscovery | null = null;
  private selected: OpenRouterModel;

  constructor(options: ModelCatalogManagerOptions) {
    this.catalog = options.catalog;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.selected = this.catalog.getConfiguredModel();
  }

  public get selectedModel(): OpenRouterModel {
    return this.selected;
  }

  public get cachedResult(): OpenRouterModelCatalogResult | null {
    return this.cached;
  }

  public getConfiguredModel(): OpenRouterModel {
    return this.catalog.getConfiguredModel();
  }

  public async refresh(
    signal?: AbortSignal
  ): Promise<OpenRouterModelCatalogResult> {
    if (signal?.aborted) {
      return createCancelledResult(this.getConfiguredModel());
    }

    const entry = this.getOrCreateInflight();

    return new Promise<OpenRouterModelCatalogResult>((resolve) => {
      let abortListener: (() => void) | undefined;
      const caller: InflightCaller = {
        resolve,
        settled: false,
        cleanup: () => {
          if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener);
            abortListener = undefined;
          }
        }
      };

      entry.activeCallers.add(caller);

      if (signal) {
        abortListener = () => {
          if (caller.settled) return;
          caller.settled = true;
          caller.cleanup();
          entry.activeCallers.delete(caller);

          if (entry.activeCallers.size === 0 && !entry.aborted) {
            entry.aborted = true;
            if (this.inflight === entry) {
              this.inflight = null;
            }
            entry.sharedController.abort();
          }

          resolve(createCancelledResult(this.getConfiguredModel()));
        };

        if (signal.aborted) {
          abortListener();
          return;
        }

        signal.addEventListener('abort', abortListener, { once: true });
      }
    });
  }

  private getOrCreateInflight(): InflightDiscovery {
    if (
      this.inflight &&
      !this.inflight.aborted &&
      !this.inflight.sharedController.signal.aborted
    ) {
      return this.inflight;
    }

    const sharedController = new AbortController();
    const activeCallers = new Set<InflightCaller>();
    const entry: InflightDiscovery = {
      sharedController,
      activeCallers,
      aborted: false,
      promise: Promise.resolve(createCancelledResult(this.getConfiguredModel()))
    };

    this.inflight = entry;

    entry.promise = this.catalog
      .discover(sharedController.signal)
      .catch((): OpenRouterModelCatalogResult => {
        const configuredModel = this.getConfiguredModel();
        if (entry.aborted || sharedController.signal.aborted) {
          return createCancelledResult(configuredModel);
        }
        return {
          models: [configuredModel],
          configuredModel,
          source: 'configured',
          error: providerError(
            'unknown',
            'OpenRouter model discovery failed.',
            { retryable: false }
          )
        };
      })
      .then((result) => {
        const isCancelled =
          entry.aborted ||
          sharedController.signal.aborted ||
          result.error?.code === 'cancelled';

        if (!isCancelled && this.inflight === entry) {
          this.cached = result;
          this.fetchedAt = this.now();
        }

        if (this.inflight === entry) {
          this.inflight = null;
        }

        const finalResult = isCancelled
          ? createCancelledResult(this.getConfiguredModel())
          : result;

        const callers = [...entry.activeCallers];
        entry.activeCallers.clear();
        for (const caller of callers) {
          if (!caller.settled) {
            caller.settled = true;
            caller.cleanup();
            caller.resolve(finalResult);
          }
        }

        return finalResult;
      })
      .finally(() => {
        if (this.inflight === entry) {
          this.inflight = null;
        }
      });

    return entry;
  }

  public async ensureFresh(
    signal?: AbortSignal
  ): Promise<OpenRouterModelCatalogResult> {
    if (signal?.aborted) {
      return createCancelledResult(this.getConfiguredModel());
    }
    if (this.cached && this.now() - this.fetchedAt < this.ttlMs) {
      return this.cached;
    }
    return this.refresh(signal);
  }

  public async selectModel(
    modelId: string,
    signal?: AbortSignal
  ): Promise<ModelSelectionResult> {
    if (signal?.aborted) {
      return {
        ok: false,
        error: providerError(
          'cancelled',
          'Provider request was cancelled.',
          { retryable: false }
        )
      };
    }

    const result = await this.ensureFresh(signal);
    if (signal?.aborted || result.error?.code === 'cancelled') {
      return {
        ok: false,
        error:
          result.error ??
          providerError(
            'cancelled',
            'Provider request was cancelled.',
            { retryable: false }
          )
      };
    }

    const discovered = result.models.find((model) => model.modelId === modelId);
    if (discovered) {
      this.selected = discovered;
      return { ok: true, model: discovered, source: 'discovery' };
    }

    const configured = this.getConfiguredModel();
    if (modelId === configured.modelId) {
      this.selected = configured;
      return { ok: true, model: configured, source: 'configured' };
    }

    return {
      ok: false,
      error: providerError(
        'invalid_request',
        'Model is not configured or discovered for OpenRouter.'
      )
    };
  }

  public invalidate(): void {
    const current = this.inflight;
    this.inflight = null;
    if (current && !current.aborted) {
      current.aborted = true;
      current.sharedController.abort();
    }
    this.cached = null;
    this.fetchedAt = 0;
    this.selected = this.getConfiguredModel();
  }
}
