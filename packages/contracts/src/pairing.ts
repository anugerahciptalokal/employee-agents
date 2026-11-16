/**
 * Pairing Onboarding Gate & Handshake Helper
 * Provides platform evaluation, payload extraction, and connection handshake logic.
 */

export interface PairingPayload {
  serverUrl: string;
  token: string;
  workspaceName?: string;
  expiresAt: number;
  pinCode?: string;
}

function getStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
    return (globalThis as any).localStorage;
  }
  return null;
}

export function evaluateInitialPairingState(isNativePlatform: boolean): boolean {
  if (!isNativePlatform) {
    // Desktop or web host environment: paired / host by default
    return true;
  }
  const storage = getStorage();
  if (!storage) {
    return false;
  }
  const savedHost = storage.getItem('open_employee_host_url');
  return Boolean(savedHost && savedHost.trim().length > 0);
}

export function extractServerUrlFromQrPayload(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try JSON parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed.serverUrl === 'string' && parsed.serverUrl.startsWith('http')) {
      return parsed.serverUrl.replace(/\/+$/, '');
    }
  } catch {
    // Not JSON, continue to raw URL check
  }

  // Check if direct URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.replace(/\/+$/, '');
  }

  return null;
}

export function normalizeServerAddress(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';

  const extracted = extractServerUrlFromQrPayload(trimmed);
  if (extracted) {
    return extracted;
  }

  // Auto-prepend protocol scheme if omitted
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/^(localhost|127\.0\.0\.1|10\.|192\.168\.)/i.test(trimmed)) {
      trimmed = `http://${trimmed}`;
    } else {
      trimmed = `https://${trimmed}`;
    }
  }

  return trimmed;
}

export function commitPairingHandshake(serverUrl: string): boolean {
  if (!serverUrl || typeof serverUrl !== 'string') return false;
  const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
  if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
    return false;
  }

  const storage = getStorage();
  if (storage) {
    storage.setItem('open_employee_host_url', cleanUrl);
    storage.setItem('open_employee_paired_at', String(Date.now()));
    return true;
  }
  return false;
}

export function unlinkDeviceAndReset(): void {
  const storage = getStorage();
  if (storage) {
    storage.removeItem('open_employee_host_url');
    storage.removeItem('open_employee_paired_at');
  }
}

export function validateServerHandshakeResponse(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const data = payload as Record<string, unknown>;
  const hasChannels = Array.isArray(data.channels);
  const hasAgents = Array.isArray(data.agents);
  return hasChannels && hasAgents;
}
