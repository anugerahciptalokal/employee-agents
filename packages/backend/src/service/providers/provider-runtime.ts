import type {
  ModelInfo,
  ProviderCapabilities,
  ProviderEvent,
  ProviderKind,
  TurnRequest
} from '@open-employee/contracts/contracts/provider';

export interface ProviderTurnRuntime {
  signal: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  startTurn(
    request: TurnRequest,
    runtime: ProviderTurnRuntime
  ): AsyncIterable<ProviderEvent>;
  cancel(turnId: string): Promise<void>;
  dispose?(): Promise<void>;
}
