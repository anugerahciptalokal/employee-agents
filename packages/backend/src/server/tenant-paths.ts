import path from 'path';

function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9_-]/g, '_').trim();
  if (!cleaned) {
    throw new Error('Invalid empty tenant path segment.');
  }
  return cleaned;
}

/**
 * Resolves `<dataDir>/users/<ownerUserId>`.
 */
export function resolveOwnerRoot(dataDir: string, ownerUserId: string): string {
  return path.resolve(dataDir, 'users', sanitizeSegment(ownerUserId));
}

/**
 * Resolves `<dataDir>/users/<ownerUserId>/secrets` (owner-level API keys & vault).
 */
export function resolveOwnerSecretsDir(dataDir: string, ownerUserId: string): string {
  return path.resolve(resolveOwnerRoot(dataDir, ownerUserId), 'secrets');
}

/**
 * Resolves `<dataDir>/users/<ownerUserId>/config` (owner-level preferences).
 */
export function resolveOwnerConfigDir(dataDir: string, ownerUserId: string): string {
  return path.resolve(resolveOwnerRoot(dataDir, ownerUserId), 'config');
}

/**
 * Resolves `<dataDir>/users/<ownerUserId>/workspaces/<workspaceId>`.
 */
export function resolveWorkspaceRoot(
  dataDir: string,
  ownerUserId: string,
  workspaceId: string
): string {
  return path.resolve(
    resolveOwnerRoot(dataDir, ownerUserId),
    'workspaces',
    sanitizeSegment(workspaceId)
  );
}

/**
 * Enforces cross-tenant isolation by verifying `candidatePath` resolves strictly inside `workspaceRoot`.
 */
export function assertTenantPathWithinWorkspace(
  workspaceRoot: string,
  candidatePath: string
): string {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidatePath);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new Error('Access denied: path escapes tenant workspace boundary.');
  }
  return resolved;
}
