import type {
  CredentialCancelMessage,
  CredentialPurpose,
  CredentialRequestMessage,
  CredentialResponseMessage
} from '../service/credentials/credential-broker';
import { isCredentialReference } from '../service/credentials/credential-broker';

export interface MainCredentialResolveInput {
  providerId: string;
  credentialRef: string;
  purpose: CredentialPurpose;
  signal?: AbortSignal;
}

export type MainCredentialResolver = (
  input: MainCredentialResolveInput
) => string | null | Promise<string | null>;

export interface MainCredentialBrokerOptions {
  nonce: string;
  resolver: MainCredentialResolver;
  allowedProviders?: readonly string[];
  ttlMs?: number;
  resolverTimeoutMs?: number;
  now?: () => number;
}

export interface VaultCredentialView {
  getDecryptedCredentialValue(id: string): string | null;
  getAIGateway(): { provider: string };
  getDecryptedAIGatewayKey(): string | null;
  listAIGateways(): Array<{ id: string; provider: string }>;
  getDecryptedGatewayKey(id?: string): string | null;
  listCredentials(): Array<{
    id: string;
    category: string;
    serviceDomain?: string;
  }>;
}

interface PendingRequest {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  cancelled: Promise<null>;
  resolveCancelled: () => void;
}

const DEFAULT_ALLOWED_PROVIDERS = ['openrouter'] as const;
const DEFAULT_TTL_MS = 60_000;
const DEFAULT_RESOLVER_TIMEOUT_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorResponse(
  requestId: string,
  code: string,
  message: string
): CredentialResponseMessage {
  return {
    type: 'credential_response',
    requestId,
    ok: false,
    error: { code, message }
  };
}

const ALLOWED_OPENROUTER_HOSTS = new Set(['openrouter.ai', 'api.openrouter.ai']);

export function isOpenRouterDomain(domain: string | undefined): boolean {
  if (typeof domain !== 'string' || !domain.trim()) return false;

  const raw = domain.trim();
  const candidate = raw.includes('://') ? raw : `https://${raw}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  if (parsed.port !== '') {
    return false;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_OPENROUTER_HOSTS.has(host);
}

export class MainCredentialBroker {
  private readonly nonce: string;
  private readonly resolver: MainCredentialResolver;
  private readonly allowedProviders: Set<string>;
  private readonly ttlMs: number;
  private readonly resolverTimeoutMs: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: MainCredentialBrokerOptions) {
    this.nonce = options.nonce;
    this.resolver = options.resolver;
    this.allowedProviders = new Set(
      options.allowedProviders ?? DEFAULT_ALLOWED_PROVIDERS
    );
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.resolverTimeoutMs =
      options.resolverTimeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  public async handleMessage(
    message: unknown,
    send: (response: CredentialResponseMessage) => void
  ): Promise<void> {
    if (!isRecord(message)) return;

    if (message.type === 'credential_cancel') {
      this.handleCancel(message as unknown as CredentialCancelMessage);
      return;
    }

    if (message.type === 'credential_request') {
      await this.handleRequest(message, send);
    }
  }

  public async handleRequest(
    message: unknown,
    send: (response: CredentialResponseMessage) => void
  ): Promise<void> {
    if (!isRecord(message) || message.type !== 'credential_request') {
      return;
    }

    const request = message as unknown as CredentialRequestMessage;
    if (
      typeof request.requestId !== 'string' ||
      request.requestId.length === 0 ||
      request.requestId.length > 128
    ) {
      return;
    }

    const requestId = request.requestId;
    const respond = (response: CredentialResponseMessage): void => {
      try {
        send(response);
      } catch {
        // The child may already be gone.
      }
    };

    if (this.pending.has(requestId)) {
      respond(
        errorResponse(requestId, 'INVALID_REQUEST', 'Credential request is invalid.')
      );
      return;
    }

    if (typeof request.nonce !== 'string' || request.nonce !== this.nonce) {
      respond(
        errorResponse(
          requestId,
          'UNAUTHORIZED',
          'Credential request is not authorized.'
        )
      );
      return;
    }

    if (
      typeof request.providerId !== 'string' ||
      !this.allowedProviders.has(request.providerId)
    ) {
      respond(
        errorResponse(
          requestId,
          'UNAUTHORIZED',
          'Credential request is not authorized.'
        )
      );
      return;
    }

    if (
      request.purpose !== 'provider_turn' &&
      request.purpose !== 'model_discovery'
    ) {
      respond(
        errorResponse(requestId, 'INVALID_REQUEST', 'Credential request is invalid.')
      );
      return;
    }

    if (!isCredentialReference(request.credentialRef)) {
      respond(
        errorResponse(
          requestId,
          'INVALID_CREDENTIAL_REF',
          'Credential reference is invalid.'
        )
      );
      return;
    }

    const controller = new AbortController();
    let resolveCancelled!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      resolveCancelled = () => resolve(null);
    });
    const timer = setTimeout(() => {
      if (!this.pending.has(requestId)) return;
      this.pending.delete(requestId);
      controller.abort();
      resolveCancelled();
      respond(
        errorResponse(
          requestId,
          'CREDENTIAL_TIMEOUT',
          'Credential resolution timed out.'
        )
      );
    }, this.resolverTimeoutMs);

    this.pending.set(requestId, {
      controller,
      timer,
      cancelled,
      resolveCancelled
    });

    let secret: string | null = null;
    try {
      secret = await Promise.race([
        Promise.resolve(
          this.resolver({
            providerId: request.providerId,
            credentialRef: request.credentialRef,
            purpose: request.purpose,
            signal: controller.signal
          })
        ),
        cancelled
      ]);
    } catch {
      secret = null;
    }

    if (!this.pending.has(requestId) || controller.signal.aborted) {
      return;
    }

    const pending = this.pending.get(requestId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(requestId);

    if (!secret || !secret.trim()) {
      respond(
        errorResponse(
          requestId,
          'CREDENTIAL_UNAVAILABLE',
          'Provider credential is unavailable.'
        )
      );
      return;
    }

    respond({
      type: 'credential_response',
      requestId,
      ok: true,
      credential: {
        secret: secret.trim(),
        expiresAt: this.now() + this.ttlMs
      }
    });
  }

  public dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.controller.abort();
      pending.resolveCancelled();
    }
    this.pending.clear();
  }

  private handleCancel(message: CredentialCancelMessage): void {
    if (
      typeof message.requestId !== 'string' ||
      typeof message.nonce !== 'string' ||
      message.nonce !== this.nonce
    ) {
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    pending.controller.abort();
    pending.resolveCancelled();
    this.pending.delete(message.requestId);
  }
}

export function createVaultCredentialResolver(
  vault: VaultCredentialView | null
): MainCredentialResolver {
  return (input) => {
    if (!vault || input.providerId !== 'openrouter') return null;

    const credentials = vault.listCredentials();
    const resolveOperational = (id: string): string | null => {
      const metadata = credentials.find((entry) => entry.id === id);
      if (
        !metadata ||
        metadata.category !== 'api_token' ||
        !isOpenRouterDomain(metadata.serviceDomain)
      ) {
        return null;
      }
      return vault.getDecryptedCredentialValue(id);
    };

    const ref = input.credentialRef;
    if (ref.startsWith('vault:')) {
      const id = ref.slice('vault:'.length);
      return id ? resolveOperational(id) : null;
    }

    if (ref.startsWith('gateway:') || ref.startsWith('legacy:')) {
      const prefix = ref.startsWith('gateway:') ? 'gateway:' : 'legacy:';
      const id = ref.slice(prefix.length);
      if (!id) return null;
      const gateway = vault
        .listAIGateways()
        .find((entry) => entry.id === id && entry.provider === 'openrouter');
      return gateway ? vault.getDecryptedGatewayKey(id) : null;
    }

    const operational = resolveOperational(ref);
    if (operational) return operational;

    const directGateway = vault
      .listAIGateways()
      .find((entry) => entry.id === ref && entry.provider === 'openrouter');
    if (directGateway) {
      return vault.getDecryptedGatewayKey(ref);
    }

    if (ref === 'openrouter') {
      const active = vault.getAIGateway();
      if (active.provider === 'openrouter') {
        return vault.getDecryptedAIGatewayKey();
      }
    }

    return null;
  };
}
