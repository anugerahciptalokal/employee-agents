import type { ProviderError } from '@open-employee/contracts/contracts/provider';

export interface RetryPolicyOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

const RETRYABLE_CODES = new Set<ProviderError['code']>([
  'rate_limit',
  'timeout',
  'network',
  'provider_unavailable'
]);

export function isRetryableProviderError(error: ProviderError): boolean {
  return error.retryable && RETRYABLE_CODES.has(error.code);
}

function deterministicJitterFactor(attempt: number, code: string): number {
  const seed = (attempt * 17 + code.length * 13) % 20;
  return 0.9 + seed / 100;
}

export function computeRetryDelayMs(
  attempt: number,
  error: ProviderError,
  options: RetryPolicyOptions = {}
): number {
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = Math.min(options.maxDelayMs ?? 2_000, 2_000);

  if (error.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, error.retryAfterMs), maxDelayMs);
  }

  const exponential = baseDelayMs * 2 ** Math.max(0, attempt);
  const delay = Math.round(exponential * deterministicJitterFactor(attempt, error.code));
  return Math.min(delay, maxDelayMs);
}

export function shouldRetry(input: {
  attempt: number;
  maxRetries?: number;
  error: ProviderError;
  streamStarted: boolean;
  options?: RetryPolicyOptions;
}): RetryDecision {
  const configuredMaxRetries =
    input.maxRetries ?? input.options?.maxRetries ?? 2;
  const maxRetries = Math.max(0, Math.min(configuredMaxRetries, 2));

  if (input.streamStarted || input.attempt >= maxRetries) {
    return { retry: false, delayMs: 0 };
  }

  if (!isRetryableProviderError(input.error)) {
    return { retry: false, delayMs: 0 };
  }

  return {
    retry: true,
    delayMs: computeRetryDelayMs(input.attempt, input.error, input.options)
  };
}
