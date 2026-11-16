import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderError,
  ProviderEvent,
  UsageMetadata
} from '@open-employee/contracts/contracts/provider';
import type { ToolCall } from '@open-employee/contracts/contracts/tool';
import {
  HttpTransportError,
  openHttpStream
} from './http-transport';
import { redactSecrets } from './redaction';
import { decodeSseEvents, type SseEvent } from './stream-decoder';

export type CredentialResolver = (credentialRef: string) => Promise<string>;

export interface AdapterOptions {
  config: ProviderConfig;
  resolveCredential: CredentialResolver;
  fetchImpl?: typeof fetch;
  capabilities?: Partial<ProviderCapabilities>;
}

export interface ActiveTurn {
  signal: AbortSignal;
  finish(): void;
}

export class ActiveTurnTracker {
  private readonly turns = new Map<string, AbortController>();

  public begin(turnId: string, externalSignal: AbortSignal): ActiveTurn {
    const controller = new AbortController();
    const onAbort = () => controller.abort();

    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    this.turns.set(turnId, controller);
    let finished = false;

    return {
      signal: controller.signal,
      finish: () => {
        if (finished) return;
        finished = true;
        externalSignal.removeEventListener('abort', onAbort);
        if (this.turns.get(turnId) === controller) {
          this.turns.delete(turnId);
        }
      }
    };
  }

  public async cancel(turnId: string): Promise<void> {
    this.turns.get(turnId)?.abort();
  }
}

export function joinProviderUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonRecord(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseToolArguments(
  rawArguments: string
): Record<string, unknown> | null {
  if (!rawArguments.trim()) return {};

  try {
    const parsed: unknown = JSON.parse(rawArguments);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type ToolCallCompletion =
  | { ok: true; calls: ToolCall[] }
  | { ok: false; message: string };

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

export class ToolCallAccumulator {
  private readonly pending = new Map<number, PendingToolCall>();

  public add(
    index: number,
    id?: string,
    name?: string,
    argumentsDelta?: string
  ): void {
    const call = this.pending.get(index) ?? { argumentsText: '' };
    if (id !== undefined) call.id = id;
    if (name !== undefined) call.name = name;
    if (argumentsDelta !== undefined) {
      call.argumentsText += argumentsDelta;
    }
    this.pending.set(index, call);
  }

  public hasCalls(): boolean {
    return this.pending.size > 0;
  }

  public complete(): ToolCallCompletion {
    const calls: ToolCall[] = [];
    const entries = [...this.pending.entries()].sort(
      (left, right) => left[0] - right[0]
    );

    for (const [index, pending] of entries) {
      if (!pending.id || !pending.name) {
        return {
          ok: false,
          message: `Tool call ${index} is missing an id or name.`
        };
      }

      const args = parseToolArguments(pending.argumentsText);
      if (!args) {
        return {
          ok: false,
          message: `Tool call ${index} contains malformed JSON arguments.`
        };
      }

      calls.push({
        id: pending.id,
        name: pending.name,
        arguments: args,
        rawArguments: pending.argumentsText || '{}'
      });
    }

    return { ok: true, calls };
  }
}

export function providerError(
  code: ProviderError['code'],
  message: string,
  options: Partial<Omit<ProviderError, 'code' | 'message'>> = {}
): ProviderError {
  return {
    code,
    message: redactSecrets(message).slice(0, 2_000),
    retryable: options.retryable ?? false,
    ...(options.providerStatus !== undefined
      ? { providerStatus: options.providerStatus }
      : {}),
    ...(options.providerCode !== undefined
      ? { providerCode: options.providerCode }
      : {}),
    ...(options.retryAfterMs !== undefined
      ? { retryAfterMs: options.retryAfterMs }
      : {}),
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {})
  };
}

export function redactProviderError(
  error: ProviderError,
  secrets: readonly string[] = []
): ProviderError {
  return {
    ...error,
    message: redactSecrets(error.message, secrets)
  };
}

export function malformedResponseError(message: string): ProviderError {
  return providerError('malformed_response', message, { retryable: false });
}

export function authenticationError(): ProviderError {
  return providerError('authentication', 'Provider credential is unavailable.', {
    retryable: false
  });
}

export function errorEvent(error: ProviderError): ProviderEvent {
  return { type: 'error', error };
}

export function cancelledFinish(): ProviderEvent {
  return { type: 'finish', reason: 'cancelled' };
}

export function usageEvent(usage: UsageMetadata): ProviderEvent {
  return { type: 'usage', usage };
}

export function finishEvent(
  reason: Extract<ProviderEvent, { type: 'finish' }>['reason'],
  usage?: UsageMetadata
): ProviderEvent {
  return usage
    ? { type: 'finish', reason, usage }
    : { type: 'finish', reason };
}

export async function resolveCredential(
  resolver: CredentialResolver,
  credentialRef: string
): Promise<string | null> {
  try {
    const credential = await resolver(credentialRef);
    return credential.trim() ? credential : null;
  } catch {
    return null;
  }
}

export async function* openProviderSse(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  config: ProviderConfig;
  signal: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): AsyncGenerator<SseEvent, void, unknown> {
  const response = await openHttpStream(
    {
      url: input.url,
      method: 'POST',
      headers: input.headers,
      body: input.body,
      signal: input.signal
    },
    {
      totalTimeoutMs: input.timeoutMs ?? input.config.timeoutMs,
      streamIdleTimeoutMs: input.config.streamIdleTimeoutMs,
      fetchImpl: input.fetchImpl
    }
  );

  if (!response.body) {
    response.close();
    throw new HttpTransportError(
      malformedResponseError('Provider response body is missing.')
    );
  }

  try {
    for await (const event of decodeSseEvents(response.body)) {
      yield event;
    }
  } finally {
    response.close();
  }
}

export type AdapterStreamError = HttpTransportError | Error;
