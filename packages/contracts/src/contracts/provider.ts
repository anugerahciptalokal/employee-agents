import type { ToolCall, ToolDescriptor } from './tool';

export const PROVIDER_KINDS = [
  'openai-compatible',
  'anthropic',
  'gemini',
  'fake'
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderCapabilities {
  text: boolean;
  tools: boolean;
  streaming: boolean;
  images: boolean;
  jsonMode: boolean;
  sessions: boolean;
}

export interface ModelInfo {
  providerId: string;
  modelId: string;
  displayName?: string;
  capabilities: ProviderCapabilities;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputCostPerMillionUsd?: number;
  outputCostPerMillionUsd?: number;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  credentialRef: string;
  timeoutMs: number;
  maxRetries: number;
  streamIdleTimeoutMs: number;
}

export type ProviderMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

export interface TurnRequest {
  turnId: string;
  providerId: string;
  model: string;
  systemPrompt?: string;
  messages: ProviderMessage[];
  tools?: ToolDescriptor[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: 'text' | 'json';
  metadata?: Record<string, string>;
  timeoutMs?: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'cancelled'
  | 'error';

export interface UsageMetadata {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
}

export const PROVIDER_ERROR_CODES = [
  'authentication',
  'permission',
  'invalid_request',
  'rate_limit',
  'timeout',
  'cancelled',
  'network',
  'provider_unavailable',
  'context_length',
  'content_filter',
  'malformed_response',
  'unsupported_capability',
  'unknown'
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  providerStatus?: number;
  providerCode?: string;
  retryAfterMs?: number;
  requestId?: string;
}

export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: UsageMetadata }
  | { type: 'finish'; reason: FinishReason; usage?: UsageMetadata }
  | { type: 'error'; error: ProviderError };

export interface TurnResult {
  turnId: string;
  providerId: string;
  model: string;
  text: string;
  toolCalls: ToolCall[];
  usage: UsageMetadata | null;
  finishReason: FinishReason;
  latencyMs: number;
  providerRequestId?: string;
}
