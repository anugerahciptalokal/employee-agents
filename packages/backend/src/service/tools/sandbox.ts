import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  rmSync
} from 'fs';
import { homedir } from 'os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
   relative,
  resolve,
  sep
} from 'path';

/**
 * Phase 3 Step 2: Workspace Sandbox & Path Canonicalization.
 *
 * SECURITY LIMITATION (TOCTOU):
 * `realpath` and ancestor validation establish a deterministic path boundary at
 * validation time, but cannot by themselves prevent Time-Of-Check to Time-Of-Use
 * (TOCTOU) symlink swaps between path validation and subsequent filesystem I/O.
 * Phase 3 Step 4 (`ToolExecutor` and filesystem tools) MUST revalidate canonical
 * paths immediately before I/O and use safe file-descriptor/handle operations
 * (`O_NOFOLLOW` / `fs.open` with flags where supported) when performing reads and writes.
 *
 * MIME VALIDATION LIMITATION:
 * `WorkspaceSandbox` enforces a strict deny-by-default executable extension blocklist
 * (including relevant double extensions such as `payload.txt.exe`). Explicit MIME
 * validation is performed only when trusted MIME metadata is supplied by the caller;
 * when MIME metadata is absent, only the extension policy is enforced.
 */

export type SandboxErrorCode =
  | 'SANDBOX_INVALID_ROOT'
  | 'SANDBOX_INVALID_IDENTIFIER'
  | 'SANDBOX_PATH_ESCAPE'
  | 'SANDBOX_SYMLINK_ESCAPE'
  | 'SANDBOX_WRITE_DENIED'
  | 'SANDBOX_EXTENSION_BLOCKED';

export class SandboxError extends Error {
  constructor(
    public readonly code: SandboxErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

export const BLOCKED_EXECUTABLE_EXTENSIONS: readonly string[] = [
  '.sh',
  '.bash',
  '.zsh',
  '.exe',
  '.bat',
  '.cmd',
  '.ps1',
  '.dll',
  '.so',
  '.dylib',
  '.app',
  '.msi',
  '.com',
  '.scr'
] as const;

export const BLOCKED_EXECUTABLE_MIME_TYPES: readonly string[] = [
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-mach-binary',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-msi',
  'text/x-shellscript',
  'text/x-sh'
] as const;

const BLOCKED_EXTENSION_SET = new Set<string>(BLOCKED_EXECUTABLE_EXTENSIONS);
const BLOCKED_MIME_SET = new Set<string>(BLOCKED_EXECUTABLE_MIME_TYPES);
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export type WorkspaceArea =
  | 'agent_workspace'
  | 'run_workspace'
  | 'run_shared'
  | 'run_tmp'
  | 'read_only_mount';

export interface WorkspaceSandboxOptions {
  rootDir: string;
  productionDataDir?: string;
  homeDir?: string;
  readOnlyMounts?: readonly string[];
}

export interface WorkspacePathRequest {
  targetPath: string;
  mode: 'read' | 'write';
  runId?: string;
  agentId?: string;
  baseArea?: 'agent_workspace' | 'run_workspace' | 'run_shared' | 'run_tmp';
  allowSharedWrite?: boolean;
  mimeType?: string;
}

export interface ResolvedWorkspacePath {
  canonicalPath: string;
  relativePath: string;
  area: WorkspaceArea;
  boundaryRoot: string;
}

export type WorkspacePathResolution =
  | { ok: true; value: ResolvedWorkspacePath }
  | { ok: false; error: SandboxError };

function isWithinBoundary(candidatePath: string, boundaryRoot: string): boolean {
  const rel = relative(boundaryRoot, candidatePath);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../')) {
    return false;
  }
  return true;
}

function isBelowAnyBoundaryRoot(
  candidatePath: string,
  boundaryRoots: readonly string[]
): boolean {
  for (const root of boundaryRoots) {
    if (candidatePath !== root && isWithinBoundary(candidatePath, root)) {
      return true;
    }
  }
  return false;
}

function canonicalizePathStepByStep(
  targetPath: string,
  options: {
    boundaryRoots?: readonly string[];
    permittedBoundaryRoots?: readonly string[];
    stopAtBoundarySymlinks?: boolean;
  } = {}
): { canonicalPath: string; traversedSymlinkBelowBoundary: boolean } {
  const {
    boundaryRoots = [],
    permittedBoundaryRoots,
    stopAtBoundarySymlinks = false
  } = options;
  const initialAbs = resolve(targetPath);
  const queue = initialAbs.split(/[\\/]+/).filter(Boolean);

  let currentCanonical: string = sep;
  let traversedSymlinkBelowBoundary = false;
  let enteredMissingSegment = false;
  let lockedBoundaryRoot: string | null = null;
  let hasReachedLockedBoundary = false;
  const visitedSymlinks = new Set<string>();
  let symlinkExpansions = 0;
  const MAX_SYMLINK_EXPANSIONS = 40;

  while (queue.length > 0) {
    const segment = queue.shift()!;
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (enteredMissingSegment) {
        throw new SandboxError(
          traversedSymlinkBelowBoundary
            ? 'SANDBOX_SYMLINK_ESCAPE'
            : 'SANDBOX_PATH_ESCAPE',
          'Cannot traverse parent segment ("..") after a non-existent path component.'
        );
      }
      currentCanonical = dirname(currentCanonical);
      if (lockedBoundaryRoot !== null && !stopAtBoundarySymlinks) {
        if (hasReachedLockedBoundary) {
          if (!isWithinBoundary(currentCanonical, lockedBoundaryRoot)) {
            throw new SandboxError(
              'SANDBOX_SYMLINK_ESCAPE',
              'Symbolic link target traverses above the permitted workspace boundary.'
            );
          }
        } else if (!isWithinBoundary(lockedBoundaryRoot, currentCanonical)) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Symbolic link target diverges from the permitted workspace boundary.'
          );
        }
      }
      continue;
    }

    const nextCandidate = join(currentCanonical, segment);

    if (enteredMissingSegment) {
      if (lockedBoundaryRoot !== null && !stopAtBoundarySymlinks) {
        if (
          !hasReachedLockedBoundary ||
          !isWithinBoundary(nextCandidate, lockedBoundaryRoot)
        ) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Dangling symbolic link target escapes the permitted workspace boundary.'
          );
        }
      }
      currentCanonical = nextCandidate;
      continue;
    }

    let stat;
    try {
      stat = lstatSync(nextCandidate);
    } catch {
      enteredMissingSegment = true;
      if (lockedBoundaryRoot !== null && !stopAtBoundarySymlinks) {
        if (
          !hasReachedLockedBoundary ||
          !isWithinBoundary(nextCandidate, lockedBoundaryRoot)
        ) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Dangling symbolic link target is outside the permitted workspace boundary.'
          );
        }
      }
      currentCanonical = nextCandidate;
      continue;
    }

    if (stat.isSymbolicLink()) {
      const belowBoundary = isBelowAnyBoundaryRoot(
        nextCandidate,
        boundaryRoots
      );
      if (belowBoundary) {
        traversedSymlinkBelowBoundary = true;
        if (stopAtBoundarySymlinks) {
          currentCanonical = nextCandidate;
          continue;
        }

        if (permittedBoundaryRoots) {
          const matchedRoot =
            permittedBoundaryRoots.find((root) =>
              isWithinBoundary(nextCandidate, root)
            ) ?? null;
          if (!matchedRoot) {
            throw new SandboxError(
              'SANDBOX_SYMLINK_ESCAPE',
              'Symbolic link is outside the permitted workspace boundary.'
            );
          }
          if (
            lockedBoundaryRoot !== null &&
            matchedRoot !== lockedBoundaryRoot
          ) {
            throw new SandboxError(
              'SANDBOX_SYMLINK_ESCAPE',
              'Symbolic link crosses permitted workspace boundaries.'
            );
          }
          lockedBoundaryRoot = matchedRoot;
        }
      } else if (lockedBoundaryRoot !== null && !stopAtBoundarySymlinks) {
        if (hasReachedLockedBoundary) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Symbolic link hops outside the permitted workspace boundary.'
          );
        }
        let resolvedAlias: string;
        try {
          resolvedAlias = realpathSync(nextCandidate);
        } catch {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Dangling external symbolic link is forbidden.'
          );
        }
        const isStrictAncestorOfBoundary =
          resolvedAlias !== lockedBoundaryRoot &&
          isWithinBoundary(lockedBoundaryRoot, resolvedAlias);
        if (!isStrictAncestorOfBoundary) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Symbolic link hops through an external symbolic link outside the permitted boundary.'
          );
        }
      }

      symlinkExpansions += 1;
      if (
        symlinkExpansions > MAX_SYMLINK_EXPANSIONS ||
        visitedSymlinks.has(nextCandidate)
      ) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Symbolic link loop detected during path canonicalization.'
        );
      }
      visitedSymlinks.add(nextCandidate);

      const rawLinkTarget = readlinkSync(nextCandidate);
      const targetSegments = rawLinkTarget.split(/[\\/]+/).filter(Boolean);
      if (isAbsolute(rawLinkTarget)) {
        currentCanonical = sep;
        if (lockedBoundaryRoot !== null) {
          hasReachedLockedBoundary = false;
        }
      } else {
        currentCanonical = dirname(nextCandidate);
        if (lockedBoundaryRoot !== null) {
          hasReachedLockedBoundary = isWithinBoundary(
            currentCanonical,
            lockedBoundaryRoot
          );
        }
      }
      queue.unshift(...targetSegments);
      continue;
    }

    currentCanonical = nextCandidate;
    if (lockedBoundaryRoot !== null && !stopAtBoundarySymlinks) {
      if (currentCanonical === lockedBoundaryRoot) {
        hasReachedLockedBoundary = true;
      }
      if (hasReachedLockedBoundary) {
        if (!isWithinBoundary(currentCanonical, lockedBoundaryRoot)) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            'Symbolic link path escapes the permitted workspace boundary.'
          );
        }
      } else if (!isWithinBoundary(lockedBoundaryRoot, currentCanonical)) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Symbolic link path steps outside the permitted workspace boundary.'
        );
      }
    }
  }

  if (
    lockedBoundaryRoot !== null &&
    !stopAtBoundarySymlinks &&
    (!hasReachedLockedBoundary ||
      !isWithinBoundary(currentCanonical, lockedBoundaryRoot))
  ) {
    throw new SandboxError(
      'SANDBOX_SYMLINK_ESCAPE',
      'Symbolic link resolved outside the permitted workspace boundary.'
    );
  }

  return {
    canonicalPath: currentCanonical,
    traversedSymlinkBelowBoundary
  };
}

export function validateExecutablePolicy(
  filePath: string,
  mimeType?: string
): void {
  const rawName = basename(filePath);
  if (!rawName || !rawName.trim()) {
    throw new SandboxError('SANDBOX_PATH_ESCAPE', 'File path basename is empty.');
  }

  if (
    /\s$/.test(rawName) ||
    rawName.endsWith('.') ||
    /\s\.|\.\s/.test(rawName)
  ) {
    throw new SandboxError(
      'SANDBOX_EXTENSION_BLOCKED',
      'File basename must not end with a dot/whitespace or contain whitespace adjacent to extension separators.'
    );
  }

  const lowerName = rawName.toLowerCase();
  const startsWithDot = lowerName.startsWith('.');
  const withoutLeadingDots = lowerName.replace(/^\.+/, '');
  if (!withoutLeadingDots) {
    throw new SandboxError(
      'SANDBOX_PATH_ESCAPE',
      'File path basename is invalid.'
    );
  }

  const segments = withoutLeadingDots.split('.');
  const startIndex = startsWithDot ? 0 : 1;
  for (let index = startIndex; index < segments.length; index += 1) {
    const rawSegment = segments[index];
    const trimmedSegment = rawSegment.trim();
    if (!trimmedSegment || rawSegment !== trimmedSegment) {
      throw new SandboxError(
        'SANDBOX_EXTENSION_BLOCKED',
        'File extension segments must not contain leading or trailing whitespace.'
      );
    }
    const ext = `.${trimmedSegment}`;
    if (BLOCKED_EXTENSION_SET.has(ext)) {
      throw new SandboxError(
        'SANDBOX_EXTENSION_BLOCKED',
        `Executable file extension "${ext}" is blocked by sandbox policy.`
      );
    }
  }

  if (mimeType !== undefined) {
    const normalizedMime = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (
      BLOCKED_MIME_SET.has(normalizedMime) ||
      normalizedMime.endsWith('/x-executable') ||
      normalizedMime.endsWith('/x-msdownload') ||
      normalizedMime.endsWith('/x-sh') ||
      normalizedMime.endsWith('/x-shellscript')
    ) {
      throw new SandboxError(
        'SANDBOX_EXTENSION_BLOCKED',
        `Executable MIME type "${normalizedMime}" is blocked by sandbox policy.`
      );
    }
  }
}

function overlapsProtectedBoundary(
  candidatePath: string,
  protectedBoundary: string
): boolean {
  return (
    candidatePath === protectedBoundary ||
    isWithinBoundary(candidatePath, protectedBoundary) ||
    isWithinBoundary(protectedBoundary, candidatePath)
  );
}

export class WorkspaceSandbox {
  public readonly rootDir: string;
  public readonly productionDataDir: string;
  public readonly homeDir: string;
  public readonly readOnlyMounts: readonly string[];

  constructor(options: WorkspaceSandboxOptions) {
    if (
      typeof options.rootDir !== 'string' ||
      !options.rootDir.trim() ||
      options.rootDir.includes('\0')
    ) {
      throw new SandboxError(
        'SANDBOX_INVALID_ROOT',
        'Workspace root directory must be a non-empty path without null bytes.'
      );
    }

    const rawProductionDataDir =
      options.productionDataDir ?? resolve(process.cwd(), '.data');
    const rawHomeDir = options.homeDir ?? homedir();

    this.productionDataDir =
      canonicalizePathStepByStep(rawProductionDataDir).canonicalPath;
    this.homeDir = canonicalizePathStepByStep(rawHomeDir).canonicalPath;

    const preCanonicalRoot = canonicalizePathStepByStep(
      options.rootDir
    ).canonicalPath;

    if (overlapsProtectedBoundary(preCanonicalRoot, this.productionDataDir)) {
      throw new SandboxError(
        'SANDBOX_INVALID_ROOT',
        'Workspace root must not be equal to, inside, or a parent of the production .data directory.'
      );
    }

    if (overlapsProtectedBoundary(preCanonicalRoot, this.homeDir)) {
      throw new SandboxError(
        'SANDBOX_INVALID_ROOT',
        'Workspace root must not be equal to, inside, or a parent of the user home directory ($HOME).'
      );
    }

    mkdirSync(options.rootDir, { recursive: true });
    const canonicalRoot = realpathSync(options.rootDir);

    if (overlapsProtectedBoundary(canonicalRoot, this.productionDataDir)) {
      throw new SandboxError(
        'SANDBOX_INVALID_ROOT',
        'Workspace root must not be equal to, inside, or a parent of the production .data directory.'
      );
    }

    if (overlapsProtectedBoundary(canonicalRoot, this.homeDir)) {
      throw new SandboxError(
        'SANDBOX_INVALID_ROOT',
        'Workspace root must not be equal to, inside, or a parent of the user home directory ($HOME).'
      );
    }

    this.rootDir = canonicalRoot;

    const mounts: string[] = [];
    for (const mount of options.readOnlyMounts ?? []) {
      if (typeof mount !== 'string' || !mount.trim() || mount.includes('\0')) {
        throw new SandboxError(
          'SANDBOX_INVALID_ROOT',
          'Read-only mount path is invalid.'
        );
      }
      const canonicalMount = canonicalizePathStepByStep(mount).canonicalPath;
      if (
        overlapsProtectedBoundary(canonicalMount, this.productionDataDir) ||
        overlapsProtectedBoundary(canonicalMount, this.homeDir)
      ) {
        throw new SandboxError(
          'SANDBOX_INVALID_ROOT',
          'Read-only mount must not equal, reside inside, or be a parent of the production .data directory or $HOME.'
        );
      }
      mounts.push(canonicalMount);
    }
    this.readOnlyMounts = mounts;
  }

  private validateIdentifier(id: string, label: string): string {
    if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) {
      throw new SandboxError(
        'SANDBOX_INVALID_IDENTIFIER',
        `Invalid ${label} identifier.`
      );
    }
    return id;
  }

  private ensureSafeBoundaryDirectory(
    relativeSegments: readonly string[]
  ): string {
    let rootStat;
    try {
      rootStat = lstatSync(this.rootDir);
    } catch {
      throw new SandboxError(
        'SANDBOX_INVALID_ROOT',
        'Workspace root directory does not exist.'
      );
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new SandboxError(
        'SANDBOX_SYMLINK_ESCAPE',
        'Workspace root directory must be a real directory and not a symbolic link.'
      );
    }
    if (realpathSync(this.rootDir) !== this.rootDir) {
      throw new SandboxError(
        'SANDBOX_SYMLINK_ESCAPE',
        'Workspace root directory canonical path mismatch.'
      );
    }

    let currentDir = this.rootDir;
    for (const segment of relativeSegments) {
      const nextDir = join(currentDir, segment);
      let stat = null;
      try {
        stat = lstatSync(nextDir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          throw new SandboxError(
            'SANDBOX_PATH_ESCAPE',
            `Failed to inspect boundary directory component "${segment}".`
          );
        }
      }

      if (stat !== null) {
        if (stat.isSymbolicLink()) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            `Boundary directory component "${segment}" must not be a symbolic link.`
          );
        }
        if (!stat.isDirectory()) {
          throw new SandboxError(
            'SANDBOX_PATH_ESCAPE',
            `Boundary path component "${segment}" must be a directory.`
          );
        }
      } else {
        mkdirSync(nextDir);
        const createdStat = lstatSync(nextDir);
        if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
          throw new SandboxError(
            'SANDBOX_SYMLINK_ESCAPE',
            `Created boundary component "${segment}" is not a valid real directory.`
          );
        }
      }

      const canonicalNext = realpathSync(nextDir);
      if (
        canonicalNext !== nextDir ||
        !isWithinBoundary(canonicalNext, this.rootDir)
      ) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          `Boundary directory "${segment}" resolved outside its expected canonical path.`
        );
      }

      currentDir = nextDir;
    }

    return currentDir;
  }

  public getAgentWorkspaceDir(agentId: string): string {
    const validId = this.validateIdentifier(agentId, 'agentId');
    return this.ensureSafeBoundaryDirectory(['agents', validId]);
  }

  public getRunWorkspaceDir(runId: string): string {
    const validId = this.validateIdentifier(runId, 'runId');
    return this.ensureSafeBoundaryDirectory(['runs', validId, 'workspace']);
  }

  public getRunSharedDir(runId: string): string {
    const validId = this.validateIdentifier(runId, 'runId');
    return this.ensureSafeBoundaryDirectory(['runs', validId, 'shared']);
  }

  public getRunTempDir(runId: string): string {
    const validId = this.validateIdentifier(runId, 'runId');
    return this.ensureSafeBoundaryDirectory(['runs', validId, 'tmp']);
  }

  public createRunTempDir(runId: string): string {
    return this.getRunTempDir(runId);
  }

  public cleanupRunTempDir(runId: string): void {
    const validId = this.validateIdentifier(runId, 'runId');
    const runsBase = join(this.rootDir, 'runs');
    const runDir = join(runsBase, validId);
    const tmpDir = join(runDir, 'tmp');

    for (const ancestor of [runsBase, runDir]) {
      let ancestorStat = null;
      try {
        ancestorStat = lstatSync(ancestor);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          return;
        }
        throw new SandboxError(
          'SANDBOX_PATH_ESCAPE',
          'Failed to inspect run ancestor directory.'
        );
      }
      if (ancestorStat.isSymbolicLink()) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Refusing to clean up run tmp directory under a symbolic link parent.'
        );
      }
      if (!ancestorStat.isDirectory() || realpathSync(ancestor) !== ancestor) {
        throw new SandboxError(
          'SANDBOX_PATH_ESCAPE',
          'Run ancestor directory is invalid.'
        );
      }
    }

    let stat = null;
    try {
      stat = lstatSync(tmpDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        return;
      }
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Failed to inspect run tmp directory.'
      );
    }

    if (stat.isSymbolicLink()) {
      throw new SandboxError(
        'SANDBOX_SYMLINK_ESCAPE',
        'Refusing to clean up a symbolic link in place of the run tmp directory.'
      );
    }

    const canonicalTmp = realpathSync(tmpDir);
    const expectedPrefix = join(this.rootDir, 'runs', validId, 'tmp');
    if (
      canonicalTmp !== expectedPrefix ||
      !isWithinBoundary(canonicalTmp, this.rootDir)
    ) {
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Run temp directory resolved outside its expected sandbox boundary.'
      );
    }

    rmSync(canonicalTmp, { recursive: true, force: true });
  }

  public tryResolveWorkspacePath(
    request: WorkspacePathRequest
  ): WorkspacePathResolution {
    try {
      return { ok: true, value: this.resolveWorkspacePath(request) };
    } catch (error) {
      if (error instanceof SandboxError) {
        return { ok: false, error };
      }
      return {
        ok: false,
        error: new SandboxError(
          'SANDBOX_PATH_ESCAPE',
          'Workspace path resolution failed.'
        )
      };
    }
  }

  public resolveWorkspacePath(
    request: WorkspacePathRequest
  ): ResolvedWorkspacePath {
    const { targetPath, mode, runId, agentId } = request;

    if (
      typeof targetPath !== 'string' ||
      !targetPath.trim() ||
      targetPath.includes('\0')
    ) {
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Target path must be a non-empty string without null bytes.'
      );
    }

    // MED-03: Strict separator and traversal policy before path.resolve()
    if (targetPath.includes('\\')) {
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Backslash path separators are forbidden.'
      );
    }

    const rawSegments = targetPath.split(/\/+/);
    if (rawSegments.includes('..')) {
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Path traversal segments ("..") are forbidden.'
      );
    }

    const baseDir = this.resolveBaseDirectory(request);
    const rawLexicalPath = isAbsolute(targetPath)
      ? resolve(targetPath)
      : resolve(baseDir, targetPath);

    const boundaries = {
      ownAgentRoot: agentId ? this.getAgentWorkspaceDir(agentId) : null,
      ownRunWorkspaceRoot: runId ? this.getRunWorkspaceDir(runId) : null,
      ownRunSharedRoot: runId ? this.getRunSharedDir(runId) : null,
      ownRunTmpRoot: runId ? this.getRunTempDir(runId) : null
    };

    const permittedBoundaryRoots = [
      boundaries.ownRunWorkspaceRoot,
      boundaries.ownRunTmpRoot,
      boundaries.ownRunSharedRoot,
      boundaries.ownAgentRoot,
      ...this.readOnlyMounts
    ].filter((root): root is string => root !== null);

    const boundaryRoots = [this.rootDir, ...this.readOnlyMounts];

    // Normalize OS root aliases above sandbox roots without dereferencing symlinks inside sandbox roots
    const lexicalBoundaryResolution = canonicalizePathStepByStep(
      rawLexicalPath,
      {
        boundaryRoots,
        permittedBoundaryRoots,
        stopAtBoundarySymlinks: true
      }
    );
    const normalizedLexicalPath = lexicalBoundaryResolution.canonicalPath;

    // Full step-by-step canonicalization (MED-02)
    const fullResolution = canonicalizePathStepByStep(rawLexicalPath, {
      boundaryRoots,
      permittedBoundaryRoots,
      stopAtBoundarySymlinks: false
    });
    const canonicalPath = fullResolution.canonicalPath;
    const traversedSandboxSymlink =
      fullResolution.traversedSymlinkBelowBoundary ||
      lexicalBoundaryResolution.traversedSymlinkBelowBoundary;

    // HIGH-02: Unconditional protection for .data and $HOME
    if (
      isWithinBoundary(canonicalPath, this.productionDataDir) ||
      isWithinBoundary(normalizedLexicalPath, this.productionDataDir) ||
      isWithinBoundary(rawLexicalPath, this.productionDataDir)
    ) {
      if (traversedSandboxSymlink) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Symbolic link points into the protected production .data directory.'
        );
      }
      if (mode === 'write') {
        throw new SandboxError(
          'SANDBOX_WRITE_DENIED',
          'Write access to the production .data directory is forbidden.'
        );
      }
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Access to the production .data directory is forbidden.'
      );
    }

    if (
      canonicalPath === this.homeDir ||
      isWithinBoundary(canonicalPath, this.homeDir) ||
      normalizedLexicalPath === this.homeDir ||
      isWithinBoundary(normalizedLexicalPath, this.homeDir) ||
      rawLexicalPath === this.homeDir ||
      isWithinBoundary(rawLexicalPath, this.homeDir)
    ) {
      if (traversedSandboxSymlink) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Symbolic link points into the protected user home directory ($HOME).'
        );
      }
      if (mode === 'write') {
        throw new SandboxError(
          'SANDBOX_WRITE_DENIED',
          'Write access to the user home directory ($HOME) is forbidden.'
        );
      }
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Access to the user home directory ($HOME) is forbidden.'
      );
    }

    if (
      isWithinBoundary(normalizedLexicalPath, this.rootDir) &&
      !isWithinBoundary(canonicalPath, this.rootDir)
    ) {
      if (traversedSandboxSymlink) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Symbolic link points outside the canonical workspace root.'
        );
      }
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Resolved path escapes the canonical workspace root.'
      );
    }

    const matchedBoundary = this.matchAllowedBoundary(
      canonicalPath,
      normalizedLexicalPath,
      traversedSandboxSymlink,
      boundaries,
      request
    );

    if (mode === 'write') {
      validateExecutablePolicy(canonicalPath, request.mimeType);
    }

    return {
      canonicalPath,
      relativePath: relative(matchedBoundary.boundaryRoot, canonicalPath),
      area: matchedBoundary.area,
      boundaryRoot: matchedBoundary.boundaryRoot
    };
  }

  private resolveBaseDirectory(request: WorkspacePathRequest): string {
    const area =
      request.baseArea ??
      (request.runId
        ? 'run_workspace'
        : request.agentId
          ? 'agent_workspace'
          : undefined);

    if (area === 'run_workspace') {
      if (!request.runId) {
        throw new SandboxError(
          'SANDBOX_INVALID_IDENTIFIER',
          'runId is required for run_workspace access.'
        );
      }
      return this.getRunWorkspaceDir(request.runId);
    }

    if (area === 'run_shared') {
      if (!request.runId) {
        throw new SandboxError(
          'SANDBOX_INVALID_IDENTIFIER',
          'runId is required for run_shared access.'
        );
      }
      return this.getRunSharedDir(request.runId);
    }

    if (area === 'run_tmp') {
      if (!request.runId) {
        throw new SandboxError(
          'SANDBOX_INVALID_IDENTIFIER',
          'runId is required for run_tmp access.'
        );
      }
      return this.getRunTempDir(request.runId);
    }

    if (area === 'agent_workspace') {
      if (!request.agentId) {
        throw new SandboxError(
          'SANDBOX_INVALID_IDENTIFIER',
          'agentId is required for agent_workspace access.'
        );
      }
      return this.getAgentWorkspaceDir(request.agentId);
    }

    return this.rootDir;
  }

  private classifyPermittedBoundary(
    candidatePath: string,
    boundaries: {
      ownRunWorkspaceRoot: string | null;
      ownRunTmpRoot: string | null;
      ownRunSharedRoot: string | null;
      ownAgentRoot: string | null;
    }
  ): { area: WorkspaceArea; boundaryRoot: string } | null {
    const {
      ownRunWorkspaceRoot,
      ownRunTmpRoot,
      ownRunSharedRoot,
      ownAgentRoot
    } = boundaries;

    if (
      ownRunWorkspaceRoot &&
      isWithinBoundary(candidatePath, ownRunWorkspaceRoot)
    ) {
      return { area: 'run_workspace', boundaryRoot: ownRunWorkspaceRoot };
    }

    if (ownRunTmpRoot && isWithinBoundary(candidatePath, ownRunTmpRoot)) {
      return { area: 'run_tmp', boundaryRoot: ownRunTmpRoot };
    }

    if (ownRunSharedRoot && isWithinBoundary(candidatePath, ownRunSharedRoot)) {
      return { area: 'run_shared', boundaryRoot: ownRunSharedRoot };
    }

    if (ownAgentRoot && isWithinBoundary(candidatePath, ownAgentRoot)) {
      return { area: 'agent_workspace', boundaryRoot: ownAgentRoot };
    }

    for (const mount of this.readOnlyMounts) {
      if (isWithinBoundary(candidatePath, mount)) {
        return { area: 'read_only_mount', boundaryRoot: mount };
      }
    }

    return null;
  }

  private matchAllowedBoundary(
    canonicalPath: string,
    normalizedLexicalPath: string,
    traversedSandboxSymlink: boolean,
    boundaries: {
      ownRunWorkspaceRoot: string | null;
      ownRunTmpRoot: string | null;
      ownRunSharedRoot: string | null;
      ownAgentRoot: string | null;
    },
    request: WorkspacePathRequest
  ): { area: WorkspaceArea; boundaryRoot: string } {
    const { mode, allowSharedWrite = false } = request;

    const lexicalBoundary = this.classifyPermittedBoundary(
      normalizedLexicalPath,
      boundaries
    );
    const canonicalBoundary = this.classifyPermittedBoundary(
      canonicalPath,
      boundaries
    );

    // MED-01: Any symlink inside the sandbox or read-only mounts must remain within the exact same permitted boundary
    if (traversedSandboxSymlink) {
      if (
        !lexicalBoundary ||
        !canonicalBoundary ||
        lexicalBoundary.area !== canonicalBoundary.area ||
        lexicalBoundary.boundaryRoot !== canonicalBoundary.boundaryRoot
      ) {
        throw new SandboxError(
          'SANDBOX_SYMLINK_ESCAPE',
          'Symbolic link crosses or escapes the permitted workspace boundary.'
        );
      }
    }

    if (
      !canonicalBoundary ||
      !lexicalBoundary ||
      lexicalBoundary.area !== canonicalBoundary.area ||
      lexicalBoundary.boundaryRoot !== canonicalBoundary.boundaryRoot
    ) {
      const agentsBase = join(this.rootDir, 'agents');
      const runsBase = join(this.rootDir, 'runs');
      if (
        isWithinBoundary(canonicalPath, agentsBase) ||
        isWithinBoundary(canonicalPath, runsBase)
      ) {
        if (mode === 'write') {
          throw new SandboxError(
            'SANDBOX_WRITE_DENIED',
            'Write access to another agent or run workspace is forbidden.'
          );
        }
        throw new SandboxError(
          'SANDBOX_PATH_ESCAPE',
          'Read access to another agent or run workspace is forbidden.'
        );
      }

      if (mode === 'write') {
        throw new SandboxError(
          'SANDBOX_WRITE_DENIED',
          'Target path is not within any writable workspace boundary.'
        );
      }

      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        'Target path is outside all permitted workspace boundaries.'
      );
    }

    if (request.baseArea && canonicalBoundary.area !== request.baseArea) {
      if (mode === 'write') {
        throw new SandboxError(
          'SANDBOX_WRITE_DENIED',
          `Write access outside requested baseArea "${request.baseArea}" is forbidden.`
        );
      }
      throw new SandboxError(
        'SANDBOX_PATH_ESCAPE',
        `Access outside requested baseArea "${request.baseArea}" is forbidden.`
      );
    }

    if (canonicalBoundary.area === 'run_shared') {
      if (mode === 'write' && !allowSharedWrite) {
        throw new SandboxError(
          'SANDBOX_WRITE_DENIED',
          'Write access to run shared artifacts is not enabled by policy.'
        );
      }
    }

    if (canonicalBoundary.area === 'read_only_mount') {
      if (mode === 'write') {
        throw new SandboxError(
          'SANDBOX_WRITE_DENIED',
          'Write access to a read-only mount is forbidden.'
        );
      }
    }

    return canonicalBoundary;
  }
}

