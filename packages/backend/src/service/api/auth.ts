import { timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import { isLoopbackAddress } from '../../utils/dev-api-policy';

export function extractBearerToken(
  header: string | string[] | undefined
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1] : null;
}

export function isTokenValid(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function isAuthorized(request: IncomingMessage, token: string): boolean {
  return isTokenValid(extractBearerToken(request.headers.authorization), token);
}

export function isLoopbackRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress);
}
