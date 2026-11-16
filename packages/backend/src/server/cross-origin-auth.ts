import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { AuthIdentity, AuthTokenPair, WsTicketResponse } from '@open-employee/contracts/auth';

const ACCESS_TTL_SECONDS = 15 * 60; // 15 minutes
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const WS_TICKET_TTL_MS = 30 * 1000; // 30 seconds
const LOCAL_ISSUER = 'open-employee-oss';

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  if (!raw) return origins;
  for (const part of raw.split(',')) {
    const trimmed = part.trim().replace(/\/+$/, '');
    if (trimmed) {
      origins.add(trimmed);
    }
  }
  return origins;
}

export function resolveCorsHeaders(
  requestOrigin: string | undefined,
  allowedOrigins: Set<string>
): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Device-Id, X-Api-Token',
    Vary: 'Origin'
  };

  if (!requestOrigin) {
    return baseHeaders;
  }

  const normalized = requestOrigin.trim().replace(/\/+$/, '');
  if (allowedOrigins.has(normalized)) {
    return {
      ...baseHeaders,
      'Access-Control-Allow-Origin': normalized
    };
  }

  return baseHeaders;
}

interface RefreshRecord {
  familyId: string;
  userId: string;
  expiresAt: number;
  used: boolean;
}

interface WsTicketRecord {
  identity: AuthIdentity;
  expiresAt: number;
}

export interface SingleOwnerAuthOptions {
  secretPath: string;
  passwordHashPath?: string;
}

export class SingleOwnerAuthManager {
  private readonly secret: Buffer;
  private readonly passwordHashPath: string;
  private ownerPasswordHash: string | null = null;
  private readonly refreshStore = new Map<string, RefreshRecord>();
  private readonly revokedFamilies = new Set<string>();
  private readonly wsTickets = new Map<string, WsTicketRecord>();
  private readonly ownerIdentity: AuthIdentity = {
    userId: 'owner-local',
    role: 'owner',
    workspaceId: 'default',
    issuer: LOCAL_ISSUER
  };

  constructor(options: SingleOwnerAuthOptions) {
    this.secret = this.loadOrCreateSecret(options.secretPath);
    this.passwordHashPath =
      options.passwordHashPath || path.join(path.dirname(options.secretPath), '.owner-auth.json');
    this.ownerPasswordHash = this.loadOwnerPasswordHash();
  }

  private loadOrCreateSecret(secretPath: string): Buffer {
    try {
      const existing = fs.readFileSync(secretPath);
      if (existing.length >= 32) return existing;
    } catch {
      // Secret does not exist yet
    }

    const generated = crypto.randomBytes(32);
    try {
      fs.mkdirSync(path.dirname(secretPath), { recursive: true });
      fs.writeFileSync(secretPath, generated, { mode: 0o600 });
    } catch {
      // Fallback to in-memory secret if filesystem is read-only
    }
    return generated;
  }

  private loadOwnerPasswordHash(): string | null {
    try {
      const raw = fs.readFileSync(this.passwordHashPath, 'utf8');
      const parsed = JSON.parse(raw) as { passwordHash?: string };
      return typeof parsed.passwordHash === 'string' && parsed.passwordHash ? parsed.passwordHash : null;
    } catch {
      return null;
    }
  }

  private saveOwnerPasswordHash(passwordHash: string): void {
    fs.mkdirSync(path.dirname(this.passwordHashPath), { recursive: true });
    fs.writeFileSync(this.passwordHashPath, JSON.stringify({ passwordHash }), { mode: 0o600 });
    this.ownerPasswordHash = passwordHash;
  }

  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derived}`;
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, expectedHex] = storedHash.split(':');
    if (!salt || !expectedHex) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }

  private signHmacToken(payload: Record<string, unknown>): string {
    const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64UrlEncode(JSON.stringify(payload));
    const data = `${header}.${body}`;
    const sig = crypto.createHmac('sha256', this.secret).update(data).digest('base64url');
    return `${data}.${sig}`;
  }

  private verifyHmacToken(token: string): Record<string, unknown> | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const data = `${parts[0]}.${parts[1]}`;
    const expectedSig = crypto.createHmac('sha256', this.secret).update(data).digest('base64url');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');
    const actualBuf = Buffer.from(parts[2], 'utf8');
    if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
      return null;
    }
    try {
      const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
      const exp = Number(payload.exp || 0);
      if (!Number.isFinite(exp) || Date.now() / 1000 >= exp) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  private issueTokenPair(familyId?: string): AuthTokenPair {
    const nowSec = Math.floor(Date.now() / 1000);
    const activeFamily = familyId || crypto.randomUUID();
    const accessToken = this.signHmacToken({
      sub: this.ownerIdentity.userId,
      role: this.ownerIdentity.role,
      workspaceId: this.ownerIdentity.workspaceId,
      iss: LOCAL_ISSUER,
      type: 'access',
      iat: nowSec,
      exp: nowSec + ACCESS_TTL_SECONDS
    });

    const jti = crypto.randomUUID();
    const refreshToken = this.signHmacToken({
      sub: this.ownerIdentity.userId,
      jti,
      familyId: activeFamily,
      type: 'refresh',
      iat: nowSec,
      exp: nowSec + REFRESH_TTL_SECONDS
    });

    this.refreshStore.set(jti, {
      familyId: activeFamily,
      userId: this.ownerIdentity.userId,
      expiresAt: (nowSec + REFRESH_TTL_SECONDS) * 1000,
      used: false
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: this.ownerIdentity
    };
  }

  public isOwnerConfigured(): boolean {
    return this.ownerPasswordHash !== null;
  }

  public setupOwner(password: string): AuthTokenPair {
    if (this.isOwnerConfigured()) {
      throw new Error('Owner account is already configured.');
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    this.saveOwnerPasswordHash(this.hashPassword(password));
    return this.issueTokenPair();
  }

  public loginWithPassword(password: string): AuthTokenPair {
    if (!this.ownerPasswordHash) {
      throw new Error('Owner account has not been configured yet.');
    }
    if (!this.verifyPassword(password, this.ownerPasswordHash)) {
      throw new Error('Invalid password.');
    }
    return this.issueTokenPair();
  }

  public refreshAccessToken(refreshToken: string): AuthTokenPair {
    const payload = this.verifyHmacToken(refreshToken);
    if (!payload || payload.type !== 'refresh' || typeof payload.jti !== 'string' || typeof payload.familyId !== 'string') {
      throw new Error('Invalid or expired refresh token.');
    }

    if (this.revokedFamilies.has(payload.familyId)) {
      throw new Error('Refresh token family has been revoked.');
    }

    const record = this.refreshStore.get(payload.jti);
    if (!record || record.used || Date.now() > record.expiresAt) {
      // Replay detected: revoke the entire token family immediately
      this.revokedFamilies.add(payload.familyId);
      throw new Error('Refresh token replay detected; session revoked.');
    }

    record.used = true;
    return this.issueTokenPair(record.familyId);
  }

  public logout(refreshToken: string): void {
    const payload = this.verifyHmacToken(refreshToken);
    if (payload && typeof payload.familyId === 'string') {
      this.revokedFamilies.add(payload.familyId);
    }
  }

  public verifyAccessToken(accessToken: string): AuthIdentity | null {
    const payload = this.verifyHmacToken(accessToken);
    if (!payload || payload.type !== 'access' || typeof payload.sub !== 'string') {
      return null;
    }
    return {
      userId: payload.sub,
      role: payload.role === 'admin' || payload.role === 'member' ? payload.role : 'owner',
      workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : 'default',
      issuer: typeof payload.iss === 'string' ? payload.iss : LOCAL_ISSUER
    };
  }

  public issueWsTicket(identity: AuthIdentity): WsTicketResponse {
    const now = Date.now();
    for (const [k, v] of this.wsTickets.entries()) {
      if (now > v.expiresAt) this.wsTickets.delete(k);
    }
    const ticket = crypto.randomBytes(24).toString('base64url');
    const expiresAt = now + WS_TICKET_TTL_MS;
    this.wsTickets.set(ticket, { identity, expiresAt });
    return { ticket, expiresAt };
  }

  public consumeWsTicket(ticket: string): AuthIdentity | null {
    const record = this.wsTickets.get(ticket);
    if (!record) return null;
    this.wsTickets.delete(ticket);
    if (Date.now() > record.expiresAt) return null;
    return record.identity;
  }
}

export interface ControlPlaneVerifyOptions {
  publicKeyPem: string;
  expectedIssuer?: string;
  expectedAudience?: string;
}

/**
 * Verifies an Ed25519-signed JWT issued by the closed-source Enterprise Control Plane.
 * Enables Option 1 (Control Plane / Data Plane) without embedding multi-user management in OSS.
 */
export function verifyExternalControlPlaneToken(
  token: string,
  options: ControlPlaneVerifyOptions
): AuthIdentity | null {
  if (!token || !options.publicKeyPem) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = JSON.parse(base64UrlDecode(parts[0]).toString('utf8')) as { alg?: string };
    if (header.alg !== 'EdDSA') return null;

    const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const signature = base64UrlDecode(parts[2]);
    const validSig = crypto.verify(null, data, options.publicKeyPem, signature);
    if (!validSig) return null;

    const payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8')) as Record<string, unknown>;
    const exp = Number(payload.exp || 0);
    if (!Number.isFinite(exp) || Date.now() / 1000 >= exp) return null;
    if (options.expectedIssuer && payload.iss !== options.expectedIssuer) return null;
    if (options.expectedAudience && payload.aud !== options.expectedAudience) return null;
    if (typeof payload.sub !== 'string' || !payload.sub) return null;

    return {
      userId: payload.sub,
      role: payload.role === 'owner' || payload.role === 'admin' ? payload.role : 'member',
      workspaceId: typeof payload.workspaceId === 'string' ? payload.workspaceId : 'default',
      issuer: typeof payload.iss === 'string' ? payload.iss : 'control-plane',
      email: typeof payload.email === 'string' ? payload.email : undefined
    };
  } catch {
    return null;
  }
}
