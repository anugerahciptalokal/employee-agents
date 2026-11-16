import { normalizePairingPin, verifySignedPairingToken } from './pairing-helper';

/**
 * Shared policy for mobile client (paired device) requests.
 * Used by both the standalone server and the Vite dev middleware so the
 * device lifecycle behaves identically in development and production.
 */

export const UNKNOWN_DEVICE_ERROR = {
  error: 'device_unknown',
  message: 'This device is not linked to this workspace. Link it again from Settings > Linked Devices.'
} as const;

export const REVOKED_DEVICE_ERROR = {
  error: 'device_revoked',
  message: 'This device has been disconnected by the server administrator.'
} as const;

const PAIRING_ENDPOINTS = new Set([
  '/api/device/pairing-info',
  '/api/mobile/pair',
  '/api/device/register'
]);

/**
 * Pairing endpoints must accept requests that still carry a stale X-Device-Id,
 * otherwise a device whose record was removed could never link again.
 */
export function isPairingEndpoint(pathname: string): boolean {
  const clean = pathname.split('?')[0];
  return PAIRING_ENDPOINTS.has(clean);
}

function isLocalDevelopmentAddress(rawIp: string | undefined): boolean {
  if (!rawIp) return false;
  const ip = rawIp.replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.0.2.') || ip.startsWith('192.168.');
}

export interface PairingChallengeEntry {
  expiresAt: number;
  pairId: string;
}

export type PairingChallengeStore = Map<string, PairingChallengeEntry>;

const LOCAL_DEV_CHALLENGE_KEY = '__local_dev__';
const SIGNED_TOKEN_KEY_PREFIX = '__signed__:';

const consumedSignedTokens = new Map<string, number>();

function purgeConsumedSignedTokens(now: number): void {
  for (const [token, expiresAt] of Array.from(consumedSignedTokens.entries())) {
    if (now > expiresAt) {
      consumedSignedTokens.delete(token);
    }
  }
}

/**
 * Registers a new challenge without invalidating ones that are still live.
 * Several screens (or tabs) may display different QR codes at the same time,
 * and each of them must stay linkable until it is consumed or expires.
 * Expired entries are purged to keep the store bounded.
 */
export function registerPairingChallenge(
  challenges: PairingChallengeStore,
  challenge: { token: string; pinCode: string; expiresAt: number },
  now: number = Date.now()
): void {
  for (const [key, entry] of Array.from(challenges.entries())) {
    if (now > entry.expiresAt) {
      challenges.delete(key);
    }
  }

  const entry: PairingChallengeEntry = {
    expiresAt: challenge.expiresAt,
    pairId: challenge.token
  };
  challenges.set(challenge.token, entry);
  challenges.set(challenge.pinCode, entry);
}

function resolveChallengeKey(
  challenges: PairingChallengeStore,
  input: { pinCode?: string; challengeToken?: string; clientIp?: string },
  now: number
): string | null {
  const pinCode = normalizePairingPin(input.pinCode);
  const challengeToken = (input.challengeToken || '').trim();
  const isLive = (key: string) => now <= (challenges.get(key)?.expiresAt ?? 0);

  if (pinCode && challenges.has(pinCode) && isLive(pinCode)) {
    return pinCode;
  }
  if (challengeToken && challenges.has(challengeToken) && isLive(challengeToken)) {
    return challengeToken;
  }
  if (challengeToken) {
    const verified = verifySignedPairingToken(challengeToken, now);
    if (verified.valid) {
      return `${SIGNED_TOKEN_KEY_PREFIX}${challengeToken}`;
    }
  }
  if (!pinCode && !challengeToken) {
    return isLocalDevelopmentAddress(input.clientIp) ? LOCAL_DEV_CHALLENGE_KEY : null;
  }
  return null;
}

/**
 * Validates a mobile pairing attempt against the active challenges issued by
 * GET /api/device/pairing-info. Mirrors the standalone server rules, including
 * the code-less local development pairing allowance.
 */
export function isPairingChallengeValid(
  challenges: PairingChallengeStore,
  input: { pinCode?: string; challengeToken?: string; clientIp?: string },
  now: number = Date.now()
): boolean {
  return resolveChallengeKey(challenges, input, now) !== null;
}

/**
 * Validates and consumes the active challenge. A successful pairing removes
 * both the QR token and the PIN code so a scanned code can never be replayed.
 */
export function consumePairingChallenge(
  challenges: PairingChallengeStore,
  input: { pinCode?: string; challengeToken?: string; clientIp?: string },
  now: number = Date.now()
): boolean {
  const key = resolveChallengeKey(challenges, input, now);
  if (!key) return false;
  if (key === LOCAL_DEV_CHALLENGE_KEY) return true;

  if (key.startsWith(SIGNED_TOKEN_KEY_PREFIX)) {
    const signedToken = key.slice(SIGNED_TOKEN_KEY_PREFIX.length);
    purgeConsumedSignedTokens(now);
    if (consumedSignedTokens.has(signedToken)) return false;
    const verified = verifySignedPairingToken(signedToken, now);
    if (!verified.valid) return false;
    consumedSignedTokens.set(signedToken, verified.expiresAt ?? now);
    return true;
  }

  const entry = challenges.get(key);
  if (!entry) return false;

  for (const [challengeKey, candidate] of Array.from(challenges.entries())) {
    if (candidate.pairId === entry.pairId) {
      challenges.delete(challengeKey);
    }
  }

  if (verifySignedPairingToken(entry.pairId, now).valid) {
    purgeConsumedSignedTokens(now);
    consumedSignedTokens.set(entry.pairId, entry.expiresAt);
  }

  return true;
}
