import type {
  ProviderConfig,
  ProviderKind
} from '@open-employee/contracts/contracts/provider';
import { PROVIDER_KINDS } from '@open-employee/contracts/contracts/provider';

export type ProviderConfigIssueCode =
  | 'INVALID_INPUT'
  | 'INVALID_ID'
  | 'INVALID_KIND'
  | 'INVALID_BASE_URL'
  | 'URL_CREDENTIALS'
  | 'URL_FRAGMENT'
  | 'URL_QUERY'
  | 'INVALID_MODEL'
  | 'INVALID_CREDENTIAL_REF'
  | 'RAW_CREDENTIAL_REF'
  | 'INVALID_TIMEOUT'
  | 'INVALID_MAX_RETRIES'
  | 'INVALID_STREAM_IDLE_TIMEOUT'
  | 'FORBIDDEN_CREDENTIAL_FIELD'
  | 'INVALID_LEGACY_PROVIDER';

export interface ProviderConfigIssue {
  path: string;
  code: ProviderConfigIssueCode;
  message: string;
}

export type ProviderConfigValidation =
  | { ok: true; config: ProviderConfig }
  | { ok: false; issues: ProviderConfigIssue[] };

export type ProviderConfigErrorCode =
  | 'INVALID_CONFIG'
  | 'DUPLICATE_CONFIG'
  | 'CONFIG_NOT_FOUND';

export class ProviderConfigError extends Error {
  constructor(
    public readonly code: ProviderConfigErrorCode,
    message: string,
    public readonly issues: ProviderConfigIssue[] = []
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

const LEGACY_PROVIDER_KINDS: Record<string, ProviderKind> = {
  openai: 'openai-compatible',
  openrouter: 'openai-compatible',
  custom: 'openai-compatible',
  anthropic: 'anthropic',
  gemini: 'gemini'
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const RAW_CREDENTIAL_PREFIX =
  /^(sk-|sk_|AIza|ghp_|gho_|ghu_|ghs_|ghr_|glpat-|xox[abprs]-|AKIA|eyJ)/;
const CREDENTIAL_FIELD_PATTERN =
  /(api[-_]?key|apikey|token|secret|password|credential|authorization|bearer|cookie|private[-_]?key|client[-_]?secret)/i;

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findCredentialField(
  value: unknown,
  path = 'record'
): string | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findCredentialField(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }

  if (!isRecord(value)) return null;

  for (const [key, child] of Object.entries(value)) {
    if (
      key.toLowerCase() !== 'credentialref' &&
      CREDENTIAL_FIELD_PATTERN.test(key)
    ) {
      return `${path}.${key}`;
    }

    const nested = findCredentialField(child, `${path}.${key}`);
    if (nested) return nested;
  }

  return null;
}

function issue(
  path: string,
  code: ProviderConfigIssueCode,
  message: string
): ProviderConfigIssue {
  return { path, code, message };
}

function validateBaseUrl(value: unknown): ProviderConfigIssue[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [issue('baseUrl', 'INVALID_BASE_URL', 'baseUrl must be a non-empty URL.')];
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [issue('baseUrl', 'INVALID_BASE_URL', 'baseUrl must be a valid URL.')];
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return [issue('baseUrl', 'INVALID_BASE_URL', 'baseUrl must use http or https.')];
  }

  if (!url.hostname) {
    return [issue('baseUrl', 'INVALID_BASE_URL', 'baseUrl must include a host.')];
  }

  const issues: ProviderConfigIssue[] = [];
  if (url.username || url.password) {
    issues.push(
      issue('baseUrl', 'URL_CREDENTIALS', 'baseUrl must not include credentials.')
    );
  }
  if (url.hash) {
    issues.push(issue('baseUrl', 'URL_FRAGMENT', 'baseUrl must not include a fragment.'));
  }
  if (url.search) {
    issues.push(
      issue('baseUrl', 'URL_QUERY', 'baseUrl must not include query parameters.')
    );
  }
  return issues;
}

function validateCredentialRef(value: unknown): ProviderConfigIssue[] {
  if (typeof value !== 'string' || !value.trim()) {
    return [
      issue(
        'credentialRef',
        'INVALID_CREDENTIAL_REF',
        'credentialRef must be a non-empty identifier.'
      )
    ];
  }

  if (/^Bearer\s/i.test(value)) {
    return [
      issue(
        'credentialRef',
        'RAW_CREDENTIAL_REF',
        'credentialRef must not contain a raw credential.'
      )
    ];
  }

  if (!CREDENTIAL_REF_PATTERN.test(value)) {
    return [
      issue(
        'credentialRef',
        'INVALID_CREDENTIAL_REF',
        'credentialRef must be a stable identifier, not a raw credential.'
      )
    ];
  }

  if (RAW_CREDENTIAL_PREFIX.test(value)) {
    return [
      issue(
        'credentialRef',
        'RAW_CREDENTIAL_REF',
        'credentialRef must not contain a raw credential.'
      )
    ];
  }

  return [];
}

export function validateProviderConfig(input: unknown): ProviderConfigValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [issue('record', 'INVALID_INPUT', 'Provider config must be an object.')]
    };
  }

  const issues: ProviderConfigIssue[] = [];
  const forbidden = findCredentialField(input);
  if (forbidden) {
    issues.push(
      issue(
        forbidden,
        'FORBIDDEN_CREDENTIAL_FIELD',
        'Provider config must not contain credential fields.'
      )
    );
  }

  const id = input.id;
  if (typeof id !== 'string' || !id.trim() || !IDENTIFIER_PATTERN.test(id)) {
    issues.push(
      issue('id', 'INVALID_ID', 'id must be a stable non-empty identifier.')
    );
  }

  const kind = input.kind;
  if (typeof kind !== 'string' || !PROVIDER_KINDS.includes(kind as ProviderKind)) {
    issues.push(issue('kind', 'INVALID_KIND', 'kind must be a known provider kind.'));
  }

  issues.push(...validateBaseUrl(input.baseUrl));

  if (typeof input.model !== 'string' || !input.model.trim()) {
    issues.push(issue('model', 'INVALID_MODEL', 'model must be a non-empty string.'));
  }

  issues.push(...validateCredentialRef(input.credentialRef));

  const timeoutMs = input.timeoutMs;
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 600_000
  ) {
    issues.push(
      issue('timeoutMs', 'INVALID_TIMEOUT', 'timeoutMs must be a positive integer.')
    );
  }

  const maxRetries = input.maxRetries;
  if (
    typeof maxRetries !== 'number' ||
    !Number.isInteger(maxRetries) ||
    maxRetries < 0 ||
    maxRetries > 2
  ) {
    issues.push(
      issue('maxRetries', 'INVALID_MAX_RETRIES', 'maxRetries must be between 0 and 2.')
    );
  }

  const streamIdleTimeoutMs = input.streamIdleTimeoutMs;
  if (
    typeof streamIdleTimeoutMs !== 'number' ||
    !Number.isInteger(streamIdleTimeoutMs) ||
    streamIdleTimeoutMs <= 0 ||
    streamIdleTimeoutMs > 600_000
  ) {
    issues.push(
      issue(
        'streamIdleTimeoutMs',
        'INVALID_STREAM_IDLE_TIMEOUT',
        'streamIdleTimeoutMs must be a positive integer.'
      )
    );
  } else if (
    typeof timeoutMs === 'number' &&
    Number.isInteger(timeoutMs) &&
    streamIdleTimeoutMs > timeoutMs
  ) {
    issues.push(
      issue(
        'streamIdleTimeoutMs',
        'INVALID_STREAM_IDLE_TIMEOUT',
        'streamIdleTimeoutMs must not exceed timeoutMs.'
      )
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    config: {
      id: id as string,
      kind: kind as ProviderKind,
      baseUrl: (input.baseUrl as string).trim(),
      model: (input.model as string).trim(),
      credentialRef: (input.credentialRef as string).trim(),
      timeoutMs: timeoutMs as number,
      maxRetries: maxRetries as number,
      streamIdleTimeoutMs: streamIdleTimeoutMs as number
    }
  };
}

export function mapLegacyGatewayRecord(input: unknown): ProviderConfigValidation {
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [
        issue('record', 'INVALID_INPUT', 'Legacy gateway record must be an object.')
      ]
    };
  }

  const forbidden = findCredentialField(input);
  if (forbidden) {
    return {
      ok: false,
      issues: [
        issue(
          forbidden,
          'FORBIDDEN_CREDENTIAL_FIELD',
          'Legacy gateway record must not contain credential fields.'
        )
      ]
    };
  }

  const provider = input.provider;
  if (typeof provider !== 'string' || !LEGACY_PROVIDER_KINDS[provider]) {
    return {
      ok: false,
      issues: [
        issue(
          'provider',
          'INVALID_LEGACY_PROVIDER',
          'Legacy gateway provider is not supported.'
        )
      ]
    };
  }

  const id = input.id;
  if (typeof id !== 'string' || !id.trim()) {
    return {
      ok: false,
      issues: [issue('id', 'INVALID_ID', 'Legacy gateway id is required.')]
    };
  }

  const credentialRef =
    typeof input.credentialRef === 'string' && input.credentialRef.trim()
      ? input.credentialRef
      : `legacy:${id}`;

  return validateProviderConfig({
    id,
    kind: LEGACY_PROVIDER_KINDS[provider],
    baseUrl: input.baseUrl,
    model: input.model,
    credentialRef,
    timeoutMs:
      'timeoutMs' in input ? input.timeoutMs : DEFAULT_TIMEOUT_MS,
    maxRetries:
      'maxRetries' in input ? input.maxRetries : DEFAULT_MAX_RETRIES,
    streamIdleTimeoutMs:
      'streamIdleTimeoutMs' in input
        ? input.streamIdleTimeoutMs
        : DEFAULT_STREAM_IDLE_TIMEOUT_MS
  });
}

export class ProviderConfigStore {
  private readonly configs = new Map<string, ProviderConfig>();

  public add(input: unknown): ProviderConfig {
    const validation = validateProviderConfig(input);
    if (!validation.ok) {
      throw new ProviderConfigError(
        'INVALID_CONFIG',
        'Provider config is invalid.',
        validation.issues
      );
    }

    if (this.configs.has(validation.config.id)) {
      throw new ProviderConfigError(
        'DUPLICATE_CONFIG',
        `Provider config "${validation.config.id}" is already registered.`
      );
    }

    this.configs.set(validation.config.id, validation.config);
    return validation.config;
  }

  public get(providerId: string): ProviderConfig | undefined {
    return this.configs.get(providerId);
  }

  public require(providerId: string): ProviderConfig {
    const config = this.get(providerId);
    if (!config) {
      throw new ProviderConfigError(
        'CONFIG_NOT_FOUND',
        `Provider config "${providerId}" is not registered.`
      );
    }
    return config;
  }

  public list(): ProviderConfig[] {
    return [...this.configs.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    );
  }
}
