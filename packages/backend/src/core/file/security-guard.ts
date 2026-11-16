import path from 'path';

/**
 * Blocklist of dangerous executable and system script extensions.
 */
export const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.vbs',
  '.dylib',
  '.so',
  '.app',
  '.dll',
  '.bin',
  '.msi',
  '.scr',
  '.com',
  '.pif',
  '.reg'
]);

/**
 * Validates that targetPath resolves strictly within baseDir to prevent Path Traversal attacks.
 */
export function validatePathBoundary(
  baseDir: string,
  targetPath: string
): { isSafe: boolean; resolvedPath: string } {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, targetPath);

  const relative = path.relative(resolvedBase, resolvedTarget);
  const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);

  return {
    isSafe,
    resolvedPath: resolvedTarget
  };
}

/**
 * Checks if a filename has an executable or dangerous extension.
 * Inspects all dot-separated extensions to prevent double extension spoofing (e.g. document.pdf.exe).
 */
export function isExtensionBlocked(filename: string): boolean {
  if (!filename) return false;
  const lowerName = filename.toLowerCase();

  // Check the primary extension
  const ext = path.extname(lowerName);
  if (BLOCKED_EXTENSIONS.has(ext)) return true;

  // Check all parts for double-extensions e.g. "laporan.pdf.exe" or "test.sh.txt" if blocked
  const parts = lowerName.split('.');
  if (parts.length > 2) {
    for (let i = 1; i < parts.length; i++) {
      if (BLOCKED_EXTENSIONS.has(`.${parts[i]}`)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Sanitizes SVG content by stripping executable scripts, event handlers, and javascript: links
 * to prevent Stored Cross-Site Scripting (XSS) within the Electron environment.
 */
export function sanitizeSvgContent(rawSvg: string): string {
  if (!rawSvg) return '';

  let sanitized = rawSvg;

  // 1. Remove <script> tags and everything between them
  sanitized = sanitized.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  // 2. Remove inline event handler attributes (e.g. onload=..., onerror=..., onclick=...)
  sanitized = sanitized.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  // 3. Remove javascript: pseudo-protocol in href or xlink:href attributes
  sanitized = sanitized.replace(
    /(href|xlink:href)\s*=\s*["']?\s*javascript:[^"'>\s]*["']?/gi,
    '$1=""'
  );

  return sanitized;
}

