import type { ProviderError } from '@open-employee/contracts/contracts/provider';
import {
  normalizeHttpProviderError,
  normalizeNetworkProviderError,
  type TransportFailureReason
} from './provider-errors';
import { redactHeaders } from './redaction';

export interface HttpTransportOptions {
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxResponseBytes?: number;
  maxErrorBodyBytes?: number;
  fetchImpl?: typeof fetch;
}

export interface HttpStreamRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpStreamResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | null;
  close(): void;
}

export class HttpTransportError extends Error {
  public readonly providerError: ProviderError;
  public readonly status?: number;

  constructor(providerError: ProviderError, status?: number) {
    super(providerError.message);
    this.name = 'HttpTransportError';
    this.providerError = providerError;
    this.status = status;
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ERROR_BODY_BYTES = 64 * 1024;

async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<string> {
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - total;
      const slice = value.subarray(0, remaining);
      text += decoder.decode(slice, { stream: true });
      total += slice.byteLength;

      if (slice.byteLength < value.byteLength) break;
    }

    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function openHttpStream(
  request: HttpStreamRequest,
  options: HttpTransportOptions = {}
): Promise<HttpStreamResponse> {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const streamIdleTimeoutMs =
    options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxErrorBodyBytes =
    options.maxErrorBodyBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  let reason: TransportFailureReason | null = null;
  let cleaned = false;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let totalTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;

    if (connectTimer) clearTimeout(connectTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  };

  const abort = (nextReason: TransportFailureReason): void => {
    if (!controller.signal.aborted) {
      reason = nextReason;
      controller.abort();
    }
  };

  const onCallerAbort = (): void => abort('caller');

  if (request.signal?.aborted) {
    abort('caller');
  } else {
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  }

  totalTimer = setTimeout(() => abort('timeout'), totalTimeoutMs);
  connectTimer = setTimeout(
    () => abort('connect'),
    Math.min(connectTimeoutMs, totalTimeoutMs)
  );

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method ?? 'GET',
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
  } catch (error) {
    cleanup();
    throw new HttpTransportError(
      normalizeNetworkProviderError({
        error,
        reason: reason ?? 'network'
      })
    );
  }

  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  const rawHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    rawHeaders[name] = value;
  });
  const safeHeaders = redactHeaders(rawHeaders);
  const requestId =
    rawHeaders['x-request-id'] ?? rawHeaders['request-id'];

  if (!response.ok) {
    let errorText = '';
    try {
      errorText = await readLimitedText(response.body, maxErrorBodyBytes);
    } catch (error) {
      cleanup();
      throw new HttpTransportError(
        normalizeNetworkProviderError({
          error,
          reason: reason ?? 'network'
        })
      );
    }

    cleanup();
    throw new HttpTransportError(
      normalizeHttpProviderError({
        status: response.status,
        headers: rawHeaders,
        body: errorText,
        requestId
      }),
      response.status
    );
  }

  if (!response.body) {
    cleanup();
    return {
      status: response.status,
      headers: safeHeaders,
      body: null,
      close: () => undefined
    };
  }

  const reader = response.body.getReader();
  let totalBytes = 0;

  const armIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (streamIdleTimeoutMs > 0) {
      idleTimer = setTimeout(() => abort('idle'), streamIdleTimeoutMs);
    }
  };

  const body = new ReadableStream<Uint8Array>({
    start() {
      armIdleTimer();
    },
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          cleanup();
          streamController.close();
          return;
        }

        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
          reason = 'size';
          cleanup();
          await reader.cancel().catch(() => undefined);
          streamController.error(
            new HttpTransportError(
              normalizeNetworkProviderError({
                error: null,
                reason: 'size'
              })
            )
          );
          return;
        }

        armIdleTimer();
        streamController.enqueue(value);
      } catch (error) {
        cleanup();
        streamController.error(
          new HttpTransportError(
            normalizeNetworkProviderError({
              error,
              reason: reason ?? 'network'
            })
          )
        );
      }
    },
    cancel(cancelReason) {
      cleanup();
      void reader.cancel(cancelReason).catch(() => undefined);
    }
  });

  return {
    status: response.status,
    headers: safeHeaders,
    body,
    close: () => {
      abort('caller');
      cleanup();
      void reader.cancel('closed').catch(() => undefined);
    }
  };
}
