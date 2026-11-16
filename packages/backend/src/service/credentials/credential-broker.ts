export type CredentialPurpose = 'provider_turn' | 'model_discovery';

export interface ProviderCredential {
  secret: string;
  expiresAt?: number;
}

export interface CredentialResolveOptions {
  signal?: AbortSignal;
}

export interface CredentialBroker {
  resolve(
    providerId: string,
    purpose: CredentialPurpose,
    credentialRef: string,
    options?: CredentialResolveOptions
  ): Promise<ProviderCredential>;
  dispose?(): void;
}

export interface CredentialRequestMessage {
  type: 'credential_request';
  requestId: string;
  nonce: string;
  providerId: string;
  purpose: CredentialPurpose;
  credentialRef: string;
}

export interface CredentialCancelMessage {
  type: 'credential_cancel';
  requestId: string;
  nonce: string;
}

export interface CredentialSuccessResponse {
  type: 'credential_response';
  requestId: string;
  ok: true;
  credential: ProviderCredential;
}

export interface CredentialErrorResponse {
  type: 'credential_response';
  requestId: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type CredentialResponseMessage =
  | CredentialSuccessResponse
  | CredentialErrorResponse;

const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const RAW_CREDENTIAL_PREFIX =
  /^(sk-|sk_|AIza|ghp_|gho_|ghu_|ghs_|ghr_|glpat-|xox[abprs]-|AKIA|eyJ)/;

export function isCredentialReference(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CREDENTIAL_REF_PATTERN.test(value) &&
    !/^Bearer\s/i.test(value) &&
    !RAW_CREDENTIAL_PREFIX.test(value)
  );
}
