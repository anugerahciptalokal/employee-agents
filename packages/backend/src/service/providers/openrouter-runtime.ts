import type {
  ProviderConfig,
  ProviderEvent,
  TurnRequest
} from '@open-employee/contracts/contracts/provider';
import type { ToolDescriptor } from '@open-employee/contracts/contracts/tool';
import {
  createOpenRouterAdapter,
  createOpenRouterConfig,
  type OpenRouterProfileOptions
} from './openrouter';
import type { CredentialBroker } from '../credentials/credential-broker';
import { createOpenRouterCredentialResolver } from '../credentials/broker-client';
import { validateTurnRequest } from './contract-guards';
import {
  OpenRouterModelCatalog,
  type OpenRouterModel,
  type OpenRouterModelCatalogResult
} from './model-catalog';
import { ProviderConfigStore } from './provider-config';
import { ProviderRegistry } from './provider-registry';
import { ProviderRouter } from './provider-router';
import {
  errorEvent,
  providerError
} from './adapter-shared';
import type { ProviderAdapter } from './provider-runtime';
import { validateProviderConfig } from './provider-config';
import { ToolCatalog } from '../tools/catalog';

export class OpenRouterRuntimeError extends Error {
  constructor(
    public readonly code: 'INVALID_CONFIG' | 'INVALID_MODEL' | 'TOOL_CATALOG_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'OpenRouterRuntimeError';
  }
}

export interface OpenRouterProviderRuntimeOptions {
  config: ProviderConfig;
  credentialBroker: CredentialBroker;
  toolCatalog?: ToolCatalog;
  fetchImpl?: typeof fetch;
}

export interface OpenRouterRuntimeFromEnvOptions {
  toolCatalog?: ToolCatalog;
  fetchImpl?: typeof fetch;
}

export function isOpenRouterRuntimeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OPEN_EMPLOYEE_AI_PROVIDERS === '1';
}

export function createOpenRouterRuntimeFromEnv(
  env: NodeJS.ProcessEnv,
  credentialBroker: CredentialBroker,
  options: OpenRouterRuntimeFromEnvOptions = {}
): OpenRouterProviderRuntime | null {
  if (!isOpenRouterRuntimeEnabled(env)) return null;

  const model = env.OPENROUTER_MODEL?.trim();
  if (!model) return null;

  const profile: OpenRouterProfileOptions = {
    model,
    ...(env.OPENROUTER_CREDENTIAL_REF?.trim()
      ? { credentialRef: env.OPENROUTER_CREDENTIAL_REF.trim() }
      : {}),
    ...(env.OPENROUTER_BASE_URL?.trim()
      ? { baseUrl: env.OPENROUTER_BASE_URL.trim() }
      : {})
  };
  const config = createOpenRouterConfig(profile);
  if (!config.ok) return null;

  try {
    return new OpenRouterProviderRuntime({
      config: config.config,
      credentialBroker,
      toolCatalog: options.toolCatalog,
      fetchImpl: options.fetchImpl
    });
  } catch {
    return null;
  }
}

export class OpenRouterProviderRuntime {
  public readonly config: ProviderConfig;
  public readonly modelCatalog: OpenRouterModelCatalog;
  public readonly toolCatalog?: ToolCatalog;
  private readonly adapter: ProviderAdapter;
  private readonly router: ProviderRouter;
  private modelResult: OpenRouterModelCatalogResult | null = null;

  constructor(options: OpenRouterProviderRuntimeOptions) {
    const configValidation = validateProviderConfig(options.config);
    if (!configValidation.ok) {
      throw new OpenRouterRuntimeError(
        'INVALID_CONFIG',
        'OpenRouter runtime config is invalid.'
      );
    }
    if (configValidation.config.kind !== 'openai-compatible') {
      throw new OpenRouterRuntimeError(
        'INVALID_CONFIG',
        'OpenRouter runtime requires the OpenAI-compatible adapter kind.'
      );
    }

    this.config = configValidation.config;
    this.toolCatalog = options.toolCatalog;
    this.adapter = createOpenRouterAdapter({
      config: this.config,
      resolveCredential: createOpenRouterCredentialResolver(
        options.credentialBroker,
        'provider_turn'
      ),
      fetchImpl: options.fetchImpl
    });
    this.modelCatalog = new OpenRouterModelCatalog({
      config: this.config,
      resolveCredential: createOpenRouterCredentialResolver(
        options.credentialBroker,
        'model_discovery'
      ),
      fetchImpl: options.fetchImpl
    });

    const registry = new ProviderRegistry();
    registry.register(this.adapter);
    const configs = new ProviderConfigStore();
    configs.add(this.config);
    this.router = new ProviderRouter(registry, configs);
  }

  public async discoverModels(
    signal?: AbortSignal
  ): Promise<OpenRouterModelCatalogResult> {
    const result = await this.modelCatalog.discover(signal);
    if (result.source === 'discovery') {
      this.modelResult = result;
    }
    return result;
  }

  public get cachedModels(): OpenRouterModelCatalogResult | null {
    return this.modelResult;
  }

  public applyModelCatalogResult(result: OpenRouterModelCatalogResult): void {
    this.modelResult = result.source === 'discovery' ? result : null;
  }

  public async cancel(turnId: string): Promise<void> {
    await this.adapter.cancel(turnId);
  }

  public async *startTurn(
    request: TurnRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent> {
    const requestValidation = validateTurnRequest(request);
    if (!requestValidation.ok) {
      yield errorEvent(
        providerError('invalid_request', 'Turn request is invalid.')
      );
      return;
    }

    let tools: ToolDescriptor[] | undefined;
    if (request.tools && request.tools.length > 0) {
      if (!this.toolCatalog) {
        yield errorEvent(
          providerError(
            'unsupported_capability',
            'Tool catalog is not available.'
          )
        );
        return;
      }

      const toolValidation = this.toolCatalog.validateRequestTools(request.tools);
      if (!toolValidation.ok) {
        yield errorEvent(
          providerError('invalid_request', 'Tool descriptors are invalid.')
        );
        return;
      }
      tools = toolValidation.tools;
    }

    const configured = this.modelCatalog.getConfiguredModel();
    const discovered = this.modelResult?.models.find(
      (model) => model.modelId === request.model
    );
    const model: OpenRouterModel | null =
      discovered ??
      (request.model === configured.modelId ? configured : null);

    if (!model) {
      yield errorEvent(
        providerError(
          'invalid_request',
          'Model is not configured or discovered for OpenRouter.'
        )
      );
      return;
    }
    if (!model.capabilities.text) {
      yield errorEvent(
        providerError('unsupported_capability', 'Model does not support text.')
      );
      return;
    }
    if (tools && tools.length > 0 && !model.capabilities.tools) {
      yield errorEvent(
        providerError('unsupported_capability', 'Model does not support tools.')
      );
      return;
    }
    if (request.responseFormat === 'json' && !model.capabilities.jsonMode) {
      yield errorEvent(
        providerError(
          'unsupported_capability',
          'Model does not support JSON response format.'
        )
      );
      return;
    }

    const routed = this.router.resolve({
      ...request,
      ...(tools ? { tools } : {})
    });
    if (!routed.ok) {
      yield errorEvent(routed.error);
      return;
    }

    for await (const event of this.adapter.startTurn(
      {
        ...request,
        ...(tools ? { tools } : {})
      },
      { signal }
    )) {
      if (event.type === 'tool_call') {
        if (!this.toolCatalog) {
          yield errorEvent(
            providerError(
              'unsupported_capability',
              'Tool catalog is not available.'
            )
          );
          return;
        }

        let inputValidation;
        try {
          inputValidation = this.toolCatalog.validateInput(
            event.call.name,
            event.call.arguments
          );
        } catch {
          inputValidation = { ok: false as const, issues: [] };
        }

        if (!inputValidation.ok) {
          yield errorEvent(
            providerError(
              'malformed_response',
              'Tool call arguments did not match the registered schema.'
            )
          );
          return;
        }
      }

      yield event;
    }
  }
}
