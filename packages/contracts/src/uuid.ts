/**
 * Pure RFC 4122 / RFC 9562 Canonical UUID v4 & v5 Utilities.
 * Works identically in Node.js (Main/Service/Preload) and Browser (Renderer) runtimes
 * with zero external dependencies.
 */

export const CANONICAL_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fixed RFC 4122 namespace UUID for Employee Agents deterministic v5 ID migration.
 */
export const EMPLOYEE_AGENTS_UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_REGEX.test(value.trim());
}

function bytesToUuidString(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    hex.push(bytes[i].toString(16).padStart(2, '0'));
  }
  return (
    `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-` +
    `${hex[4]}${hex[5]}-` +
    `${hex[6]}${hex[7]}-` +
    `${hex[8]}${hex[9]}-` +
    `${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}`
  ).toLowerCase();
}

function uuidStringToBytes(uuid: string): Uint8Array {
  const clean = uuid.replace(/-/g, '').toLowerCase();
  if (clean.length !== 32) {
    throw new Error(`Invalid UUID string for byte conversion: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Generates a canonical RFC 4122 v4 UUID using runtime CSPRNG.
 * Never produces prefixes, suffixes, or timestamp labels.
 */
export function generateUuid(): string {
  const gCrypto = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
  if (gCrypto && typeof gCrypto.randomUUID === 'function') {
    return String(gCrypto.randomUUID()).toLowerCase();
  }

  const bytes = new Uint8Array(16);
  if (gCrypto && typeof gCrypto.getRandomValues === 'function') {
    gCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // RFC 4122 version 4 and variant 10xx
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytesToUuidString(bytes);
}

/**
 * Pure synchronous FIPS 180-4 SHA-1 implementation returning 20-byte digest.
 * Used exclusively to compute standard RFC 4122 UUID v5 synchronously in both
 * Main Process and Renderer without async WebCrypto or Node-only module barriers.
 */
function sha1Bytes(message: Uint8Array): Uint8Array {
  const ml = message.length * 8;
  const padLen = ((message.length + 8) >> 6) * 64 + 64;
  const padded = new Uint8Array(padLen);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(padLen - 8, Math.floor(ml / 0x100000000), false);
  view.setUint32(padLen - 4, ml >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < padLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = ((n << 1) | (n >>> 31)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f = 0;
      let k = 0;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  return out;
}

/**
 * Generates a standard RFC 4122 UUID v5 (SHA-1 name-based UUID).
 */
export function uuidV5(name: string, namespace: string = EMPLOYEE_AGENTS_UUID_NAMESPACE): string {
  const nsBytes = uuidStringToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const combined = new Uint8Array(nsBytes.length + nameBytes.length);
  combined.set(nsBytes, 0);
  combined.set(nameBytes, nsBytes.length);

  const hash = sha1Bytes(combined);
  const uuidBytes = hash.slice(0, 16);

  // Set RFC 4122 version 5 (0101)
  uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x50;
  // Set RFC 4122 variant (10xx)
  uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;

  return bytesToUuidString(uuidBytes);
}

/**
 * Canonical fixed UUID v5 for the local human user sender identity.
 * Derived deterministically from uuidV5('user:local-operator', EMPLOYEE_AGENTS_UUID_NAMESPACE).
 */
export const LOCAL_USER_SENDER_UUID = uuidV5('user:local-operator', EMPLOYEE_AGENTS_UUID_NAMESPACE);

/**
 * Converts a legacy non-UUID identifier into a deterministic RFC 4122 UUID v5.
 * If the identifier is already a valid canonical UUID, returns it normalized to lowercase.
 */
export function legacyIdToDeterministicUuid(rawId: string): string {
  const trimmed = (rawId || '').trim();
  if (!trimmed) {
    return generateUuid();
  }
  if (isValidUuid(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (trimmed === 'user-bos') {
    return LOCAL_USER_SENDER_UUID;
  }
  return uuidV5(`legacy-id:${trimmed}`, EMPLOYEE_AGENTS_UUID_NAMESPACE);
}

