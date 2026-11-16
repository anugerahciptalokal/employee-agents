import { randomUUID } from 'crypto';
import type { CredentialResolver } from '../providers/adapter-shared';
import type {
  CredentialBroker,
  CredentialCancelMessage,
  CredentialPurpose,
  CredentialRequestMessage,
  CredentialResponseMessage,
  CredentialResolveOptions,
  ProviderCredential
} from './credential-broker';
import { isCredentialReference } from './credential-broker';

export interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  removeListener?(
    event: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  off?(
    event: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  postMessage(message: unknown): void;
}

export class CredentialBrokerError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'CredentialBrokerError';
  }
}

export interface ParentPortCredentialBrokerOptions {
  port: ParentPortLike;
  nonce: string;
  timeoutMs?: number;
  idFactory?: () => string;
  now?: () => number;
}

interface PendingRequest {
  resolve: (credential: ProviderCredential) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
  signal?: AbortSignal;
}

function responseError(
  message: CredentialResponseMessage
): CredentialBrokerError {
  const error = (message as { error?: unknown }).error;
  if (
    message.ok === false &&
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return new CredentialBrokerError(
      (error as { code: string }).code,
      (error as { message: string }).message
    );
  }

  return new CredentialBrokerError(
    'BROKER_INVALID_RESPONSE',
    'Credential broker returned an invalid response.'
  );
}

export class ParentPortCredentialBroker implements CredentialBroker {
  private readonly port: ParentPortLike;
  private readonly nonce: string;
  private readonly timeoutMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingRequest>();
  private disposed = false;

  constructor(options: ParentPortCredentialBrokerOptions) {
    this.port = options.port;
    this.nonce = options.nonce;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? Date.now;
    this.port.on('message', this.onMessage);
  }

  public resolve(
    providerId: string,
    purpose: CredentialPurpose,
    credentialRef: string,
    options: CredentialResolveOptions = {}
  ): Promise<ProviderCredential> {
    if (this.disposed) {
      return Promise.reject(
        new CredentialBrokerError(
          'BROKER_UNAVAILABLE',
          'Credential broker is unavailable.'
        )
      );
    }

    if (!providerId.trim()) {
      return Promise.reject(
        new CredentialBrokerError(
          'INVALID_REQUEST',
          'Credential request is invalid.'
        )
      );
    }

    if (!isCredentialReference(credentialRef)) {
      return Promise.reject(
        new CredentialBrokerError(
          'INVALID_CREDENTIAL_REF',
          'Credential reference is invalid.'
        )
      );
    }

    if (options.signal?.aborted) {
      return Promise.reject(
        new CredentialBrokerError(
          'BROKER_CANCELLED',
          'Credential request was cancelled.'
        )
      );
    }

    const requestId = this.idFactory();
    const request: CredentialRequestMessage = {
      type: 'credential_request',
      requestId,
      nonce: this.nonce,
      providerId,
      purpose,
      credentialRef
    };

    return new Promise<ProviderCredential>((resolve, reject) => {
      const cleanup = (): void => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) {
          pending.signal.removeEventListener('abort', pending.onAbort);
        }
        this.pending.delete(requestId);
      };

      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };

      const timer = setTimeout(() => {
        this.sendCancel(requestId);
        fail(
          new CredentialBrokerError(
            'BROKER_TIMEOUT',
            'Credential broker request timed out.'
          )
        );
      }, this.timeoutMs);

      const onAbort = (): void => {
        this.sendCancel(requestId);
        fail(
          new CredentialBrokerError(
            'BROKER_CANCELLED',
            'Credential request was cancelled.'
          )
        );
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
        if (options.signal.aborted) {
          clearTimeout(timer);
          options.signal.removeEventListener('abort', onAbort);
          reject(
            new CredentialBrokerError(
              'BROKER_CANCELLED',
              'Credential request was cancelled.'
            )
          );
          return;
        }
      }

      this.pending.set(requestId, {
        resolve: (credential) => {
          cleanup();
          resolve(credential);
        },
        reject: fail,
        timer,
        onAbort,
        signal: options.signal
      });

      try {
        this.port.postMessage(request);
      } catch {
        fail(
          new CredentialBrokerError(
            'BROKER_UNAVAILABLE',
            'Credential broker is unavailable.'
          )
        );
      }
    });
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.port.removeListener) {
      this.port.removeListener('message', this.onMessage);
    } else {
      this.port.off?.('message', this.onMessage);
    }

    for (const [requestId, pending] of this.pending) {
      this.sendCancel(requestId);
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener('abort', pending.onAbort);
      }
      pending.reject(
        new CredentialBrokerError(
          'BROKER_DISPOSED',
          'Credential broker was disposed.'
        )
      );
    }
    this.pending.clear();
  }

  private sendCancel(requestId: string): void {
    const message: CredentialCancelMessage = {
      type: 'credential_cancel',
      requestId,
      nonce: this.nonce
    };
    try {
      this.port.postMessage(message);
    } catch {
      // The broker may already be gone.
    }
  }

  private readonly onMessage = (event: { data: unknown }): void => {
    const message = event?.data;
    if (
      !message ||
      typeof message !== 'object' ||
      (message as { type?: unknown }).type !== 'credential_response'
    ) {
      return;
    }

    const response = message as CredentialResponseMessage;
    if (
      typeof response.requestId !== 'string' ||
      !this.pending.has(response.requestId)
    ) {
      return;
    }

    const pending = this.pending.get(response.requestId);
    if (!pending) return;

    if (response.ok === true) {
      const credential = response.credential;
      if (
        !credential ||
        typeof credential.secret !== 'string' ||
        credential.secret.length === 0 ||
        (credential.expiresAt !== undefined &&
          (!Number.isFinite(credential.expiresAt) ||
            credential.expiresAt <= this.now()))
      ) {
        const expired =
          credential?.expiresAt !== undefined &&
          Number.isFinite(credential.expiresAt) &&
          credential.expiresAt <= this.now();
        pending.reject(
          new CredentialBrokerError(
            expired ? 'BROKER_CREDENTIAL_EXPIRED' : 'BROKER_INVALID_RESPONSE',
            expired
              ? 'Credential has expired.'
              : 'Credential broker returned an invalid response.'
          )
        );
        this.removePending(response.requestId);
        return;
      }

      pending.resolve({
        secret: credential.secret,
        ...(credential.expiresAt !== undefined
          ? { expiresAt: credential.expiresAt }
          : {})
      });
      return;
    }

    pending.reject(responseError(response));
    this.removePending(response.requestId);
  };

  private removePending(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    this.pending.delete(requestId);
  }
}

export function createBrokerCredentialResolver(
  broker: CredentialBroker,
  providerId: string,
  purpose: CredentialPurpose = 'provider_turn'
): CredentialResolver {
  return async (credentialRef: string): Promise<string> => {
    const credential = await broker.resolve(providerId, purpose, credentialRef);
    return credential.secret;
  };
}

export function createOpenRouterCredentialResolver(
  broker: CredentialBroker,
  purpose: CredentialPurpose = 'provider_turn'
): CredentialResolver {
  return createBrokerCredentialResolver(broker, 'openrouter', purpose);
}
