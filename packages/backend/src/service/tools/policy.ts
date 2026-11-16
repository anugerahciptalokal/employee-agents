import { createHash } from 'crypto';
import type { ToolDescriptor, ToolRisk } from '@open-employee/contracts/contracts/tool';
import {
  validateToolInput,
  type ToolDescriptorIssue
} from './descriptor';
import type { ToolCatalog } from './catalog';
import type { ToolRegistry } from './registry';
import {
  SandboxError,
  type ResolvedWorkspacePath,
  type WorkspacePathRequest,
  type WorkspaceSandbox
} from './sandbox';

/**
 * Phase 3 Step 2: Deterministic Tool Policy Engine & Canonical Argument Hashing.
 *
 * CANONICAL ARGUMENT HASHING RULES (`computeToolArgumentsHash`):
 * 1. Algorithm: SHA-256 hex digest over UTF-8 canonical JSON of `{ arguments, toolName }`.
 * 2. Objects: keys are sorted lexicographically by UTF-16 code units; keys with `undefined`
 *    values are rejected with `ToolPolicyError('NON_CANONICAL_ARGUMENT')`.
 * 3. Nested objects: canonicalized recursively using the same key-sorting rule.
 * 4. Arrays: element order is strictly preserved; each element is canonicalized recursively.
 * 5. Primitives: `null`, booleans, strings, and finite numbers are serialized with `JSON.stringify`
 *    (`-0` is normalized to `0`). Non-JSON values (`NaN`, `Infinity`, `-Infinity`, `bigint`,
 *    `function`, `symbol`, `undefined` anywhere) are rejected with `ToolPolicyError`.
 * 6. `policyVersion` is intentionally EXCLUDED from `arguments_hash`. `arguments_hash` represents
 *    only the canonical identity of `(toolName, normalizedArgs)`. `policyVersion` is carried as a
 *    separate field in the policy decision and approval binding metadata for Phase 3 Step 3.
 */

export type ToolPolicyDecisionKind = 'allow' | 'ask' | 'deny';

export type ToolPolicyReasonCode =
  | 'TOOL_NOT_REGISTERED'
  | 'TOOL_NOT_PERMITTED'
  | 'INVALID_ARGUMENTS'
  | 'MISSING_SANDBOX_CONTEXT'
  | 'SANDBOX_VIOLATION'
  | 'READ_ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'RISK_DEFAULT_DENY'
  | 'POLICY_DENIED'
  | 'UNSAFE_POLICY_OVERRIDE';

export interface ToolPolicyReason {
  code: ToolPolicyReasonCode;
  message: string;
  issues?: ToolDescriptorIssue[];
  sandboxCode?: string;
}

export interface ToolApprovalBindingMetadata {
  toolName: string;
  risk: ToolRisk;
  argumentsHash: string;
  policyVersion: string;
  runId?: string;
  stepId?: string;
  agentId?: string;
}

export interface ToolPolicyEvaluation {
  decision: ToolPolicyDecisionKind;
  reason: ToolPolicyReason;
  policyVersion: string;
  toolName: string;
  descriptor?: ToolDescriptor;
  argumentsHash?: string;
  resolvedPath?: ResolvedWorkspacePath;
  approvalBinding?: ToolApprovalBindingMetadata;
}

export class ToolPolicyError extends Error {
  constructor(
    public readonly code: 'INVALID_TOOL_NAME' | 'NON_CANONICAL_ARGUMENT',
    message: string
  ) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

export type NonAllowPolicyMode = 'ask' | 'deny';
export type ReadPolicyMode = 'allow' | 'ask' | 'deny';

export interface ToolPolicyContext {
  runId?: string;
  stepId?: string;
  agentId?: string;
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
  toolOverrides?: Readonly<Record<string, ToolPolicyDecisionKind>>;
  riskOverrides?: Readonly<Partial<Record<ToolRisk, ToolPolicyDecisionKind>>>;
  workspaceRequest?: WorkspacePathRequest;
}

export interface ToolPolicyEvaluateInput {
  toolName: string;
  arguments: Record<string, unknown>;
  context?: ToolPolicyContext;
}

export interface ToolPolicyEngineOptions {
  registry?: ToolRegistry;
  catalog?: ToolCatalog;
  sandbox?: WorkspaceSandbox;
  policyVersion?: string;
  defaultAllowedTools?: readonly string[];
  defaultDeniedTools?: readonly string[];
  defaultToolOverrides?: Readonly<Record<string, ToolPolicyDecisionKind>>;
  defaultRiskOverrides?: Readonly<Partial<Record<ToolRisk, ToolPolicyDecisionKind>>>;
  resolveWorkspaceRequest?: (
    descriptor: ToolDescriptor,
    args: Record<string, unknown>,
    context: ToolPolicyContext
  ) => WorkspacePathRequest | null | undefined;
}

const DEFAULT_POLICY_VERSION = 'v1';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function canonicalizeJsonValue(
  value: unknown,
  path = 'arguments',
  depth = 0
): string {
  if (depth > 64) {
    throw new ToolPolicyError(
      'NON_CANONICAL_ARGUMENT',
      `Argument nesting at "${path}" exceeds maximum depth.`
    );
  }

  if (value === null) {
    return 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ToolPolicyError(
        'NON_CANONICAL_ARGUMENT',
        `Non-finite number at "${path}" cannot be canonicalized.`
      );
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    return JSON.stringify(normalized);
  }

  if (Array.isArray(value)) {
    const items = value.map((entry, index) =>
      canonicalizeJsonValue(entry, `${path}[${index}]`, depth + 1)
    );
    return `[${items.join(',')}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );

    const pairs = keys.map((key) => {
      const propValue = value[key];
      if (propValue === undefined) {
        throw new ToolPolicyError(
          'NON_CANONICAL_ARGUMENT',
          `Undefined value at "${path}.${key}" cannot be canonicalized.`
        );
      }
      const serializedKey = JSON.stringify(key);
      const serializedValue = canonicalizeJsonValue(
        propValue,
        `${path}.${key}`,
        depth + 1
      );
      return `${serializedKey}:${serializedValue}`;
    });

    return `{${pairs.join(',')}}`;
  }

  throw new ToolPolicyError(
    'NON_CANONICAL_ARGUMENT',
    `Unsupported non-JSON value at "${path}".`
  );
}

export function computeToolArgumentsHash(
  toolName: string,
  normalizedArgs: Record<string, unknown>
): string {
  if (typeof toolName !== 'string' || !toolName.trim()) {
    throw new ToolPolicyError(
      'INVALID_TOOL_NAME',
      'toolName must be a non-empty string.'
    );
  }
  if (!isPlainObject(normalizedArgs)) {
    throw new ToolPolicyError(
      'NON_CANONICAL_ARGUMENT',
      'normalizedArgs must be a plain JSON object.'
    );
  }

  const canonicalArgs = canonicalizeJsonValue(normalizedArgs, 'arguments');
  const canonicalPayload = `{"arguments":${canonicalArgs},"toolName":${JSON.stringify(
    toolName.trim()
  )}}`;

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

export class ToolPolicyEngine {
  public readonly policyVersion: string;
  private readonly registry?: ToolRegistry;
  private readonly catalog?: ToolCatalog;
  private readonly sandbox?: WorkspaceSandbox;
  private readonly defaultAllowedTools?: ReadonlySet<string>;
  private readonly defaultDeniedTools: ReadonlySet<string>;
  private readonly defaultToolOverrides: Readonly<
    Record<string, ToolPolicyDecisionKind>
  >;
  private readonly defaultRiskOverrides: Readonly<
    Partial<Record<ToolRisk, ToolPolicyDecisionKind>>
  >;
  private readonly resolveWorkspaceRequest?: ToolPolicyEngineOptions['resolveWorkspaceRequest'];

  constructor(options: ToolPolicyEngineOptions) {
    this.registry = options.registry;
    this.catalog = options.catalog;
    this.sandbox = options.sandbox;
    this.policyVersion = options.policyVersion?.trim() || DEFAULT_POLICY_VERSION;
    this.defaultAllowedTools = options.defaultAllowedTools
      ? new Set(options.defaultAllowedTools)
      : undefined;
    this.defaultDeniedTools = new Set(options.defaultDeniedTools ?? []);
    this.defaultToolOverrides = { ...(options.defaultToolOverrides ?? {}) };
    this.defaultRiskOverrides = { ...(options.defaultRiskOverrides ?? {}) };
    this.resolveWorkspaceRequest = options.resolveWorkspaceRequest;
  }

  private lookupDescriptor(toolName: string): ToolDescriptor | undefined {
    if (this.registry) {
      return this.registry.get(toolName);
    }
    if (this.catalog) {
      return this.catalog.get(toolName);
    }
    return undefined;
  }

  public evaluate(input: ToolPolicyEvaluateInput): ToolPolicyEvaluation {
    const context = input.context ?? {};
    const toolName = typeof input.toolName === 'string' ? input.toolName.trim() : '';

    const descriptor = toolName ? this.lookupDescriptor(toolName) : undefined;
    if (!descriptor) {
      return {
        decision: 'deny',
        reason: {
          code: 'TOOL_NOT_REGISTERED',
          message: `Tool "${toolName || '<empty>'}" is not registered.`
        },
        policyVersion: this.policyVersion,
        toolName
      };
    }

    // Check explicit deny lists and allowlists for agent/run
    if (
      this.defaultDeniedTools.has(descriptor.name) ||
      context.deniedTools?.includes(descriptor.name)
    ) {
      return {
        decision: 'deny',
        reason: {
          code: 'TOOL_NOT_PERMITTED',
          message: `Tool "${descriptor.name}" is explicitly denied for this context.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor
      };
    }

    if (
      this.defaultAllowedTools &&
      !this.defaultAllowedTools.has(descriptor.name)
    ) {
      return {
        decision: 'deny',
        reason: {
          code: 'TOOL_NOT_PERMITTED',
          message: `Tool "${descriptor.name}" is not in the default allowed tool set.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor
      };
    }

    if (
      context.allowedTools &&
      !context.allowedTools.includes(descriptor.name)
    ) {
      return {
        decision: 'deny',
        reason: {
          code: 'TOOL_NOT_PERMITTED',
          message: `Tool "${descriptor.name}" is not permitted for the active run or agent.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor
      };
    }

    // Validate tool arguments against registered JSON Schema
    if (!isPlainObject(input.arguments)) {
      return {
        decision: 'deny',
        reason: {
          code: 'INVALID_ARGUMENTS',
          message: 'Tool arguments must be a JSON object.',
          issues: [{ path: 'input', message: 'Value must be an object.' }]
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor
      };
    }

    const validation = validateToolInput(descriptor, input.arguments);
    if (!validation.ok) {
      return {
        decision: 'deny',
        reason: {
          code: 'INVALID_ARGUMENTS',
          message: `Tool arguments for "${descriptor.name}" failed schema validation.`,
          issues: validation.issues
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor
      };
    }

    let argumentsHash: string;
    try {
      argumentsHash = computeToolArgumentsHash(descriptor.name, input.arguments);
    } catch (error) {
      return {
        decision: 'deny',
        reason: {
          code: 'INVALID_ARGUMENTS',
          message:
            error instanceof Error
              ? error.message
              : 'Tool arguments could not be canonicalized.'
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor
      };
    }

    const binding: ToolApprovalBindingMetadata = {
      toolName: descriptor.name,
      risk: descriptor.risk,
      argumentsHash,
      policyVersion: this.policyVersion,
      ...(context.runId ? { runId: context.runId } : {}),
      ...(context.stepId ? { stepId: context.stepId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {})
    };

    // Resolve policy override for this tool or risk class
    const requestedOverride =
      context.toolOverrides?.[descriptor.name] ??
      this.defaultToolOverrides[descriptor.name] ??
      context.riskOverrides?.[descriptor.risk] ??
      this.defaultRiskOverrides[descriptor.risk];

    if (requestedOverride === 'deny') {
      return {
        decision: 'deny',
        reason: {
          code: 'POLICY_DENIED',
          message: `Tool "${descriptor.name}" is denied by policy override.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        approvalBinding: binding
      };
    }

    // Security invariant: write, network, execute, and destructive can NEVER be auto-allowed
    if (descriptor.risk !== 'read' && requestedOverride === 'allow') {
      return {
        decision: 'deny',
        reason: {
          code: 'UNSAFE_POLICY_OVERRIDE',
          message: `Risk level "${descriptor.risk}" cannot be configured for automatic allow without approval.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        approvalBinding: binding
      };
    }

    // Sandbox verification: mandatory for all read tools (HIGH-01) and whenever workspaceRequest is present
    let workspaceRequest: WorkspacePathRequest | null = null;
    if (context.workspaceRequest !== undefined) {
      workspaceRequest = context.workspaceRequest;
    } else if (this.resolveWorkspaceRequest) {
      try {
        workspaceRequest =
          this.resolveWorkspaceRequest(descriptor, input.arguments, context) ??
          null;
      } catch (error) {
        return {
          decision: 'deny',
          reason: {
            code: 'MISSING_SANDBOX_CONTEXT',
            message:
              error instanceof Error
                ? `Workspace request resolution failed: ${error.message}`
                : 'Workspace request resolution threw an unexpected error.'
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          approvalBinding: binding
        };
      }
    }

    const isValidWorkspaceRequest =
      workspaceRequest !== null &&
      typeof workspaceRequest === 'object' &&
      typeof workspaceRequest.targetPath === 'string' &&
      (workspaceRequest.mode === 'read' || workspaceRequest.mode === 'write');

    const expectedWorkspaceMode: 'read' | 'write' | undefined =
      descriptor.risk === 'read'
        ? 'read'
        : descriptor.risk === 'write' || descriptor.risk === 'destructive'
          ? 'write'
          : undefined;

    if (descriptor.risk === 'read' && !this.sandbox) {
      return {
        decision: 'deny',
        reason: {
          code: 'MISSING_SANDBOX_CONTEXT',
          message:
            'Workspace sandbox is required for read tool policy evaluation.'
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        approvalBinding: binding
      };
    }

    if (descriptor.risk === 'read' && !isValidWorkspaceRequest) {
      return {
        decision: 'deny',
        reason: {
          code: 'MISSING_SANDBOX_CONTEXT',
          message:
            'Valid workspace path request is required for read tool policy evaluation.'
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        approvalBinding: binding
      };
    }

    let resolvedPath: ResolvedWorkspacePath | undefined;
    if (workspaceRequest !== null) {
      if (!this.sandbox) {
        return {
          decision: 'deny',
          reason: {
            code: 'MISSING_SANDBOX_CONTEXT',
            message:
              'Workspace sandbox is required for path-bound tool evaluation.'
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          approvalBinding: binding
        };
      }

      if (!isValidWorkspaceRequest) {
        return {
          decision: 'deny',
          reason: {
            code: 'MISSING_SANDBOX_CONTEXT',
            message: 'Workspace path request is invalid.'
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          approvalBinding: binding
        };
      }

      if (
        expectedWorkspaceMode !== undefined &&
        workspaceRequest.mode !== expectedWorkspaceMode
      ) {
        return {
          decision: 'deny',
          reason: {
            code: 'SANDBOX_VIOLATION',
            message: `Tool "${descriptor.name}" with risk "${descriptor.risk}" requires workspace mode "${expectedWorkspaceMode}", but received "${workspaceRequest.mode}".`
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          approvalBinding: binding
        };
      }

      try {
        resolvedPath = this.sandbox.resolveWorkspacePath(workspaceRequest);
      } catch (error) {
        const sandboxError =
          error instanceof SandboxError
            ? error
            : new SandboxError(
                'SANDBOX_PATH_ESCAPE',
                'Sandbox validation failed.'
              );
        return {
          decision: 'deny',
          reason: {
            code: 'SANDBOX_VIOLATION',
            message: sandboxError.message,
            sandboxCode: sandboxError.code
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          approvalBinding: binding
        };
      }
    }

    if (descriptor.risk === 'read') {
      if (!resolvedPath) {
        return {
          decision: 'deny',
          reason: {
            code: 'MISSING_SANDBOX_CONTEXT',
            message:
              'Read tool cannot be allowed without a validated workspace path.'
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          approvalBinding: binding
        };
      }

      if (requestedOverride === 'ask') {
        return {
          decision: 'ask',
          reason: {
            code: 'APPROVAL_REQUIRED',
            message: `Read tool "${descriptor.name}" requires approval by policy override.`
          },
          policyVersion: this.policyVersion,
          toolName: descriptor.name,
          descriptor,
          argumentsHash,
          resolvedPath,
          approvalBinding: binding
        };
      }

      return {
        decision: 'allow',
        reason: {
          code: 'READ_ALLOWED',
          message: `Read tool "${descriptor.name}" is permitted within sandbox boundaries.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        resolvedPath,
        approvalBinding: binding
      };
    }

    if (descriptor.risk === 'write' || descriptor.risk === 'network') {
      return {
        decision: 'ask',
        reason: {
          code: 'APPROVAL_REQUIRED',
          message: `Tool "${descriptor.name}" with risk "${descriptor.risk}" requires explicit user approval.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        ...(resolvedPath ? { resolvedPath } : {}),
        approvalBinding: binding
      };
    }

    // execute and destructive: default deny unless explicitly enabled with mode 'ask'
    if (requestedOverride === 'ask') {
      return {
        decision: 'ask',
        reason: {
          code: 'APPROVAL_REQUIRED',
          message: `High-risk tool "${descriptor.name}" (${descriptor.risk}) is explicitly enabled for user approval.`
        },
        policyVersion: this.policyVersion,
        toolName: descriptor.name,
        descriptor,
        argumentsHash,
        ...(resolvedPath ? { resolvedPath } : {}),
        approvalBinding: binding
      };
    }

    return {
      decision: 'deny',
      reason: {
        code: 'RISK_DEFAULT_DENY',
        message: `Tool "${descriptor.name}" with risk "${descriptor.risk}" is denied by default.`
      },
      policyVersion: this.policyVersion,
      toolName: descriptor.name,
      descriptor,
      argumentsHash,
      ...(resolvedPath ? { resolvedPath } : {}),
      approvalBinding: binding
    };
  }
}

