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
  jsonMode: true,
  sessions: false
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapUsage(raw: unknown): UsageMetadata | null {
  const usage = asRecord(raw);
  if (!usage) return null;

  const inputTokens = numberOrNull(usage.prompt_tokens);
  const outputTokens = numberOrNull(usage.completion_tokens);
  const explicitTotal = numberOrNull(usage.total_tokens);
  const totalTokens =
    explicitTotal ??
    (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens
      : null);

  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  const cached = numberOrNull(promptDetails?.cached_tokens);
  const reasoning = numberOrNull(completionDetails?.reasoning_tokens);

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cached !== null ? { cachedInputTokens: cached } : {}),
    ...(reasoning !== null ? { reasoningTokens: reasoning } : {})
  };
}

function mapFinishReason(value: unknown): FinishReason | null {
  if (value === 'stop') return 'stop';
  if (value === 'length') return 'length';
  if (value === 'tool_calls') return 'tool_calls';
  if (value === 'content_filter') return 'content_filter';
  return null;
}

function mapStreamError(raw: unknown): ProviderError {
  const root = asRecord(raw);
  const error = asRecord(root?.error) ?? root ?? {};
  const message =
    typeof error.message === 'string'
      ? error.message
      : 'Provider stream error.';
  const type =
    typeof error.type === 'string'
      ? error.type
      : typeof error.code === 'string'
        ? error.code
        : '';

  if (/authentication/i.test(type)) {
    return providerError('authentication', message, { providerCode: type });
  }
  if (/permission/i.test(type)) {
    return providerError('permission', message, { providerCode: type });
  }
  if (/rate|quota/i.test(type)) {
    return providerError('rate_limit', message, {
      retryable: true,
      providerCode: type
    });
  }
  if (/context.*length|context_length/i.test(type)) {
    return providerError('context_length', message, { providerCode: type });
  }
  if (/content.*filter|safety/i.test(type)) {
    return providerError('content_filter', message, { providerCode: type });
  }
  if (/server|overload|unavailable/i.test(type)) {
    return providerError('provider_unavailable', message, {
      retryable: true,
      providerCode: type
    });
  }
  if (/invalid.*request/i.test(type)) {
    return providerError('invalid_request', message, { providerCode: type });
  }

  return providerError('unknown', message, { providerCode: type || undefined });
}

function buildMessages(request: TurnRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (request.systemPrompt) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }

  for (const message of request.messages) {
    if (message.role === 'user') {
      messages.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role === 'assistant') {
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: message.content
      };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }
        }));
      }
      messages.push(entry);
      continue;
    }

    messages.push({
      role: 'tool',
      tool_call_id: message.toolCallId,
      content: message.content
    });
  }

  return messages;
}

function buildToolChoice(value: TurnRequest['toolChoice']): unknown {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'none' || value === 'required') {
    return value;
  }
  return { type: 'function', function: { name: value.name } };
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  public readonly id: string;
  public readonly kind = 'openai-compatible' as const;
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
    let sawDone = false;
    let sawStreamEvent = false;
    let sawFinishReason = false;
    let finishReason: FinishReason = 'stop';
    let usage: UsageMetadata | undefined;

    const body: Record<string, unknown> = {
      model: request.model,
      messages: buildMessages(request),
      stream: true
    };

    const isReasoning = /^(?:openai\/)?(?:o[1-9](?:[-_].*)?|gpt-5(?:[-_].*)?)$/i.test(
      (request.model || '').trim()
    );
    if (!isReasoning && request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxOutputTokens !== undefined) {
      if (isReasoning) {
        body.max_completion_tokens = request.maxOutputTokens;
      } else {
        body.max_tokens = request.maxOutputTokens;
      }
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }));
    }

    const toolChoice = buildToolChoice(request.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    try {
      try {
        for await (const event of openProviderSse({
          url: joinProviderUrl(this.#config.baseUrl, '/chat/completions'),
          headers: {
            authorization: `Bearer ${credential}`,
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

          const data = event.data.trim();
          if (data === '[DONE]') {
            sawDone = true;
            break;
          }
          if (!data) continue;

          const chunk = parseJsonRecord(data);
          if (!chunk) {
            yield errorEvent(
              malformedResponseError('OpenAI-compatible stream contained malformed JSON.')
            );
            return;
          }

          if (chunk.error !== undefined) {
            yield errorEvent(
              redactProviderError(mapStreamError(chunk), [credential])
            );
            return;
          }

          if (chunk.usage !== undefined) {
            usage = mapUsage(chunk.usage) ?? usage;
          }

          const choices = chunk.choices;
          if (choices !== undefined) {
            if (!Array.isArray(choices)) {
              yield errorEvent(
                malformedResponseError('OpenAI-compatible stream choices were invalid.')
              );
              return;
            }

            for (const rawChoice of choices) {
              const choice = asRecord(rawChoice);
              if (!choice) {
                yield errorEvent(
                  malformedResponseError('OpenAI-compatible stream choice was invalid.')
                );
                return;
              }

              const delta = asRecord(choice.delta);
              if (delta) {
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                  yield { type: 'text_delta', text: delta.content };
                }

                const rawToolCalls = delta.tool_calls;
                if (rawToolCalls !== undefined) {
                  if (!Array.isArray(rawToolCalls)) {
                    yield errorEvent(
                      malformedResponseError('OpenAI-compatible tool call delta was invalid.')
                    );
                    return;
                  }

                  for (const rawToolCall of rawToolCalls) {
                    const toolCall = asRecord(rawToolCall);
                    const index = toolCall?.index;
                    if (
                      !toolCall ||
                      typeof index !== 'number' ||
                      !Number.isInteger(index) ||
                      index < 0
                    ) {
                      yield errorEvent(
                        malformedResponseError('OpenAI-compatible tool call index was invalid.')
                      );
                      return;
                    }

                    const fn = asRecord(toolCall.function);
                    const id = typeof toolCall.id === 'string' ? toolCall.id : undefined;
                    const name = typeof fn?.name === 'string' ? fn.name : undefined;
                    const argumentsDelta =
                      typeof fn?.arguments === 'string' ? fn.arguments : undefined;

                    tools.add(index, id, name, argumentsDelta);
                    yield {
                      type: 'tool_call_delta',
                      index,
                      ...(id !== undefined ? { id } : {}),
                      ...(name !== undefined ? { name } : {}),
                      ...(argumentsDelta !== undefined ? { argumentsDelta } : {})
                    };
                  }
                }
              }

              const mapped = mapFinishReason(choice.finish_reason);
              if (mapped) {
                finishReason = mapped;
                sawFinishReason = true;
              }
            }
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
              'OpenAI-compatible stream ended before [DONE].'
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

      if (!sawDone) {
        yield errorEvent(
          malformedResponseError('OpenAI-compatible stream ended without [DONE].')
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

      if (usage) yield usageEvent(usage);

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
