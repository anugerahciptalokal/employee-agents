import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  TurnRequest
} from '@open-employee/contracts/contracts/provider';
import { validateProviderEvent } from './contract-guards';
import type { ProviderAdapter, ProviderTurnRuntime } from './provider-runtime';

export type FakeProviderStep =
  | ProviderEvent
  | { type: 'delay'; ms: number };

export interface FakeProviderScenario {
  id: string;
  modelId: string;
  steps: FakeProviderStep[];
}

export interface FakeProviderOptions {
  id?: string;
  capabilities?: ProviderCapabilities;
  scenarios: FakeProviderScenario[];
  maxCancelledTurns?: number;
}

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true,
  tools: true,
  streaming: true,
  images: false,
  jsonMode: true,
  sessions: false
};

function isDelay(step: FakeProviderStep): step is { type: 'delay'; ms: number } {
  return step.type === 'delay';
}

function waitForDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish();

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FakeProvider implements ProviderAdapter {
  public readonly id: string;
  public readonly kind = 'fake' as const;
  public readonly capabilities: ProviderCapabilities;
  private readonly scenarios: FakeProviderScenario[];
  private readonly scenariosByModel = new Map<string, FakeProviderScenario>();
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly cancelledTurns = new Map<string, number>();
  private readonly maxCancelledTurns: number;
  private cancellationSequence = 0;

  constructor(options: FakeProviderOptions) {
    this.id = options.id ?? 'fake-provider';
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
    this.scenarios = options.scenarios;
    this.maxCancelledTurns = options.maxCancelledTurns ?? 1_024;

    if (!Number.isInteger(this.maxCancelledTurns) || this.maxCancelledTurns < 1) {
      throw new Error('Fake provider maxCancelledTurns must be a positive integer.');
    }

    for (const scenario of options.scenarios) {
      if (!scenario.id.trim()) {
        throw new Error('Fake provider scenario id is required.');
      }
      if (!scenario.modelId.trim()) {
        throw new Error('Fake provider scenario modelId is required.');
      }
      if (this.scenariosByModel.has(scenario.modelId)) {
        throw new Error(`Duplicate fake provider model "${scenario.modelId}".`);
      }

      let terminalSeen = false;
      for (let index = 0; index < scenario.steps.length; index += 1) {
        const step = scenario.steps[index];

        if (isDelay(step)) {
          if (!Number.isInteger(step.ms) || step.ms < 0) {
            throw new Error(`Fake provider delay at step ${index} must be a non-negative integer.`);
          }
          if (terminalSeen) {
            throw new Error('Fake provider scenario cannot contain steps after a terminal event.');
          }
          continue;
        }

        const validation = validateProviderEvent(step, `scenario.steps[${index}]`);
        if (!validation.ok) {
          throw new Error(
            `Invalid fake provider event: ${validation.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join('; ')}`
          );
        }

        if (terminalSeen) {
          throw new Error('Fake provider scenario cannot contain steps after a terminal event.');
        }

        if (step.type === 'finish' || step.type === 'error') {
          terminalSeen = true;
        }
      }

      this.scenariosByModel.set(scenario.modelId, scenario);
    }
  }

  public async listModels(): Promise<ModelInfo[]> {
    return this.scenarios.map((scenario) => ({
      providerId: this.id,
      modelId: scenario.modelId,
      displayName: scenario.modelId,
      capabilities: this.capabilities,
      contextWindow: 128_000,
      maxOutputTokens: 8_192
    }));
  }

  public async *startTurn(
    request: TurnRequest,
    runtime: ProviderTurnRuntime
  ): AsyncIterable<ProviderEvent> {
    const scenario = this.scenariosByModel.get(request.model);
    if (!scenario) {
      yield {
        type: 'error',
        error: {
          code: 'invalid_request',
          message: `Unknown fake provider model "${request.model}".`,
          retryable: false
        }
      };
      return;
    }

    if (this.cancelledTurns.has(request.turnId)) {
      this.cancelledTurns.delete(request.turnId);
      yield { type: 'finish', reason: 'cancelled' };
      return;
    }

    if (runtime.signal.aborted) {
      yield { type: 'finish', reason: 'cancelled' };
      return;
    }

    const controller = new AbortController();
    this.activeTurns.set(request.turnId, controller);

    const onAbort = () => controller.abort();
    runtime.signal.addEventListener('abort', onAbort, { once: true });
    if (runtime.signal.aborted) controller.abort();

    const pendingToolCalls = new Map<number, PendingToolCall>();

    try {
      for (const step of scenario.steps) {
        if (controller.signal.aborted) break;

        if (isDelay(step)) {
          await waitForDelay(step.ms, controller.signal);
          if (controller.signal.aborted) break;
          continue;
        }

        if (step.type === 'tool_call_delta') {
          const pending = pendingToolCalls.get(step.index) ?? { argumentsText: '' };
          if (step.id !== undefined) pending.id = step.id;
          if (step.name !== undefined) pending.name = step.name;
          if (step.argumentsDelta !== undefined) {
            pending.argumentsText += step.argumentsDelta;
          }
          pendingToolCalls.set(step.index, pending);
          yield step;
          continue;
        }

        if (step.type === 'tool_call') {
          if (step.call.id) {
            for (const [index, pending] of pendingToolCalls) {
              if (pending.id === step.call.id) pendingToolCalls.delete(index);
            }
          }
          yield step;
          continue;
        }

        if (step.type === 'finish') {
          const completed = this.completePendingToolCalls(pendingToolCalls);
          for (const event of completed.events) {
            yield event;
          }
          if (completed.error) {
            yield completed.error;
            return;
          }
          yield step;
          return;
        }

        if (step.type === 'error') {
          yield step;
          return;
        }

        yield step;
      }

      if (controller.signal.aborted) {
        yield { type: 'finish', reason: 'cancelled' };
        return;
      }

      const completed = this.completePendingToolCalls(pendingToolCalls);
      for (const event of completed.events) {
        yield event;
      }
      if (completed.error) {
        yield completed.error;
        return;
      }

      yield { type: 'finish', reason: 'stop' };
    } finally {
      runtime.signal.removeEventListener('abort', onAbort);
      this.activeTurns.delete(request.turnId);
      this.cancelledTurns.delete(request.turnId);
    }
  }

  private completePendingToolCalls(pendingToolCalls: Map<number, PendingToolCall>): {
    events: ProviderEvent[];
    error?: ProviderEvent;
  } {
    const events: ProviderEvent[] = [];
    const sorted = [...pendingToolCalls.entries()].sort(
      (left, right) => left[0] - right[0]
    );

    for (const [index, pending] of sorted) {
      if (!pending.name) {
        return {
          events,
          error: {
            type: 'error',
            error: {
              code: 'malformed_response',
              message: `Fake tool call ${index} is missing a name.`,
              retryable: false
            }
          }
        };
      }

      let args: unknown;
      try {
        args = pending.argumentsText ? JSON.parse(pending.argumentsText) : {};
      } catch {
        return {
          events,
          error: {
            type: 'error',
            error: {
              code: 'malformed_response',
              message: `Fake tool call ${index} has invalid arguments JSON.`,
              retryable: false
            }
          }
        };
      }

      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        return {
          events,
          error: {
            type: 'error',
            error: {
              code: 'malformed_response',
              message: `Fake tool call ${index} arguments must be an object.`,
              retryable: false
            }
          }
        };
      }

      events.push({
        type: 'tool_call',
        call: {
          id: pending.id ?? `fake-call-${index}`,
          name: pending.name,
          arguments: args as Record<string, unknown>
        }
      });
    }

    return { events };
  }

  public async cancel(turnId: string): Promise<void> {
    this.cancelledTurns.delete(turnId);
    this.cancellationSequence += 1;
    this.cancelledTurns.set(turnId, this.cancellationSequence);

    while (this.cancelledTurns.size > this.maxCancelledTurns) {
      const oldest = this.cancelledTurns.keys().next().value;
      if (oldest === undefined) break;
      this.cancelledTurns.delete(oldest);
    }

    this.activeTurns.get(turnId)?.abort();
  }
}
