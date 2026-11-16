export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

export function isApiTokenValid(
  provided: string | string[] | undefined,
  expected: string | undefined
): boolean {
  if (!expected) return false;
  const value = Array.isArray(provided) ? provided[0] : provided;
  return typeof value === 'string' && value === expected;
}

export function isLanAccessEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OPEN_EMPLOYEE_LAN === '1';
}

export function isProxyEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.OPEN_EMPLOYEE_ENABLE_PROXY === '1';
}

export function isDevVaultEndpointBlocked(url: string | undefined): boolean {
  if (!url) return false;
  const pathname = url.split('?')[0];
  return (
    pathname === '/api/vault' ||
    pathname.startsWith('/api/vault/') ||
    pathname === '/api/ai/chat'
  );
}
