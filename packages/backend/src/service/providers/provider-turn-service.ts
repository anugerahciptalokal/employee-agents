import type { ProviderEvent, TurnRequest } from '@open-employee/contracts/contracts/provider';
import type { CredentialBroker } from '../credentials/credential-broker';
import type { ToolCatalog } from '../tools/catalog';
import { cancelledFinish, providerError } from './adapter-shared';
import {
  createOpenRouterRuntimeFromEnv,
  OpenRouterProviderRuntime
} from './openrouter-runtime';
import {
  ModelCatalogManager,
  type ModelSelectionResult
} from './model-catalog-manager';
import type { OpenRouterModelCatalogResult } from './model-catalog';

export interface ProviderTurnServiceOptions {
  runtime: OpenRouterProviderRuntime;
  modelCatalog: ModelCatalogManager;
}

export interface ProviderTurnServiceEnvOptions {
  toolCatalog?: ToolCatalog;
  fetchImpl?: typeof fetch;
  modelTtlMs?: number;
}

export class ProviderTurnService {
  private readonly runtime: OpenRouterProviderRuntime;
  private readonly modelCatalog: ModelCatalogManager;

  constructor(options: ProviderTurnServiceOptions) {
    this.runtime = options.runtime;
    this.modelCatalog = options.modelCatalog;
  }

  public get selectedModel() {
    return this.modelCatalog.selectedModel;
  }

  public async discoverModels(
    signal?: AbortSignal
  ): Promise<OpenRouterModelCatalogResult> {
    const result = await this.modelCatalog.refresh(signal);
    if (!signal?.aborted && result.error?.code !== 'cancelled') {
      this.runtime.applyModelCatalogResult(result);
    }
    return result;
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

    const result = await this.modelCatalog.ensureFresh(signal);
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

    this.runtime.applyModelCatalogResult(result);
    return this.modelCatalog.selectModel(modelId, signal);
  }

  public async cancel(turnId: string): Promise<void> {
    await this.runtime.cancel(turnId);
  }

  public async *startTurn(
    request: TurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    if (signal.aborted) {
      yield cancelledFinish();
      return;
    }

    const result = await this.modelCatalog.ensureFresh(signal);
    if (signal.aborted || result.error?.code === 'cancelled') {
      yield cancelledFinish();
      return;
    }

    this.runtime.applyModelCatalogResult(result);
    yield* this.runtime.startTurn(request, signal);
  }
}

export function createProviderTurnServiceFromEnv(
  env: NodeJS.ProcessEnv,
  credentialBroker: CredentialBroker,
  options: ProviderTurnServiceEnvOptions = {}
): ProviderTurnService | null {
  const runtime = createOpenRouterRuntimeFromEnv(env, credentialBroker, {
    toolCatalog: options.toolCatalog,
    fetchImpl: options.fetchImpl
  });
  if (!runtime) return null;

  return new ProviderTurnService({
    runtime,
    modelCatalog: new ModelCatalogManager({
      catalog: runtime.modelCatalog,
      ttlMs: options.modelTtlMs
    })
  });
}
