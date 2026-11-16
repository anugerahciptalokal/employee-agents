import type { ProviderError } from '@open-employee/contracts/contracts/provider';
import { safeErrorExcerpt } from './redaction';

export interface NormalizeHttpErrorInput {
  status: number;
  headers: Record<string, string>;
  body?: string;
  requestId?: string;
  now?: number;
}

export type TransportFailureReason =
  | 'caller'
  | 'timeout'
  | 'idle'
  | 'connect'
  | 'size'
  | 'network'
  | 'unknown';

export interface NormalizeNetworkErrorInput {
  error: unknown;
  reason: TransportFailureReason;
}

function headerValue(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return entry?.[1];
}

export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now()
): number | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - now);
}

export function normalizeHttpProviderError(
  input: NormalizeHttpErrorInput
): ProviderError {
  const { status } = input;
  const retryAfterMs = parseRetryAfter(
    headerValue(input.headers, 'retry-after'),
    input.now
  );
  const requestId =
    input.requestId ??
    headerValue(input.headers, 'x-request-id') ??
    headerValue(input.headers, 'request-id');
  const excerpt = safeErrorExcerpt(input.body ?? '', 240);

  let code: ProviderError['code'];
  let message: string;
  let retryable = false;

  if (status === 401) {
    code = 'authentication';
    message = 'Provider authentication failed.';
  } else if (status === 403) {
    code = 'permission';
    message = 'Provider permission was denied.';
  } else if (status === 400) {
    code = 'invalid_request';
    message = 'Provider rejected the request.';
  } else if (status === 404) {
    code = 'invalid_request';
    message = 'Provider model or endpoint was not found.';
  } else if (status === 408) {
    code = 'timeout';
    message = 'Provider request timed out.';
    retryable = true;
  } else if (status === 429) {
    code = 'rate_limit';
    message = 'Provider rate limit was reached.';
    retryable = true;
  } else if (status >= 500) {
    code = 'provider_unavailable';
    message = 'Provider is temporarily unavailable.';
    retryable = true;
  } else {
    code = 'unknown';
    message = `Provider request failed with status ${status}.`;
  }

  return {
    code,
    message: excerpt ? `${message} ${excerpt}` : message,
    retryable,
    providerStatus: status,
    retryAfterMs,
    requestId
  };
}

export function normalizeNetworkProviderError(
  input: NormalizeNetworkErrorInput
): ProviderError {
  if (input.reason === 'caller') {
    return {
      code: 'cancelled',
      message: 'Provider request was cancelled.',
      retryable: false
    };
  }

  if (
    input.reason === 'timeout' ||
    input.reason === 'idle' ||
    input.reason === 'connect'
  ) {
    return {
      code: 'timeout',
      message: 'Provider request timed out.',
      retryable: true
    };
  }

  if (input.reason === 'size') {
    return {
      code: 'malformed_response',
      message: 'Provider response exceeded the configured size limit.',
      retryable: false
    };
  }

  if (input.reason === 'network') {
    return {
      code: 'network',
      message: 'Provider network request failed.',
      retryable: true
    };
  }

  return {
    code: 'unknown',
    message: 'Provider request failed for an unknown reason.',
    retryable: false
  };
}

export function unknownProviderError(): ProviderError {
  return {
    code: 'unknown',
    message: 'Provider request failed for an unknown reason.',
    retryable: false
  };
}
