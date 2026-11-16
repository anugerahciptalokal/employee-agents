import type { ProviderAdapter } from './provider-runtime';

export type ProviderRegistryErrorCode =
  | 'INVALID_ID'
  | 'DUPLICATE_PROVIDER'
  | 'PROVIDER_NOT_FOUND';

export class ProviderRegistryError extends Error {
  constructor(
    public readonly code: ProviderRegistryErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ProviderRegistryError';
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  public register(adapter: ProviderAdapter): void {
    const id = adapter.id.trim();
    if (!id || id !== adapter.id) {
      throw new ProviderRegistryError(
        'INVALID_ID',
        'Provider adapter id must be a non-empty trimmed string.'
      );
    }

    if (this.adapters.has(id)) {
      throw new ProviderRegistryError(
        'DUPLICATE_PROVIDER',
        `Provider adapter "${id}" is already registered.`
      );
    }

    this.adapters.set(id, adapter);
  }

  public get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  public require(providerId: string): ProviderAdapter {
    const adapter = this.get(providerId);
    if (!adapter) {
      throw new ProviderRegistryError(
        'PROVIDER_NOT_FOUND',
        `Provider "${providerId}" is not registered.`
      );
    }
    return adapter;
  }

  public list(): ProviderAdapter[] {
    return [...this.adapters.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
  }
}
