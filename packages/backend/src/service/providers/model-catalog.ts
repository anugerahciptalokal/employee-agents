import type {
  ModelInfo,
  ProviderConfig,
  ProviderError
} from '@open-employee/contracts/contracts/provider';
import {
  joinProviderUrl,
  parseJsonRecord,
  providerError,
  redactProviderError,
  resolveCredential,
  type CredentialResolver
} from './adapter-shared';
import {
  HttpTransportError,
  openHttpStream
} from './http-transport';

export interface OpenRouterModel extends ModelInfo {
  capabilitiesKnown: boolean;
}

export interface OpenRouterModelCatalogResult {
  models: OpenRouterModel[];
  configuredModel: OpenRouterModel;
  source: 'discovery' | 'configured';
  error?: ProviderError;
}

export interface OpenRouterModelCatalogOptions {
  config: ProviderConfig;
  resolveCredential: CredentialResolver;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function pricePerMillion(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed * 1_000_000;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function mapModel(
  raw: unknown,
  providerId: string
): OpenRouterModel | null {
  const model = asRecord(raw);
  if (!model || typeof model.id !== 'string' || !model.id.trim()) {
    return null;
  }

  const id = model.id;
  const supportedParameters = stringList(model.supported_parameters);
  const architecture = asRecord(model.architecture);
  const inputModalities = stringList(architecture?.input_modalities) ?? [];
  const outputModalities = stringList(architecture?.output_modalities);
  const capabilitiesKnown = supportedParameters !== null;
  const hasParameter = (name: string): boolean =>
    supportedParameters?.includes(name) === true;

  const topProvider = asRecord(model.top_provider);
  const pricing = asRecord(model.pricing);
  const inputCost = pricePerMillion(pricing?.prompt);
  const outputCost = pricePerMillion(pricing?.completion);

  return {
    providerId,
    modelId: id,
    displayName:
      typeof model.name === 'string' && model.name.trim()
        ? model.name
        : id,
    capabilities: {
      text: outputModalities ? outputModalities.includes('text') : true,
      tools: hasParameter('tools'),
      streaming: true,
      images:
        inputModalities.includes('image') ||
        hasParameter('input_image'),
      jsonMode:
        hasParameter('response_format') ||
        hasParameter('structured_outputs') ||
        hasParameter('json_mode'),
      sessions: false
    },
    capabilitiesKnown,
    ...(positiveInteger(model.context_length) !== undefined
      ? { contextWindow: positiveInteger(model.context_length) }
      : {}),
    ...(positiveInteger(topProvider?.max_completion_tokens) !== undefined
      ? {
          maxOutputTokens: positiveInteger(
            topProvider?.max_completion_tokens
          )
        }
      : positiveInteger(model.max_completion_tokens) !== undefined
        ? { maxOutputTokens: positiveInteger(model.max_completion_tokens) }
        : {}),
    ...(inputCost !== undefined
      ? { inputCostPerMillionUsd: inputCost }
      : {}),
    ...(outputCost !== undefined
      ? { outputCostPerMillionUsd: outputCost }
      : {})
  };
}

async function readBodyText(
  body: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export class OpenRouterModelCatalog {
  readonly #config: ProviderConfig;
  readonly #resolveCredential: CredentialResolver;
  readonly #fetchImpl?: typeof fetch;
  readonly #maxResponseBytes: number;

  constructor(options: OpenRouterModelCatalogOptions) {
    this.#config = options.config;
    this.#resolveCredential = options.resolveCredential;
    this.#fetchImpl = options.fetchImpl;
    this.#maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  }

  public getConfiguredModel(): OpenRouterModel {
    return {
      providerId: this.#config.id,
      modelId: this.#config.model,
      displayName: this.#config.model,
      capabilities: {
        text: true,
        tools: false,
        streaming: true,
        images: false,
        jsonMode: false,
        sessions: false
      },
      capabilitiesKnown: false
    };
  }

  public async discover(
    signal?: AbortSignal
  ): Promise<OpenRouterModelCatalogResult> {
    const configuredModel = this.getConfiguredModel();
    const credential = await resolveCredential(
      this.#resolveCredential,
      this.#config.credentialRef
    );

    if (!credential) {
      return {
        models: [configuredModel],
        configuredModel,
        source: 'configured',
        error: providerError(
          'authentication',
          'Provider credential is unavailable.',
          { retryable: false }
        )
      };
    }

    try {
      const response = await openHttpStream(
        {
          url: joinProviderUrl(this.#config.baseUrl, '/models'),
          method: 'GET',
          headers: {
            authorization: `Bearer ${credential}`,
            accept: 'application/json'
          },
          signal
        },
        {
          totalTimeoutMs: this.#config.timeoutMs,
          streamIdleTimeoutMs: this.#config.streamIdleTimeoutMs,
          maxResponseBytes: this.#maxResponseBytes,
          fetchImpl: this.#fetchImpl
        }
      );

      let text: string;
      try {
        if (!response.body) {
          throw new HttpTransportError(
            providerError(
              'malformed_response',
              'OpenRouter model discovery returned an empty body.',
              { retryable: false }
            )
          );
        }
        text = await readBodyText(response.body);
      } finally {
        response.close();
      }

      const parsed = parseJsonRecord(text);
      if (!parsed || !Array.isArray(parsed.data)) {
        return {
          models: [configuredModel],
          configuredModel,
          source: 'configured',
          error: providerError(
            'malformed_response',
            'OpenRouter model discovery returned malformed data.',
            { retryable: false }
          )
        };
      }

      const models = parsed.data
        .map((entry) => mapModel(entry, this.#config.id))
        .filter((entry): entry is OpenRouterModel => entry !== null);

      if (parsed.data.length > 0 && models.length === 0) {
        return {
          models: [configuredModel],
          configuredModel,
          source: 'configured',
          error: providerError(
            'malformed_response',
            'OpenRouter model discovery returned no valid models.',
            { retryable: false }
          )
        };
      }

      return {
        models,
        configuredModel,
        source: 'discovery'
      };
    } catch (error) {
      const providerFailure =
        error instanceof HttpTransportError
          ? redactProviderError(error.providerError, [credential])
          : providerError(
              'unknown',
              'OpenRouter model discovery failed.',
              { retryable: false }
            );

      return {
        models: [configuredModel],
        configuredModel,
        source: 'configured',
        error: providerFailure
      };
    }
  }
}
