import {
  isValidOpenRouterBaseUrl,
  isValidOpenAIBaseUrl,
  isValidAIGatewayUrl,
  isCustomGatewayAllowed,
  normalizeOpenRouterBaseUrl
} from '../vault/vault-manager';
import { redactSecrets, safeErrorExcerpt } from '../../service/providers/redaction';

const REASONING_MODEL_PATTERN = /^(?:openai\/)?(?:o[1-9](?:[-_].*)?|gpt-5(?:[-_].*)?)$/i;

/**
 * Returns true for OpenAI reasoning models (o1, o3, o4, gpt-5 series) that
 * require `max_completion_tokens` and reject custom `temperature` values.
 */
export function isReasoningModel(model: string): boolean {
  const trimmed = (model || '').trim();
  if (!trimmed) return false;
  return REASONING_MODEL_PATTERN.test(trimmed);
}

export interface ProbeResult {
  success: boolean;
  latencyMs?: number;
  error?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface NativeToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatCompletionParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  tools?: OpenAIToolDefinition[];
  timeoutMs?: number;
}

export interface ChatCompletionResult {
  success: boolean;
  content?: string;
  toolCalls?: NativeToolCall[];
  error?: string;
  usage?: TokenUsage | null;
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd?: number | null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function extractUsage(payload: unknown): TokenUsage | null {
  if (!payload || typeof payload !== 'object') return null;

  const usage = (payload as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return null;

  const record = usage as Record<string, unknown>;
  const inputTokens = toNullableNumber(record.prompt_tokens ?? record.input_tokens);
  const outputTokens = toNullableNumber(record.completion_tokens ?? record.output_tokens);
  const totalTokens =
    toNullableNumber(record.total_tokens) ??
    (inputTokens !== null || outputTokens !== null
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : null);

  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: toNullableNumber(record.cost ?? record.total_cost)
  };
}

export interface AIGatewayClientOptions {
  allowLoopbackTestHost?: boolean;
  fetchImpl?: typeof fetch;
}

function isAllowedTestLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  } catch {
    return false;
  }
}

export class AIGatewayClient {
  private readonly allowLoopbackTestHost: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AIGatewayClientOptions = {}) {
    this.allowLoopbackTestHost = options.allowLoopbackTestHost === true;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private validateOpenRouterTarget(
    provider: string,
    baseUrl: string
  ): { ok: true; cleanBaseUrl: string } | { ok: false; error: string } {
    if (!baseUrl || !baseUrl.trim()) {
      return { ok: false, error: 'Base URL cannot be empty.' };
    }

    const customAllowed = isCustomGatewayAllowed();
    const isSupported =
      provider === 'openrouter' ||
      provider === 'openai' ||
      (customAllowed && provider === 'custom');

    if (!isSupported) {
      return {
        ok: false,
        error: 'Unsupported AI provider.'
      };
    }

    const isAllowed =
      (provider === 'openrouter' && isValidOpenRouterBaseUrl(baseUrl)) ||
      (provider === 'openai' && isValidOpenAIBaseUrl(baseUrl)) ||
      (this.allowLoopbackTestHost && isAllowedTestLoopbackUrl(baseUrl)) ||
      (customAllowed && isValidAIGatewayUrl(baseUrl));

    if (!isAllowed) {
      return {
        ok: false,
        error:
          provider === 'openai'
            ? 'Invalid OpenAI base URL. Must use HTTPS and api.openai.com.'
            : 'Invalid OpenRouter base URL. Must use HTTPS and an official openrouter.ai host.'
      };
    }

    return {
      ok: true,
      cleanBaseUrl: normalizeOpenRouterBaseUrl(baseUrl, provider)
    };
  }

  /**
   * Sends a completion request exclusively to the validated OpenRouter gateway.
   */
  public async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const { baseUrl, apiKey, model, provider, systemPrompt, messages, timeoutMs } = params;
    const knownSecrets = apiKey ? [apiKey.trim()] : [];

    const targetValidation = this.validateOpenRouterTarget(provider, baseUrl);
    if (!targetValidation.ok) {
      return {
        success: false,
        error: redactSecrets(targetValidation.error, knownSecrets)
      };
    }

    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: 'API key is required.' };
    }

    const cleanBaseUrl = targetValidation.cleanBaseUrl;
    const effectiveTimeoutMs = timeoutMs ?? 120000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    try {
      const openRouterUrl = cleanBaseUrl.endsWith('/chat/completions')
        ? cleanBaseUrl
        : `${cleanBaseUrl}/chat/completions`;

      const formattedMessages = [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages
      ];

      // OpenBot Turn-Context Resilience:
      // Many upstream proxies (e.g. CodeBuddy/Tencent/OneAPI) strip or overwrite `{ role: 'system' }`.
      // Injecting the persona block into the active user turn guarantees the model always adopts the persona.
      if (systemPrompt && systemPrompt.trim()) {
        const lastUserIdx = formattedMessages.map((m) => m.role).lastIndexOf('user');
        if (lastUserIdx >= 0) {
          const original = formattedMessages[lastUserIdx];
          if (typeof original.content === 'string') {
            if (!original.content.includes('[Agent Persona') && !original.content.includes('<openbot_persona>')) {
              formattedMessages[lastUserIdx] = {
                ...original,
                content: `[Agent Persona & Instructions:\n${systemPrompt.trim()}\n]\n\n${original.content}`
              };
            }
          } else if (Array.isArray(original.content)) {
            const textPart = (original.content as Array<{ type: string; text?: string }>).find((p) => p.type === 'text');
            if (textPart && typeof textPart.text === 'string') {
              if (!textPart.text.includes('[Agent Persona')) {
                textPart.text = `[Agent Persona & Instructions:\n${systemPrompt.trim()}\n]\n\n${textPart.text}`;
              }
            } else {
              (original.content as any[]).unshift({
                type: 'text',
                text: `[Agent Persona & Instructions:\n${systemPrompt.trim()}\n]`
              });
            }
          }
        }
      }

      const buildRequestBody = (includeTools: boolean) =>
        JSON.stringify({
          model,
          messages: formattedMessages,
          ...(isReasoningModel(model) ? {} : { temperature: 0.7 }),
          ...(includeTools && params.tools && params.tools.length > 0
            ? { tools: params.tools, tool_choice: 'auto' }
            : {}),
          stream: false,
          ...(cleanBaseUrl.includes('openrouter.ai') ? { usage: { include: true } } : {})
        });

      const hasTools = Boolean(params.tools && params.tools.length > 0);
      let response = await this.fetchImpl(openRouterUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey.trim()}`
        },
        body: buildRequestBody(hasTools),
        signal: controller.signal
      });

      // Fallback cleanly if a custom proxy rejects OpenAI `tools` parameter
      if (!response.ok && hasTools && (response.status === 400 || response.status === 422)) {
        response = await this.fetchImpl(openRouterUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`
          },
          body: buildRequestBody(false),
          signal: controller.signal
        });
      }
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        const safeExcerpt = redactSecrets(safeErrorExcerpt(errText, 150), knownSecrets);
        return {
          success: false,
          error: `API error (${response.status}): ${safeExcerpt}`
        };
      }

      const rawText = await response.text();
      let text = '';
      let usage: TokenUsage | null = null;
      const toolCalls: NativeToolCall[] = [];
      const streamedToolCalls = new Map<number, { id?: string; name: string; argsRaw: string }>();

      const parseArgsJson = (rawArgs: unknown): Record<string, unknown> => {
        if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) {
          return rawArgs as Record<string, unknown>;
        }
        if (typeof rawArgs === 'string' && rawArgs.trim()) {
          try {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Ignore malformed tool args
          }
        }
        return {};
      };

      if (rawText.trim().startsWith('data:')) {
        const lines = rawText.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
            try {
              const chunkJson = JSON.parse(trimmed.slice(5).trim());
              const delta =
                chunkJson?.choices?.[0]?.delta?.content ||
                chunkJson?.choices?.[0]?.message?.content ||
                '';
              text += delta;
              const deltaCalls =
                chunkJson?.choices?.[0]?.delta?.tool_calls ||
                chunkJson?.choices?.[0]?.message?.tool_calls;
              if (Array.isArray(deltaCalls)) {
                for (let idx = 0; idx < deltaCalls.length; idx++) {
                  const tc = deltaCalls[idx];
                  const callIdx = typeof tc?.index === 'number' ? tc.index : idx;
                  const entry = streamedToolCalls.get(callIdx) || { name: '', argsRaw: '' };
                  if (typeof tc?.id === 'string') entry.id = tc.id;
                  if (typeof tc?.function?.name === 'string') entry.name += tc.function.name;
                  if (typeof tc?.function?.arguments === 'string') entry.argsRaw += tc.function.arguments;
                  streamedToolCalls.set(callIdx, entry);
                }
              }
              usage = extractUsage(chunkJson) ?? usage;
            } catch {
              // Ignore partial/unparseable chunk
            }
          }
        }
        for (const entry of streamedToolCalls.values()) {
          if (entry.name.trim()) {
            toolCalls.push({
              ...(entry.id ? { id: entry.id } : {}),
              name: entry.name.trim(),
              arguments: parseArgsJson(entry.argsRaw)
            });
          }
        }
      } else {
        try {
          const data = JSON.parse(rawText);
          text =
            data?.choices?.[0]?.message?.content ||
            data?.choices?.[0]?.delta?.content ||
            data?.content?.[0]?.text ||
            '';
          const msgToolCalls = data?.choices?.[0]?.message?.tool_calls;
          if (Array.isArray(msgToolCalls)) {
            for (const tc of msgToolCalls) {
              const fnName = tc?.function?.name || tc?.name;
              if (typeof fnName === 'string' && fnName.trim()) {
                toolCalls.push({
                  ...(typeof tc?.id === 'string' ? { id: tc.id } : {}),
                  name: fnName.trim(),
                  arguments: parseArgsJson(tc?.function?.arguments ?? tc?.arguments)
                });
              }
            }
          }
          usage = extractUsage(data);
        } catch {
          const safeRaw = redactSecrets(safeErrorExcerpt(rawText, 150), knownSecrets);
          return {
            success: false,
            error: `Invalid response format: ${safeRaw}`
          };
        }
      }

      if (!text && toolCalls.length === 0) {
        return { success: false, error: 'No text choice returned by AI Gateway.' };
      }
      return {
        success: true,
        content: text ? redactSecrets(text, knownSecrets) : '',
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        return {
          success: false,
          error: `AI request timed out after ${
            effectiveTimeoutMs < 1000
              ? `${effectiveTimeoutMs}ms`
              : `${Math.round(effectiveTimeoutMs / 1000)}s`
          }.`
        };
      }
      const rawErr = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: redactSecrets(rawErr, knownSecrets)
      };
    }
  }

  /**
   * Tests reachability and authentication for the configured OpenRouter endpoint.
   */
  public async probeConnection(
    baseUrl: string,
    apiKey: string,
    model: string,
    provider: string
  ): Promise<ProbeResult> {
    const knownSecrets = apiKey ? [apiKey.trim()] : [];

    const targetValidation = this.validateOpenRouterTarget(provider, baseUrl);
    if (!targetValidation.ok) {
      return {
        success: false,
        error: redactSecrets(targetValidation.error, knownSecrets)
      };
    }

    if (!apiKey || !apiKey.trim()) {
      return { success: false, error: 'API key is required to test connection.' };
    }

    const start = Date.now();
    const cleanBaseUrl = targetValidation.cleanBaseUrl;

    try {
      const probeUrl = `${cleanBaseUrl}/models`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenEmployee/1.0.0',
        Authorization: `Bearer ${apiKey.trim()}`
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const response = await this.fetchImpl(probeUrl, {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - start;

      if (response.ok) {
        return { success: true, latencyMs };
      }

      if (response.status === 404 || response.status === 405) {
        const pingResponse = await this.fetchImpl(`${cleanBaseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model || 'default',
            messages: [{ role: 'user', content: 'hi' }],
            ...(isReasoningModel(model) ? { max_completion_tokens: 1 } : { max_tokens: 1 })
          })
        });

        if (pingResponse.ok || pingResponse.status === 400) {
          return { success: true, latencyMs: Date.now() - start };
        }

        const errText = await pingResponse.text().catch(() => '');
        const safePingErr = redactSecrets(
          errText ? safeErrorExcerpt(errText, 120) : pingResponse.statusText,
          knownSecrets
        );
        return {
          success: false,
          error: `HTTP ${pingResponse.status}: ${safePingErr}`
        };
      }

      const errText = await response.text().catch(() => '');
      const safeErr = redactSecrets(
        errText ? safeErrorExcerpt(errText, 120) : response.statusText,
        knownSecrets
      );
      return {
        success: false,
        error: `HTTP ${response.status}: ${safeErr}`
      };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, latencyMs, error: 'Connection timed out after 8s.' };
      }
      const rawErr = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        latencyMs,
        error: redactSecrets(rawErr, knownSecrets)
      };
    }
  }
}
