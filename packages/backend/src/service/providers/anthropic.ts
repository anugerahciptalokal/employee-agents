import type {
  FinishReason,
  ModelInfo,
  ProviderCapabilities,
  ProviderError,
  ProviderEvent,
  TurnRequest,
  UsageMetadata
} from '@open-employee/contracts/contracts/provider';
import {
  ActiveTurnTracker,
  ToolCallAccumulator,
  authenticationError,
  cancelledFinish,
  errorEvent,
  finishEvent,
  joinProviderUrl,
  malformedResponseError,
  openProviderSse,
  parseJsonRecord,
  providerError,
  redactProviderError,
  resolveCredential,
  usageEvent,
  type AdapterOptions
} from './adapter-shared';
import { HttpTransportError } from './http-transport';
import type {
  ProviderAdapter,
  ProviderTurnRuntime
} from './provider-runtime';

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true,
  tools: true,
  streaming: true,
  images: false,
  jsonMode: false,
  sessions: false
};

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4_096;

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapToolChoice(value: TurnRequest['toolChoice']): unknown {
  if (value === undefined) return undefined;
  if (value === 'auto') return { type: 'auto' };
  if (value === 'none') return { type: 'none' };
  if (value === 'required') return { type: 'any' };
  return { type: 'tool', name: value.name };
}

function buildMessages(request: TurnRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const content: Array<Record<string, unknown>> = [];
      if (message.content.length > 0) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }

    messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          ...(message.isError ? { is_error: true } : {})
        }
      ]
    });
  }

  return messages;
}

function mapUsage(
  inputTokens: number | null,
  outputTokens: number | null,
  cachedInputTokens: number | null
): UsageMetadata {
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens
        : null,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {})
  };
}

function mapFinishReason(value: unknown): FinishReason | null {
  if (value === 'end_turn' || value === 'stop_sequence' || value === 'pause_turn') {
    return 'stop';
  }
  if (value === 'max_tokens') return 'length';
  if (value === 'tool_use') return 'tool_calls';
  if (value === 'refusal') return 'content_filter';
  return null;
}

function mapStreamError(raw: unknown): ProviderError {
  const root = asRecord(raw);
  const error = asRecord(root?.error) ?? root ?? {};
  const message =
    typeof error.message === 'string'
      ? error.message
      : 'Provider stream error.';
  const type = typeof error.type === 'string' ? error.type : '';

  if (type === 'authentication_error') {
    return providerError('authentication', message, { providerCode: type });
  }
  if (type === 'permission_error') {
    return providerError('permission', message, { providerCode: type });
  }
  if (type === 'rate_limit_error') {
    return providerError('rate_limit', message, {
      retryable: true,
      providerCode: type
    });
  }
  if (type === 'overloaded_error' || type === 'api_error') {
    return providerError('provider_unavailable', message, {
      retryable: true,
      providerCode: type
    });
  }
  if (type === 'invalid_request_error' || type === 'not_found_error') {
    return providerError('invalid_request', message, { providerCode: type });
  }
  if (type === 'context_length_error') {
    return providerError('context_length', message, { providerCode: type });
  }
  if (type === 'content_filter_error') {
    return providerError('content_filter', message, { providerCode: type });
  }

  return providerError('unknown', message, {
    providerCode: type || undefined
  });
}

export class AnthropicAdapter implements ProviderAdapter {
  public readonly id: string;
  public readonly kind = 'anthropic' as const;
  public readonly capabilities: ProviderCapabilities;
  readonly #config: AdapterOptions['config'];
  readonly #resolveCredential: AdapterOptions['resolveCredential'];
  readonly #fetchImpl?: typeof fetch;
  readonly #activeTurns = new ActiveTurnTracker();

  constructor(options: AdapterOptions) {
    this.id = options.config.id;
    this.#config = options.config;
    this.#resolveCredential = options.resolveCredential;
    this.#fetchImpl = options.fetchImpl;
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...options.capabilities
    };
  }

  public async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  public async cancel(turnId: string): Promise<void> {
    await this.#activeTurns.cancel(turnId);
  }

  public async *startTurn(
    request: TurnRequest,
    runtime: ProviderTurnRuntime
  ): AsyncIterable<ProviderEvent> {
    if (request.responseFormat === 'json' && !this.capabilities.jsonMode) {
      yield errorEvent(
        providerError(
          'unsupported_capability',
          'Anthropic adapter does not support JSON response format.'
        )
      );
      return;
    }

    const credential = await resolveCredential(
      this.#resolveCredential,
      this.#config.credentialRef
    );
    if (!credential) {
      yield errorEvent(authenticationError());
      return;
    }

    const active = this.#activeTurns.begin(request.turnId, runtime.signal);
    const tools = new ToolCallAccumulator();
    const toolBlocks = new Map<number, { stopped: boolean }>();
    let sawMessageStop = false;
    let sawStreamEvent = false;
    let finishReason: FinishReason = 'stop';
    let sawFinishReason = false;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cachedInputTokens: number | null = null;
    let usageSeen = false;

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages: buildMessages(request),
      stream: true
    };

    if (request.systemPrompt) body.system = request.systemPrompt;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }));
    }

    const toolChoice = mapToolChoice(request.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;

    try {
      try {
        for await (const event of openProviderSse({
          url: joinProviderUrl(this.#config.baseUrl, '/messages'),
          headers: {
            'x-api-key': credential,
            'anthropic-version': ANTHROPIC_VERSION,
            'content-type': 'application/json',
            accept: 'text/event-stream'
          },
          body: JSON.stringify(body),
          config: this.#config,
          signal: active.signal,
          timeoutMs: request.timeoutMs,
          fetchImpl: this.#fetchImpl
        })) {
          if (active.signal.aborted) break;
          sawStreamEvent = true;

          const payload = parseJsonRecord(event.data.trim());
          if (!payload) {
            yield errorEvent(
              malformedResponseError('Anthropic stream contained malformed JSON.')
            );
            return;
          }

          const eventName =
            event.event ??
            (typeof payload.type === 'string' ? payload.type : null);

          if (eventName === 'error') {
            yield errorEvent(
              redactProviderError(mapStreamError(payload), [credential])
            );
            return;
          }

          if (eventName === 'message_start') {
            const message = asRecord(payload.message);
            const usage = asRecord(message?.usage);
            if (usage) {
              usageSeen = true;
              inputTokens = numberOrNull(usage.input_tokens) ?? inputTokens;
              outputTokens = numberOrNull(usage.output_tokens) ?? outputTokens;
              cachedInputTokens =
                numberOrNull(usage.cache_read_input_tokens) ?? cachedInputTokens;
            }
            continue;
          }

          if (eventName === 'content_block_start') {
            const index = payload.index;
            const block = asRecord(payload.content_block);
            if (
              typeof index !== 'number' ||
              !Number.isInteger(index) ||
              index < 0 ||
              !block
            ) {
              yield errorEvent(
                malformedResponseError('Anthropic content block was invalid.')
              );
              return;
            }

            if (block.type === 'tool_use') {
              const id = typeof block.id === 'string' ? block.id : undefined;
              const name = typeof block.name === 'string' ? block.name : undefined;
              tools.add(index, id, name, '');
              toolBlocks.set(index, { stopped: false });
              yield {
                type: 'tool_call_delta',
                index,
                ...(id !== undefined ? { id } : {}),
                ...(name !== undefined ? { name } : {})
              };
            }
            continue;
          }

          if (eventName === 'content_block_delta') {
            const index = payload.index;
            const delta = asRecord(payload.delta);
            if (
              typeof index !== 'number' ||
              !Number.isInteger(index) ||
              index < 0 ||
              !delta
            ) {
              yield errorEvent(
                malformedResponseError('Anthropic content delta was invalid.')
              );
              return;
            }

            if (delta.type === 'text_delta' && typeof delta.text === 'string') {
              if (delta.text.length > 0) {
                yield { type: 'text_delta', text: delta.text };
              }
            } else if (
              delta.type === 'input_json_delta' &&
              typeof delta.partial_json === 'string'
            ) {
              if (!toolBlocks.has(index)) {
                yield errorEvent(
                  malformedResponseError('Anthropic tool delta had no tool block.')
                );
                return;
              }
              tools.add(index, undefined, undefined, delta.partial_json);
              yield {
                type: 'tool_call_delta',
                index,
                argumentsDelta: delta.partial_json
              };
            }
            continue;
          }

          if (eventName === 'content_block_stop') {
            const index = payload.index;
            if (typeof index === 'number' && toolBlocks.has(index)) {
              toolBlocks.set(index, { stopped: true });
            }
            continue;
          }

          if (eventName === 'message_delta') {
            const delta = asRecord(payload.delta);
            const mapped = mapFinishReason(delta?.stop_reason);
            if (mapped) {
              finishReason = mapped;
              sawFinishReason = true;
            }

            const usage = asRecord(payload.usage);
            if (usage) {
              usageSeen = true;
              inputTokens = numberOrNull(usage.input_tokens) ?? inputTokens;
              outputTokens = numberOrNull(usage.output_tokens) ?? outputTokens;
              cachedInputTokens =
                numberOrNull(usage.cache_read_input_tokens) ?? cachedInputTokens;
            }
            continue;
          }

          if (eventName === 'message_stop') {
            sawMessageStop = true;
            break;
          }
        }
      } catch (error) {
        if (active.signal.aborted) {
          yield cancelledFinish();
          return;
        }
        if (sawStreamEvent) {
          yield errorEvent(
            malformedResponseError(
              'Anthropic stream ended before message_stop.'
            )
          );
          return;
        }
        if (error instanceof HttpTransportError) {
          yield errorEvent(
            redactProviderError(error.providerError, [credential])
          );
          return;
        }
        yield errorEvent(providerError('unknown', 'Provider stream failed.'));
        return;
      }

      if (active.signal.aborted) {
        yield cancelledFinish();
        return;
      }

      if (!sawMessageStop) {
        yield errorEvent(
          malformedResponseError('Anthropic stream ended without message_stop.')
        );
        return;
      }

      if ([...toolBlocks.values()].some((block) => !block.stopped)) {
        yield errorEvent(
          malformedResponseError('Anthropic tool block ended before completion.')
        );
        return;
      }

      const completion = tools.complete();
      if (!completion.ok) {
        yield errorEvent(malformedResponseError(completion.message));
        return;
      }

      for (const call of completion.calls) {
        yield { type: 'tool_call', call };
      }

      if (usageSeen) {
        yield usageEvent(
          mapUsage(inputTokens, outputTokens, cachedInputTokens)
        );
      }

      if (completion.calls.length > 0 && finishReason === 'stop') {
        finishReason = 'tool_calls';
      }

      if (!sawFinishReason && completion.calls.length === 0) {
        finishReason = 'stop';
      }

      if (active.signal.aborted) {
        yield cancelledFinish();
        return;
      }

      yield finishEvent(finishReason);
    } finally {
      active.finish();
    }
  }
}
