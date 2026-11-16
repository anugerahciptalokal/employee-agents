import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  chmodSync
} from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { getDataLayoutPaths, migrateLegacyDataLayout } from '../data-root';
import {
  redactSecrets as redactSecretsWithPatterns,
  redactDeep as redactDeepWithPatterns
} from '../../service/providers/redaction';
import type {
  EncryptedVaultFile,
  AIGatewayProvider,
  AIGatewayStatus,
  AIGatewayEntry,
  AIGatewayPublic,
  CredentialValidationStatus,
  OpenRouterCredentialStatus,
  VaultCredentialCategory,
  VaultCredentialPublic,
  VaultCredentialEntry
} from '@open-employee/contracts/types';

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const CHATGPT_DEFAULT_BASE_URL = 'https://chatgpt.com';
export const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
export const LEGACY_MIGRATION_ERROR_MESSAGE =
  'Legacy insecure AES credential detected. Please re-enter your OpenRouter API key to encrypt it with the OS keychain.';

export interface VaultSafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

export interface VaultManagerOptions {
  safeStorage?: VaultSafeStorageAdapter | null;
}

export interface VaultMigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  migrationRequired?: boolean;
  error?: string;
}

const ALLOWED_OPENROUTER_HOSTS = new Set(['openrouter.ai', 'api.openrouter.ai']);
const ALLOWED_OPENAI_HOSTS = new Set(['api.openai.com']);

export function isCustomGatewayAllowed(): boolean {
  if (
    process.env.OPEN_EMPLOYEE_ALLOW_CUSTOM_GATEWAY === '1' ||
    process.env.OPEN_EMPLOYEE_ALLOW_CUSTOM_GATEWAYS === '1'
  ) {
    return true;
  }
  // In dev, standalone server, or desktop production (outside test runner), default to allowed
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') {
    return true;
  }
  return false;
}

export function isValidAIGatewayUrl(rawUrl: string | undefined): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return false;
  }

  // Plain HTTP is only permitted on loopback for local development/testing
  if (
    parsed.protocol === 'http:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    return false;
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return false;
  }

  if (!parsed.hostname || parsed.hostname.length === 0) {
    return false;
  }

  return true;
}

function isValidAllowedHttpsHost(
  rawUrl: string | undefined,
  allowedHosts: ReadonlySet<string>
): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
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
  return allowedHosts.has(host);
}

export function isValidOpenRouterBaseUrl(rawUrl: string | undefined): boolean {
  return isValidAllowedHttpsHost(rawUrl, ALLOWED_OPENROUTER_HOSTS);
}

export function isValidOpenAIBaseUrl(rawUrl: string | undefined): boolean {
  return isValidAllowedHttpsHost(rawUrl, ALLOWED_OPENAI_HOSTS);
}

export function isSupportedGatewayProvider(provider: string | undefined): boolean {
  return (
    provider === 'openrouter' ||
    provider === 'openai' ||
    provider === 'chatgpt' ||
    (isCustomGatewayAllowed() && provider === 'custom')
  );
}

export function isAllowedGatewayUrlForProvider(
  provider: string | undefined,
  baseUrl: string | undefined
): boolean {
  if (provider === 'openrouter' && isValidOpenRouterBaseUrl(baseUrl)) {
    return true;
  }
  if (provider === 'openai' && isValidOpenAIBaseUrl(baseUrl)) {
    return true;
  }
  if (provider === 'chatgpt') {
    return !baseUrl || baseUrl.trim() === '' || baseUrl.trim().startsWith('https://chatgpt.com');
  }
  return isCustomGatewayAllowed() && isValidAIGatewayUrl(baseUrl);
}

export function normalizeOpenRouterBaseUrl(rawUrl?: string, provider?: string): string {
  const defaultUrl =
    provider === 'openai'
      ? OPENAI_DEFAULT_BASE_URL
      : provider === 'chatgpt'
        ? CHATGPT_DEFAULT_BASE_URL
        : OPENROUTER_DEFAULT_BASE_URL;
  const candidate = rawUrl?.trim() || defaultUrl;
  return candidate.replace(/\/+$/, '');
}

function isLegacyAesCiphertext(value: string | undefined): boolean {
  return Boolean(value && value.startsWith('ENC:AES:'));
}

export class VaultManager {
  private filePath: string;
  private state: EncryptedVaultFile;
  private activeSecrets: Set<string> = new Set();
  private safeStorage: VaultSafeStorageAdapter | null;
  private legacyMigrationRequired = false;

  constructor(vaultPath?: string, options: VaultManagerOptions = {}) {
    if (!vaultPath) {
      migrateLegacyDataLayout();
    }

    const layout = getDataLayoutPaths();
    this.filePath = vaultPath || layout.vaultPath;
    const targetDir = dirname(this.filePath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    this.safeStorage = options.safeStorage !== undefined ? options.safeStorage : null;
    this.state = this.loadOrCreateVault();
    this.migrateLegacySecretsToOsStorage();
    this.rebuildActiveSecretCache();
  }

  private getDefaultVaultState(): EncryptedVaultFile {
    return {
      version: 1,
      updatedAt: Date.now(),
      aiGateway: {
        provider: 'openrouter',
        baseUrl: OPENROUTER_DEFAULT_BASE_URL,
        model: 'claude-3-5-sonnet',
        apiKeyEncrypted: '',
        updatedAt: null,
        validationStatus: 'unverified'
      },
      aiGateways: [],
      vault: {
        credentials: []
      }
    };
  }

  private loadOrCreateVault(): EncryptedVaultFile {
    if (!existsSync(this.filePath)) {
      const defaults = this.getDefaultVaultState();
      this.writeVaultToDisk(defaults);
      return defaults;
    }

    try {
      const rawText = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(rawText) as EncryptedVaultFile;
      if (!parsed.aiGateway || !parsed.vault) {
        throw new Error('Invalid vault schema structure');
      }
      if (typeof parsed.aiGateway.apiKeyEncrypted !== 'string') {
        parsed.aiGateway.apiKeyEncrypted = '';
      }
      if (!Array.isArray(parsed.vault.credentials)) {
        parsed.vault.credentials = [];
      }
      if (!Array.isArray(parsed.aiGateways)) {
        parsed.aiGateways = [];
        if (parsed.aiGateway.apiKeyEncrypted || parsed.aiGateway.model) {
          parsed.aiGateways.push({
            id: randomUUID(),
            name: parsed.aiGateway.model,
            provider: 'openrouter',
            baseUrl: isValidOpenRouterBaseUrl(parsed.aiGateway.baseUrl)
              ? normalizeOpenRouterBaseUrl(parsed.aiGateway.baseUrl)
              : OPENROUTER_DEFAULT_BASE_URL,
            model: parsed.aiGateway.model,
            apiKeyEncrypted: parsed.aiGateway.apiKeyEncrypted || '',
            isDefault: true,
            validationStatus: parsed.aiGateway.validationStatus || 'unverified',
            createdAt: parsed.updatedAt || Date.now(),
            updatedAt: parsed.updatedAt || Date.now()
          });
        }
      }
      return parsed;
    } catch (error) {
      const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, corruptPath);
        console.error(`[vault] Preserved unreadable vault at ${corruptPath}`);
      } catch (preserveError) {
        throw new Error(
          `Vault is unreadable and could not be preserved: ${
            preserveError instanceof Error ? preserveError.message : String(preserveError)
          }`,
          { cause: error }
        );
      }

      const defaults = this.getDefaultVaultState();
      this.writeVaultToDisk(defaults);
      return defaults;
    }
  }

  private writeVaultToDisk(state: EncryptedVaultFile): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    state.updatedAt = Date.now();
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temporaryPath, JSON.stringify(state, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    });
    try {
      chmodSync(temporaryPath, 0o600);
    } catch {
      // ignore chmod unsupported platform nuances
    }

    try {
      renameSync(temporaryPath, this.filePath);
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        // ignore chmod unsupported platform nuances
      }
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // ignore cleanup failure
      }
      throw error;
    }
  }

  private getAvailableSafeStorage(): VaultSafeStorageAdapter | null {
    if (!this.safeStorage) return null;

    try {
      if (!this.safeStorage.isEncryptionAvailable()) return null;
    } catch {
      return null;
    }

    if (typeof this.safeStorage.getSelectedStorageBackend === 'function') {
      try {
        if (this.safeStorage.getSelectedStorageBackend() === 'basic_text') return null;
      } catch {
        // Backend inspection is platform-specific; do not disable a working keychain.
      }
    }

    return this.safeStorage;
  }

  public migrateLegacySecretsToOsStorage(): VaultMigrationResult {
    let skipped = 0;
    let failed = 0;

    const inspectValue = (value: string | undefined): void => {
      if (!value) {
        skipped += 1;
        return;
      }
      if (isLegacyAesCiphertext(value)) {
        failed += 1;
        return;
      }
      skipped += 1;
    };

    inspectValue(this.state.aiGateway.apiKeyEncrypted);
    for (const gateway of this.state.aiGateways ?? []) {
      inspectValue(gateway.apiKeyEncrypted);
      if (isLegacyAesCiphertext(gateway.apiKeyEncrypted)) {
        gateway.validationStatus = 'migration_required';
      }
    }
    for (const credential of this.state.vault.credentials) {
      inspectValue(credential.encryptedValue);
    }

    if (isLegacyAesCiphertext(this.state.aiGateway.apiKeyEncrypted)) {
      this.state.aiGateway.validationStatus = 'migration_required';
    }

    this.legacyMigrationRequired = failed > 0;

    if (failed > 0) {
      return {
        migrated: 0,
        skipped,
        failed,
        migrationRequired: true,
        error: LEGACY_MIGRATION_ERROR_MESSAGE
      };
    }

    return { migrated: 0, skipped, failed: 0, migrationRequired: false };
  }

  private rebuildActiveSecretCache(): void {
    this.activeSecrets.clear();
    try {
      const safeStorage = this.getAvailableSafeStorage();
      if (!safeStorage || !this.state) return;

      const collect = (cipherText: string | undefined): void => {
        if (!cipherText || !cipherText.startsWith('ENC:OS:')) return;
        const parts = cipherText.split(':');
        if (parts.length < 3) return;
        try {
          const buffer = Buffer.from(parts[2], 'base64');
          const decrypted = safeStorage.decryptString(buffer);
          if (decrypted && decrypted.length >= 6) {
            this.activeSecrets.add(decrypted);
            if (decrypted.trim().startsWith('{')) {
              try {
                const parsed = JSON.parse(decrypted) as { password?: unknown };
                if (typeof parsed.password === 'string' && parsed.password.length >= 4) {
                  this.activeSecrets.add(parsed.password);
                }
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore undecryptable entry
        }
      };

      collect(this.state.aiGateway?.apiKeyEncrypted);
      for (const gateway of this.state.aiGateways ?? []) {
        collect(gateway?.apiKeyEncrypted);
      }
      for (const credential of this.state.vault?.credentials ?? []) {
        collect(credential?.encryptedValue);
      }
    } catch {
      // Fail safely without throwing if vault state or safeStorage is unavailable
    }
  }

  public getActiveSecretCount(): number {
    return this.activeSecrets.size;
  }

  // Cryptographic primitives (OS SafeStorage ONLY — zero static/fallback keys)
  public encrypt(plainText: string): string {
    if (!plainText) return '';

    const safeStorage = this.getAvailableSafeStorage();
    if (!safeStorage) {
      throw new Error(
        'OS keychain encryption (safeStorage) is unavailable. Refusing to store credentials without OS-level encryption.'
      );
    }

    let buffer: Buffer;
    try {
      buffer = safeStorage.encryptString(plainText);
    } catch (error) {
      throw new Error(
        `OS keychain encryption failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (plainText.length >= 6) {
      this.activeSecrets.add(plainText);
    }

    return `ENC:OS:${buffer.toString('base64')}`;
  }

  public decrypt(cipherText: string): string {
    if (!cipherText || !cipherText.startsWith('ENC:OS:')) {
      return '';
    }

    const parts = cipherText.split(':');
    if (parts.length < 3) return '';

    const safeStorage = this.getAvailableSafeStorage();
    if (!safeStorage) {
      return '';
    }

    try {
      const buffer = Buffer.from(parts[2], 'base64');
      const decrypted = safeStorage.decryptString(buffer);
      if (decrypted.length >= 6) {
        this.activeSecrets.add(decrypted);
      }
      return decrypted;
    } catch {
      return '';
    }
  }

  // Masking & Universal Redaction
  public maskSecret(secret: string): string {
    if (!secret) return '';
    if (secret.length <= 8) return '••••••••';
    const head = secret.slice(0, 4);
    const tail = secret.slice(-4);
    return `${head}••••••••${tail}`;
  }

  public redactSecrets(text: string): string {
    if (!text) return text;
    return redactSecretsWithPatterns(text, [...this.activeSecrets]);
  }

  public redactDeep(value: unknown): unknown {
    return redactDeepWithPatterns(value, [...this.activeSecrets]);
  }

  // AI Gateway Lifecycle Operations
  public listAIGateways(): AIGatewayPublic[] {
    if (!this.state.aiGateways) {
      this.state.aiGateways = [];
    }
    return this.state.aiGateways
      .filter((g) => isSupportedGatewayProvider(g.provider))
      .map((g) => {
        const isLegacy = isLegacyAesCiphertext(g.apiKeyEncrypted);
        const raw = isLegacy ? '' : this.decrypt(g.apiKeyEncrypted);
        const hasKey = Boolean(raw && raw.length > 0);
        const validationStatus: CredentialValidationStatus = isLegacy
          ? 'migration_required'
          : g.validationStatus || (hasKey ? 'unverified' : 'revoked');
        const defaultUrl =
          g.provider === 'openai' ? OPENAI_DEFAULT_BASE_URL : OPENROUTER_DEFAULT_BASE_URL;

        return {
          id: g.id,
          name: g.name || g.model,
          provider: g.provider,
          baseUrl: isAllowedGatewayUrlForProvider(g.provider, g.baseUrl)
            ? normalizeOpenRouterBaseUrl(g.baseUrl, g.provider)
            : defaultUrl,
          model: g.model,
          maskedKey: hasKey ? this.maskSecret(raw) : '',
          hasKey,
          isDefault: Boolean(g.isDefault),
          updatedAt: g.updatedAt ?? g.createdAt ?? null,
          validationStatus,
          createdAt: g.createdAt
        };
      });
  }

  public getOpenRouterCredentialStatus(id?: string): OpenRouterCredentialStatus {
    const status = this.getAIGateway(id);
    return {
      ...status,
      provider: 'openrouter',
      updatedAt: status.updatedAt ?? null,
      validationStatus: status.validationStatus ?? 'unverified'
    };
  }

  public getAIGateway(id?: string): AIGatewayStatus {
    const gateways = this.state.aiGateways ?? [];
    const target = id
      ? gateways.find((g) => g.id === id && isSupportedGatewayProvider(g.provider))
      : gateways.find((g) => g.isDefault && isSupportedGatewayProvider(g.provider)) ||
        gateways.find((g) => isSupportedGatewayProvider(g.provider));

    if (target) {
      const isLegacy = isLegacyAesCiphertext(target.apiKeyEncrypted);
      const rawKey = isLegacy ? '' : this.decrypt(target.apiKeyEncrypted);
      const hasKey = Boolean(rawKey && rawKey.length > 0);
      const validationStatus: CredentialValidationStatus = isLegacy
        ? 'migration_required'
        : target.validationStatus || (hasKey ? 'unverified' : 'unverified');
      const defaultUrl =
        target.provider === 'openai' ? OPENAI_DEFAULT_BASE_URL : OPENROUTER_DEFAULT_BASE_URL;

      return {
        provider: target.provider,
        baseUrl: isAllowedGatewayUrlForProvider(target.provider, target.baseUrl)
          ? normalizeOpenRouterBaseUrl(target.baseUrl, target.provider)
          : defaultUrl,
        model: target.model || OPENROUTER_DEFAULT_MODEL,
        maskedKey: hasKey ? this.maskSecret(rawKey) : '',
        hasKey,
        updatedAt: target.updatedAt ?? target.createdAt ?? null,
        validationStatus,
        ...(isLegacy || this.legacyMigrationRequired
          ? { migrationError: LEGACY_MIGRATION_ERROR_MESSAGE }
          : {})
      };
    }

    const isLegacy = isLegacyAesCiphertext(this.state.aiGateway.apiKeyEncrypted);
    const rawKey = isLegacy ? '' : this.decrypt(this.state.aiGateway.apiKeyEncrypted);
    const hasKey = Boolean(rawKey && rawKey.length > 0);
    const validationStatus: CredentialValidationStatus = isLegacy
      ? 'migration_required'
      : this.state.aiGateway.validationStatus || 'unverified';
    const legacyProvider = this.state.aiGateway.provider || 'openrouter';
    const legacyDefaultUrl =
      legacyProvider === 'openai' ? OPENAI_DEFAULT_BASE_URL : OPENROUTER_DEFAULT_BASE_URL;

    return {
      provider: legacyProvider,
      baseUrl: isAllowedGatewayUrlForProvider(legacyProvider, this.state.aiGateway.baseUrl)
        ? normalizeOpenRouterBaseUrl(this.state.aiGateway.baseUrl, legacyProvider)
        : legacyDefaultUrl,
      model: this.state.aiGateway.model || OPENROUTER_DEFAULT_MODEL,
      maskedKey: hasKey ? this.maskSecret(rawKey) : '',
      hasKey,
      updatedAt: this.state.aiGateway.updatedAt ?? null,
      validationStatus,
      ...(isLegacy || this.legacyMigrationRequired
        ? { migrationError: LEGACY_MIGRATION_ERROR_MESSAGE }
        : {})
    };
  }

  public getDecryptedAIGatewayKey(): string | null {
    const defaultGateway =
      this.state.aiGateways?.find((g) => g.isDefault && isSupportedGatewayProvider(g.provider)) ||
      this.state.aiGateways?.find((g) => isSupportedGatewayProvider(g.provider));
    if (defaultGateway) {
      if (
        !isSupportedGatewayProvider(defaultGateway.provider) ||
        !isAllowedGatewayUrlForProvider(defaultGateway.provider, defaultGateway.baseUrl)
      ) {
        return null;
      }
      const raw = this.decrypt(defaultGateway.apiKeyEncrypted);
      return raw || null;
    }
    if (
      !isSupportedGatewayProvider(this.state.aiGateway.provider) ||
      !isAllowedGatewayUrlForProvider(this.state.aiGateway.provider, this.state.aiGateway.baseUrl)
    ) {
      return null;
    }
    const raw = this.decrypt(this.state.aiGateway.apiKeyEncrypted);
    return raw || null;
  }

  public getDecryptedGatewayKey(idOrModel?: string): string | null {
    if (idOrModel && this.state.aiGateways) {
      const match = this.state.aiGateways.find(
        (g) =>
          (g.provider === 'openrouter' ||
            (isCustomGatewayAllowed() && g.provider === 'custom')) &&
          (isValidOpenRouterBaseUrl(g.baseUrl) ||
            (isCustomGatewayAllowed() && isValidAIGatewayUrl(g.baseUrl))) &&
          (g.id === idOrModel || g.model.toLowerCase() === idOrModel.toLowerCase())
      );
      if (match) {
        return this.decrypt(match.apiKeyEncrypted) || null;
      }
    }
    return this.getDecryptedAIGatewayKey();
  }

  public setOpenRouterKey(config: {
    rawApiKey: string;
    model?: string;
    baseUrl?: string;
    name?: string;
  }): { success: boolean; id?: string; status?: OpenRouterCredentialStatus; error?: string } {
    const rawApiKey = config.rawApiKey?.trim();
    if (!rawApiKey) {
      return { success: false, error: 'OpenRouter API key cannot be empty.' };
    }

    const baseUrl = config.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL;
    const model =
      config.model?.trim() ||
      this.state.aiGateway.model ||
      OPENROUTER_DEFAULT_MODEL;

    const saveResult = this.saveAIGateway({
      name: config.name?.trim() || model,
      provider: 'openrouter',
      baseUrl,
      model,
      rawApiKey,
      isDefault: true
    });

    if (!saveResult.success) {
      return {
        success: false,
        error: this.redactSecrets(saveResult.error || 'Failed to save OpenRouter API key.')
      };
    }

    return {
      success: true,
      id: saveResult.id,
      status: this.getOpenRouterCredentialStatus(saveResult.id)
    };
  }

  public updateOpenRouterKey(config: {
    id?: string;
    rawApiKey?: string;
    model?: string;
    baseUrl?: string;
    name?: string;
  }): { success: boolean; id?: string; status?: OpenRouterCredentialStatus; error?: string } {
    const gateways = this.state.aiGateways ?? [];
    const target = config.id
      ? gateways.find((g) => g.id === config.id)
      : gateways.find((g) => g.isDefault) || gateways[0];

    const baseUrl =
      config.baseUrl?.trim() || target?.baseUrl || this.state.aiGateway.baseUrl || OPENROUTER_DEFAULT_BASE_URL;
    const model =
      config.model?.trim() || target?.model || this.state.aiGateway.model || OPENROUTER_DEFAULT_MODEL;

    const saveResult = this.saveAIGateway({
      id: target?.id,
      name: config.name?.trim() || target?.name || model,
      provider: 'openrouter',
      baseUrl,
      model,
      rawApiKey: config.rawApiKey,
      isDefault: target ? target.isDefault : true
    });

    if (!saveResult.success) {
      return {
        success: false,
        error: this.redactSecrets(saveResult.error || 'Failed to update OpenRouter credential.')
      };
    }

    return {
      success: true,
      id: saveResult.id,
      status: this.getOpenRouterCredentialStatus(saveResult.id)
    };
  }

  public revokeOpenRouterKey(id?: string): {
    success: boolean;
    status: OpenRouterCredentialStatus;
    error?: string;
  } {
    try {
      const now = Date.now();
      if (!this.state.aiGateways) {
        this.state.aiGateways = [];
      }

      if (id) {
        const target = this.state.aiGateways.find((g) => g.id === id);
        if (target) {
          target.apiKeyEncrypted = '';
          target.validationStatus = 'revoked';
          target.updatedAt = now;
        }
      } else {
        for (const gateway of this.state.aiGateways) {
          gateway.apiKeyEncrypted = '';
          gateway.validationStatus = 'revoked';
          gateway.updatedAt = now;
        }
        this.state.aiGateway.apiKeyEncrypted = '';
        this.state.aiGateway.validationStatus = 'revoked';
        this.state.aiGateway.updatedAt = now;
      }

      const activeGateway =
        this.state.aiGateways.find((g) => g.isDefault) || this.state.aiGateways[0];
      if (activeGateway) {
        this.state.aiGateway.provider = 'openrouter';
        this.state.aiGateway.baseUrl = activeGateway.baseUrl;
        this.state.aiGateway.model = activeGateway.model;
        this.state.aiGateway.apiKeyEncrypted = activeGateway.apiKeyEncrypted;
        this.state.aiGateway.validationStatus = activeGateway.validationStatus;
        this.state.aiGateway.updatedAt = activeGateway.updatedAt;
      }

      this.legacyMigrationRequired = false;
      this.writeVaultToDisk(this.state);
      this.rebuildActiveSecretCache();

      return {
        success: true,
        status: this.getOpenRouterCredentialStatus(id)
      };
    } catch (error) {
      return {
        success: false,
        status: this.getOpenRouterCredentialStatus(id),
        error: this.redactSecrets(error instanceof Error ? error.message : String(error))
      };
    }
  }

  public recordValidationStatus(
    validationStatus: CredentialValidationStatus,
    id?: string
  ): OpenRouterCredentialStatus {
    const now = Date.now();
    const gateways = this.state.aiGateways ?? [];
    const target = id
      ? gateways.find((g) => g.id === id)
      : gateways.find((g) => g.isDefault) || gateways[0];

    if (target) {
      target.validationStatus = validationStatus;
      target.updatedAt = now;
    }

    this.state.aiGateway.validationStatus = validationStatus;
    this.state.aiGateway.updatedAt = now;
    this.writeVaultToDisk(this.state);
    return this.getOpenRouterCredentialStatus(target?.id);
  }

  public saveAIGateway(config: {
    id?: string;
    name?: string;
    provider: AIGatewayProvider;
    baseUrl: string;
    model: string;
    rawApiKey?: string;
    isDefault?: boolean;
  }): { success: boolean; id?: string; error?: string } {
    try {
      const isSupportedProvider = isSupportedGatewayProvider(config.provider);

      if (!isSupportedProvider) {
        return {
          success: false,
          error: 'Unsupported AI provider.'
        };
      }

      const isAllowedUrl = isAllowedGatewayUrlForProvider(config.provider, config.baseUrl);

      if (!isAllowedUrl) {
        return {
          success: false,
          error:
            config.provider === 'openai'
              ? 'Invalid OpenAI base URL. Must use HTTPS and api.openai.com.'
              : 'Invalid OpenRouter base URL. Must use HTTPS and an official openrouter.ai host.'
        };
      }

      const normalizedBaseUrl = normalizeOpenRouterBaseUrl(config.baseUrl, config.provider);
      const trimmedModel = config.model?.trim();
      if (!trimmedModel) {
        return {
          success: false,
          error: 'Model name cannot be empty.'
        };
      }

      if (!this.state.aiGateways) {
        this.state.aiGateways = [];
      }

      const existingIndex = config.id
        ? this.state.aiGateways.findIndex((g) => g.id === config.id)
        : this.state.aiGateways.findIndex(
            (g) =>
              g.provider === config.provider &&
              g.model.trim().toLowerCase() === trimmedModel.toLowerCase()
          );

      const isFirst = this.state.aiGateways.length === 0;
      const shouldBeDefault =
        config.isDefault !== undefined ? config.isDefault : isFirst || existingIndex === 0;

      const now = Date.now();
      let gatewayId: string;

      if (existingIndex >= 0) {
        const existing = this.state.aiGateways[existingIndex];
        gatewayId = existing.id;
        existing.name = config.name?.trim() || trimmedModel;
        existing.provider = config.provider;
        existing.baseUrl = normalizedBaseUrl;
        existing.model = trimmedModel;
        existing.updatedAt = now;
        if (config.rawApiKey !== undefined && config.rawApiKey.trim() !== '') {
          existing.apiKeyEncrypted = this.encrypt(config.rawApiKey.trim());
          existing.validationStatus = 'unverified';
        }
        if (shouldBeDefault) {
          this.state.aiGateways.forEach((g) => {
            g.isDefault = g.id === existing.id;
          });
        }
      } else {
        gatewayId = config.id || randomUUID();
        const encryptedKey =
          config.rawApiKey && config.rawApiKey.trim() !== ''
            ? this.encrypt(config.rawApiKey.trim())
            : '';
        const newEntry: AIGatewayEntry = {
          id: gatewayId,
          name: config.name?.trim() || trimmedModel,
          provider: config.provider,
          baseUrl: normalizedBaseUrl,
          model: trimmedModel,
          apiKeyEncrypted: encryptedKey,
          isDefault: shouldBeDefault,
          validationStatus: encryptedKey ? 'unverified' : 'unverified',
          createdAt: now,
          updatedAt: now
        };
        if (shouldBeDefault) {
          this.state.aiGateways.forEach((g) => {
            g.isDefault = false;
          });
        }
        this.state.aiGateways.push(newEntry);
      }

      const activeGateway =
        this.state.aiGateways.find((g) => g.isDefault) || this.state.aiGateways[0];
      if (activeGateway) {
        this.state.aiGateway.provider = activeGateway.provider;
        this.state.aiGateway.baseUrl = activeGateway.baseUrl;
        this.state.aiGateway.model = activeGateway.model;
        this.state.aiGateway.apiKeyEncrypted = activeGateway.apiKeyEncrypted;
        this.state.aiGateway.updatedAt = activeGateway.updatedAt;
        this.state.aiGateway.validationStatus = activeGateway.validationStatus;
      }

      this.legacyMigrationRequired = false;
      this.writeVaultToDisk(this.state);
      this.rebuildActiveSecretCache();
      return { success: true, id: gatewayId };
    } catch (err: unknown) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const known = config.rawApiKey ? [config.rawApiKey.trim(), ...this.activeSecrets] : [...this.activeSecrets];
      return {
        success: false,
        error: redactSecretsWithPatterns(rawMessage, known)
      };
    }
  }

  public deleteAIGateway(id: string): { success: boolean; error?: string } {
    try {
      if (!this.state.aiGateways) return { success: true };
      const target = this.state.aiGateways.find((g) => g.id === id);
      const wasDefault = target?.isDefault;

      this.state.aiGateways = this.state.aiGateways.filter((g) => g.id !== id);

      if (wasDefault && this.state.aiGateways.length > 0) {
        this.state.aiGateways[0].isDefault = true;
      }

      const activeGateway =
        this.state.aiGateways.find((g) => g.isDefault) || this.state.aiGateways[0];
      if (activeGateway) {
        this.state.aiGateway.provider = 'openrouter';
        this.state.aiGateway.baseUrl = activeGateway.baseUrl;
        this.state.aiGateway.model = activeGateway.model;
        this.state.aiGateway.apiKeyEncrypted = activeGateway.apiKeyEncrypted;
        this.state.aiGateway.updatedAt = activeGateway.updatedAt;
        this.state.aiGateway.validationStatus = activeGateway.validationStatus;
      } else {
        this.state.aiGateway.apiKeyEncrypted = '';
        this.state.aiGateway.validationStatus = 'revoked';
        this.state.aiGateway.updatedAt = Date.now();
      }

      this.writeVaultToDisk(this.state);
      this.rebuildActiveSecretCache();
      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: this.redactSecrets(err instanceof Error ? err.message : String(err))
      };
    }
  }

  public setDefaultAIGateway(id: string): { success: boolean; error?: string } {
    try {
      if (!this.state.aiGateways) return { success: false, error: 'No gateways found' };
      let found = false;
      this.state.aiGateways.forEach((g) => {
        if (g.id === id) {
          g.isDefault = true;
          found = true;
        } else {
          g.isDefault = false;
        }
      });

      if (!found) {
        return { success: false, error: 'Gateway ID not found' };
      }

      const activeGateway = this.state.aiGateways.find((g) => g.id === id);
      if (activeGateway) {
        this.state.aiGateway.provider = 'openrouter';
        this.state.aiGateway.baseUrl = activeGateway.baseUrl;
        this.state.aiGateway.model = activeGateway.model;
        this.state.aiGateway.apiKeyEncrypted = activeGateway.apiKeyEncrypted;
        this.state.aiGateway.updatedAt = activeGateway.updatedAt;
        this.state.aiGateway.validationStatus = activeGateway.validationStatus;
      }

      this.writeVaultToDisk(this.state);
      return { success: true };
    } catch (err: unknown) {
      return {
        success: false,
        error: this.redactSecrets(err instanceof Error ? err.message : String(err))
      };
    }
  }

  // Vault Operational Credentials Operations
  public listCredentials(): VaultCredentialPublic[] {
    return this.state.vault.credentials.map((c) => {
      const raw = this.decrypt(c.encryptedValue);
      let username: string | undefined;
      let maskedValue = this.maskSecret(raw);
      if (raw && raw.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(raw) as { username?: unknown; user?: unknown; email?: unknown; password?: unknown };
          const u = parsed.username ?? parsed.user ?? parsed.email;
          if (typeof u === 'string' && u.trim()) {
            username = u.trim();
          }
          if (typeof parsed.password === 'string' && parsed.password) {
            maskedValue = '••••••••';
          }
        } catch {
          // Not JSON
        }
      }
      return {
        id: c.id,
        name: c.name,
        category: c.category,
        serviceDomain: c.serviceDomain,
        ...(username ? { username } : {}),
        maskedValue,
        notes: c.notes,
        createdAt: c.createdAt
      };
    });
  }

  public saveCredential(data: {
    name: string;
    category: VaultCredentialCategory;
    serviceDomain?: string;
    rawValue: string;
    notes?: string;
  }): { success: boolean; id: string } {
    const newId = randomUUID();
    const entry: VaultCredentialEntry = {
      id: newId,
      name: data.name.trim(),
      category: data.category,
      serviceDomain: data.serviceDomain?.trim() || undefined,
      encryptedValue: this.encrypt(data.rawValue.trim()),
      notes: data.notes?.trim() || undefined,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.state.vault.credentials.push(entry);
    this.writeVaultToDisk(this.state);
    this.rebuildActiveSecretCache();
    return { success: true, id: newId };
  }

  public deleteCredential(id: string): { success: boolean } {
    const initialLen = this.state.vault.credentials.length;
    this.state.vault.credentials = this.state.vault.credentials.filter((c) => c.id !== id);
    if (this.state.vault.credentials.length !== initialLen) {
      this.writeVaultToDisk(this.state);
      this.rebuildActiveSecretCache();
    }
    return { success: true };
  }

  public getDecryptedCredentialValue(id: string): string | null {
    const found = this.state.vault.credentials.find((c) => c.id === id);
    if (!found) return null;
    return this.decrypt(found.encryptedValue) || null;
  }

  /**
   * Finds a site login credential (username + password) matching `domainOrUrl`.
   * Supports either a single JSON/colon/newline credential (`{"username":...,"password":...}` or `user:pass`)
   * or a pair of credentials sharing the same `serviceDomain` (one for username/email, one for password).
   */
  public findSiteLoginCredential(domainOrUrl: string): {
    id: string;
    name: string;
    serviceDomain: string;
    username: string;
    password: string;
  } | null {
    const rawTarget = (domainOrUrl || '').trim().toLowerCase();
    if (!rawTarget) return null;
    let targetHost = rawTarget;
    if (rawTarget.includes('://')) {
      try {
        targetHost = new URL(rawTarget).hostname.toLowerCase();
      } catch {
        targetHost = rawTarget;
      }
    }
    targetHost = targetHost.replace(/^www\./, '').split('/')[0];
    if (!targetHost) return null;

    const domainMatches = (serviceDomain?: string): boolean => {
      if (!serviceDomain) return false;
      let clean = serviceDomain.trim().toLowerCase();
      if (clean.includes('://')) {
        try {
          clean = new URL(clean).hostname.toLowerCase();
        } catch {
          // keep as-is
        }
      }
      clean = clean.replace(/^www\./, '').split('/')[0];
      if (!clean) return false;
      return targetHost === clean || targetHost.endsWith(`.${clean}`) || clean.endsWith(`.${targetHost}`);
    };

    const matching = this.state.vault.credentials.filter(
      (c) => domainMatches(c.serviceDomain) || c.name.trim().toLowerCase() === rawTarget
    );
    if (matching.length === 0) return null;

    // 1. Check for combined single entry (JSON, newline, or user:pass)
    for (const entry of matching) {
      const val = this.decrypt(entry.encryptedValue).trim();
      if (!val) continue;
      if (val.startsWith('{')) {
        try {
          const parsed = JSON.parse(val) as { username?: unknown; user?: unknown; email?: unknown; password?: unknown; pass?: unknown };
          const u = parsed.username ?? parsed.user ?? parsed.email;
          const p = parsed.password ?? parsed.pass;
          if (typeof u === 'string' && typeof p === 'string' && u.trim() && p.trim()) {
            return {
              id: entry.id,
              name: entry.name,
              serviceDomain: entry.serviceDomain || targetHost,
              username: u.trim(),
              password: p
            };
          }
        } catch {
          // ignore invalid JSON
        }
      }
      const lines = val.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 2 && lines[0] && lines[1]) {
        return {
          id: entry.id,
          name: entry.name,
          serviceDomain: entry.serviceDomain || targetHost,
          username: lines[0],
          password: lines[1]
        };
      }
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0 && colonIdx < val.length - 1 && !val.includes('://')) {
        return {
          id: entry.id,
          name: entry.name,
          serviceDomain: entry.serviceDomain || targetHost,
          username: val.slice(0, colonIdx).trim(),
          password: val.slice(colonIdx + 1)
        };
      }
    }

    // 2. Check for pair of separate username + password entries for the same domain
    const userEntry = matching.find((c) => /user|email|login|account|akun/i.test(`${c.name} ${c.notes || ''}`));
    const passEntry = matching.find((c) => /pass|pwd|sandi/i.test(`${c.name} ${c.notes || ''}`));
    if (userEntry && passEntry && userEntry.id !== passEntry.id) {
      const username = this.decrypt(userEntry.encryptedValue).trim();
      const password = this.decrypt(passEntry.encryptedValue);
      if (username && password) {
        return {
          id: passEntry.id,
          name: `${userEntry.name} / ${passEntry.name}`,
          serviceDomain: passEntry.serviceDomain || targetHost,
          username,
          password
        };
      }
    }

    return null;
  }
}
