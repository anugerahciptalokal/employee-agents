import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { VaultSafeStorageAdapter } from '../core/vault/vault-manager';
import { getDataLayoutPaths, migrateLegacyDataLayout } from '../core/data-root';

export interface NodeSafeStorageOptions {
  secretKey?: string;
  keyFilePath?: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class NodeSafeStorageAdapter implements VaultSafeStorageAdapter {
  private key: Buffer;

  constructor(options: NodeSafeStorageOptions = {}) {
    this.key = this.resolveKey(options);
  }

  private resolveKey(options: NodeSafeStorageOptions): Buffer {
    if (options.secretKey && options.secretKey.trim()) {
      return crypto.createHash('sha256').update(options.secretKey.trim()).digest();
    }

    if (process.env.OPEN_EMPLOYEE_VAULT_KEY && process.env.OPEN_EMPLOYEE_VAULT_KEY.trim()) {
      return crypto
        .createHash('sha256')
        .update(process.env.OPEN_EMPLOYEE_VAULT_KEY.trim())
        .digest();
    }

    if (!options.keyFilePath) {
      migrateLegacyDataLayout();
    }

    const keyPath = options.keyFilePath || getDataLayoutPaths().vaultKeyPath;

    try {
      const dir = path.dirname(keyPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(keyPath)) {
        const raw = fs.readFileSync(keyPath, 'utf-8').trim();
        if (raw) {
          return crypto.createHash('sha256').update(raw).digest();
        }
      }

      const generatedSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyPath, generatedSecret, { encoding: 'utf-8', mode: 0o600 });
      return crypto.createHash('sha256').update(generatedSecret).digest();
    } catch {
      // In case disk is read-only or error occurs, fallback to a stable process-lifetime key
      const fallback = crypto.randomBytes(32);
      return fallback;
    }
  }

  public isEncryptionAvailable(): boolean {
    return true;
  }

  public getSelectedStorageBackend(): string {
    return 'node_aes_256_gcm';
  }

  public encryptString(plainText: string): Buffer {
    if (typeof plainText !== 'string') {
      throw new Error('plainText must be a string');
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Packed format: [12 bytes IV] + [16 bytes Auth Tag] + [Encrypted Content]
    return Buffer.concat([iv, tag, encrypted]);
  }

  public decryptString(encrypted: Buffer): string {
    if (!Buffer.isBuffer(encrypted) || encrypted.length < IV_LENGTH + TAG_LENGTH) {
      throw new Error('Invalid encrypted payload for NodeSafeStorageAdapter');
    }

    const iv = encrypted.subarray(0, IV_LENGTH);
    const tag = encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = encrypted.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }
}

