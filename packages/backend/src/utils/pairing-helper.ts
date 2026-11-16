import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataLayoutPaths, migrateLegacyDataLayout } from '../core/data-root';

import type { PairingPayload } from '@open-employee/contracts/pairing';
export type { PairingPayload };

const TOKEN_PREFIX = 'oepair1';
let cachedSigningSecret: Buffer | null = null;

function loadSigningSecret(): Buffer {
  const fromEnv = process.env.OPEN_EMPLOYEE_PAIRING_SECRET?.trim();
  if (fromEnv) return Buffer.from(fromEnv, 'utf8');

  migrateLegacyDataLayout();
  const secretPath = getDataLayoutPaths().pairingSecretPath;
  const secretsDir = path.dirname(secretPath);

  try {
    const existing = fs.readFileSync(secretPath);
    if (existing.length >= 32) return existing;
  } catch {
    // Secret does not exist yet.
  }

  const generated = crypto.randomBytes(32);
  try {
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(secretPath, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch {
    try {
      const existing = fs.readFileSync(secretPath);
      if (existing.length >= 32) return existing;
    } catch {
      // Fall back to the in-memory secret for this process.
    }
    return generated;
  }
}

function getSigningSecret(): Buffer {
  if (!cachedSigningSecret) {
    cachedSigningSecret = loadSigningSecret();
  }
  return cachedSigningSecret;
}

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
}

export function createSignedPairingToken(expiresAt: number, nonce?: string): string {
  const randomPart = nonce || crypto.randomBytes(9).toString('base64url');
  const payload = `${TOKEN_PREFIX}.${expiresAt}.${randomPart}`;
  return `${payload}.${signPayload(payload)}`;
}

export function verifySignedPairingToken(
  token: string,
  now: number = Date.now()
): { valid: boolean; expiresAt?: number; reason?: 'malformed' | 'bad_signature' | 'expired' } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'malformed' };
  }

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_PREFIX) {
    return { valid: false, reason: 'malformed' };
  }

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt)) {
    return { valid: false, reason: 'malformed' };
  }

  const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const expected = Buffer.from(signPayload(payload), 'utf8');
  const actual = Buffer.from(parts[3], 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { valid: false, reason: 'bad_signature' };
  }

  if (now > expiresAt) {
    return { valid: false, reason: 'expired', expiresAt };
  }

  return { valid: true, expiresAt };
}

export function generatePairingPin(): string {
  const digits = Math.floor(100000 + Math.random() * 900000).toString();
  return `OE-${digits.slice(-4)}`;
}

/**
 * Normalizes a manually typed pairing code. Accepts `OE-1234`, `oe1234`,
 * `1234`, surrounding whitespace, and typographic dashes.
 */
export function normalizePairingPin(raw?: string | null): string {
  const cleaned = (raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s+/g, '');

  if (/^\d{4}$/.test(cleaned)) {
    return `OE-${cleaned}`;
  }
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length === 4 && /^OE-?\d{4}$/.test(cleaned)) {
    return `OE-${digits}`;
  }
  return cleaned;
}

export function isValidPairingPinShape(pin: string): boolean {
  return /^OE-\d{4}$/.test(pin);
}

export function isDockerOrVirtualIp(address: string, ifaceName = ''): boolean {
  const lowerName = ifaceName.toLowerCase();
  if (
    lowerName.startsWith('docker') ||
    lowerName.startsWith('br-') ||
    lowerName.startsWith('veth') ||
    lowerName.startsWith('vmenet') ||
    lowerName.startsWith('bridge')
  ) {
    return true;
  }
  const parts = address.split('.').map(Number);
  // Docker default bridge ranges: 172.16.0.0 – 172.31.255.255
  if (parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  // Android emulator (10.0.2.x) and link-local (169.254.x.x)
  if (address.startsWith('10.0.2.') || address.startsWith('169.254.')) {
    return true;
  }
  return false;
}

export function detectLocalNetworkHost(
  networkInterfaces?: Record<string, Array<{ address: string; family: string; internal: boolean }>>
): string {
  if (!networkInterfaces) {
    return '127.0.0.1';
  }

  let fallbackVirtualIp: string | null = null;

  // Iterate over network interfaces and pick the first non-internal, non-virtual IPv4 address
  for (const name of Object.keys(networkInterfaces)) {
    const addresses = networkInterfaces[name];
    if (Array.isArray(addresses)) {
      for (const net of addresses) {
        // Skip internal (i.e. 127.0.0.1) and non-IPv4
        if (!net.internal && (net.family === 'IPv4' || (net.family as unknown) === 4)) {
          if (isDockerOrVirtualIp(net.address, name)) {
            if (!fallbackVirtualIp) fallbackVirtualIp = net.address;
          } else {
            return net.address;
          }
        }
      }
    }
  }

  return fallbackVirtualIp || '127.0.0.1';
}

export function createPairingPayload(
  serverUrl: string,
  token: string,
  workspaceName = 'Employee Agents HQ',
  expiresInSeconds = 600,
  pinCode?: string
): PairingPayload {
  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    token,
    workspaceName,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    pinCode
  };
}

export function verifyPairingPayload(payloadStr: string): PairingPayload | null {
  try {
    if (!payloadStr || typeof payloadStr !== 'string') return null;
    const parsed = JSON.parse(payloadStr.trim()) as PairingPayload;

    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.serverUrl || typeof parsed.serverUrl !== 'string') return null;
    if (!parsed.token || typeof parsed.token !== 'string') return null;
    if (!parsed.serverUrl.startsWith('http://') && !parsed.serverUrl.startsWith('https://')) return null;

    if (parsed.expiresAt && typeof parsed.expiresAt === 'number') {
      if (Date.now() > parsed.expiresAt) {
        return null; // Expired
      }
    }

    return parsed;
  } catch {
    return null;
  }
}

