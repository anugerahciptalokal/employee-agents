import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  TurnRequest
} from '@open-employee/contracts/contracts/provider';
import type { ProviderAdapter } from './provider-runtime';
import { ProviderConfigStore } from './provider-config';
import { ProviderRegistry } from './provider-registry';

export interface ProviderRouterOptions {
  isStreamingRequested?: (request: TurnRequest) => boolean;
}

export type RouteDecision =
  | {
      ok: true;
      config: ProviderConfig;
      adapter: ProviderAdapter;
      capabilities: ProviderCapabilities;
    }
  | {
      ok: false;
      error: ProviderError;
    };

function defaultStreamingRequested(request: TurnRequest): boolean {
  return (
    request.metadata?.stream === 'true' ||
    request.metadata?.streaming === 'true'
  );
}

function routeError(
  code: ProviderError['code'],
  message: string
): RouteDecision {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: false
    }
  };
}

export class ProviderRouter {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly configs: ProviderConfigStore,
    private readonly options: ProviderRouterOptions = {}
  ) {}

  public resolve(request: TurnRequest): RouteDecision {
    const config = this.configs.get(request.providerId);
    if (!config) {
      return routeError(
        'invalid_request',
        'Provider configuration is not available.'
      );
    }

    const adapter = this.registry.get(request.providerId);
    if (!adapter) {
      return routeError(
        'invalid_request',
        'Provider adapter is not registered.'
      );
    }

    if (config.kind !== adapter.kind) {
      return routeError(
        'invalid_request',
        'Provider configuration kind does not match the adapter kind.'
      );
    }

    if (!adapter.capabilities.text) {
      return routeError(
        'unsupported_capability',
        'Provider does not support text turns.'
      );
    }

    const hasTools = Array.isArray(request.tools) && request.tools.length > 0;
    const toolChoice = request.toolChoice;

    if (
      toolChoice !== undefined &&
      toolChoice !== 'none' &&
      !hasTools
    ) {
      return routeError(
        'invalid_request',
        'toolChoice requires at least one tool.'
      );
    }

    if (hasTools && toolChoice !== 'none' && !adapter.capabilities.tools) {
      return routeError(
        'unsupported_capability',
        'Provider does not support tool calls.'
      );
    }

    if (
      request.responseFormat === 'json' &&
      !adapter.capabilities.jsonMode
    ) {
      return routeError(
        'unsupported_capability',
        'Provider does not support JSON response format.'
      );
    }

    const streamingRequested = this.options.isStreamingRequested
      ? this.options.isStreamingRequested(request)
      : defaultStreamingRequested(request);

    if (streamingRequested && !adapter.capabilities.streaming) {
      return routeError(
        'unsupported_capability',
        'Provider does not support streaming for this request.'
      );
    }

    return {
      ok: true,
      config,
      adapter,
      capabilities: adapter.capabilities
    };
  }
}
