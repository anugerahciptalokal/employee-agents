import type { ProviderConfig } from '@open-employee/contracts/contracts/provider';
import type { CredentialResolver } from './adapter-shared';
import { OpenAICompatibleAdapter } from './openai-compatible';
import {
  validateProviderConfig,
  type ProviderConfigValidation
} from './provider-config';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_ID = 'openrouter';
export const OPENROUTER_DEFAULT_CREDENTIAL_REF = 'openrouter';

export interface OpenRouterProfileOptions {
  id?: string;
  model: string;
  credentialRef?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  streamIdleTimeoutMs?: number;
}

export function createOpenRouterConfig(
  options: OpenRouterProfileOptions
): ProviderConfigValidation {
  return validateProviderConfig({
    id: options.id ?? OPENROUTER_DEFAULT_ID,
    kind: 'openai-compatible',
    baseUrl: options.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
    model: options.model,
    credentialRef:
      options.credentialRef ?? OPENROUTER_DEFAULT_CREDENTIAL_REF,
    timeoutMs: options.timeoutMs ?? 120_000,
    maxRetries: options.maxRetries ?? 2,
    streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 30_000
  });
}

export function createOpenRouterAdapter(options: {
  config: ProviderConfig;
  resolveCredential: CredentialResolver;
  fetchImpl?: typeof fetch;
}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    config: options.config,
    resolveCredential: options.resolveCredential,
    fetchImpl: options.fetchImpl
  });
}
