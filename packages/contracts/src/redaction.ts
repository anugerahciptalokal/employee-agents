const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-api-token',
  'x-auth-token',
  'x-access-token',
  'x-goog-api-key',
  'cookie',
  'set-cookie'
]);

const SENSITIVE_NAME_PATTERN =
  /(authorization|api[_-]?key|apikey|api[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password|credential|cookie)/i;

const SECRET_VALUE_PATTERN =
  '(api[_-]?key|apikey|api[_-]?token|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|token|secret|password|credential)';

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) || SENSITIVE_NAME_PATTERN.test(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  if (!text) return text;

  let redacted = text;

  for (const secret of knownSecrets) {
    if (!secret) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\b((?:Proxy-)?Authorization\s*[:=]\s*Basic\s+)[^\s"',;]+/gi,
      '$1[REDACTED]'
    )
    .replace(
      /\b((?:Set-)?Cookie\s*:\s*)([^\r\n"']+)/gi,
      (_match, prefix: string, cookieBody: string) => {
        const redactedBody = cookieBody.replace(
          /\b([A-Za-z0-9_.-]+)=([^;\r\n]+)/g,
          (pair, name: string) => {
            if (/^(path|domain|max-age|expires|samesite)$/i.test(name)) {
              return pair;
            }
            return `${name}=[REDACTED]`;
          }
        );
        return `${prefix}${redactedBody}`;
      }
    )
    .replace(
      new RegExp(
        `([?&](?:${SECRET_VALUE_PATTERN.slice(1, -1)}|key|auth|signature|sig)=)([^&\\s#]+)`,
        'gi'
      ),
      '$1[REDACTED]'
    )
    .replace(
      new RegExp(
        `(["']?)\\b${SECRET_VALUE_PATTERN}\\b(["']?\\s*[:=]\\s*)(["']?)([^"'\\s,}&#]+)`,
        'gi'
      ),
      '$1$2$3$4[REDACTED]'
    )
    .replace(/\bsk-or-v1-[A-Za-z0-9._-]+\b/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');

  return redacted;
}

export function redactHeaders(
  headers: Record<string, string>,
  knownSecrets: readonly string[] = []
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    result[name] = isSensitiveHeader(name)
      ? '[REDACTED]'
      : redactSecrets(value, knownSecrets);
  }

  return result;
}

export function redactDeep(
  value: unknown,
  knownSecrets: readonly string[] = []
): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value, knownSecrets);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, knownSecrets));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_NAME_PATTERN.test(key)
        ? '[REDACTED]'
        : redactDeep(entry, knownSecrets);
    }
    return result;
  }

  return value;
}

export function safeErrorExcerpt(body: string, maxLength = 500): string {
  return redactSecrets(body)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
