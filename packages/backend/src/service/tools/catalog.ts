import type { ToolDescriptor } from '@open-employee/contracts/contracts/tool';
import {
  normalizeToolDescriptor,
  validateToolInput,
  type ToolDescriptorIssue,
  type ToolInputValidation
} from './descriptor';

export type ToolCatalogErrorCode =
  | 'INVALID_DESCRIPTOR'
  | 'DUPLICATE_TOOL'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_MISMATCH'
  | 'INVALID_TOOL_INPUT';

export class ToolCatalogError extends Error {
  constructor(
    public readonly code: ToolCatalogErrorCode,
    message: string,
    public readonly issues: ToolDescriptorIssue[] = []
  ) {
    super(message);
    this.name = 'ToolCatalogError';
  }
}

export type ToolCatalogValidation =
  | { ok: true; tools: ToolDescriptor[] }
  | { ok: false; issues: ToolCatalogError[] };

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export class ToolCatalog {
  private tools = new Map<string, ToolDescriptor>();

  public replaceAll(inputs: readonly unknown[]): ToolDescriptor[] {
    const next = new Map<string, ToolDescriptor>();
    const normalizedDescriptors: ToolDescriptor[] = [];

    for (let index = 0; index < inputs.length; index += 1) {
      const normalized = normalizeToolDescriptor(inputs[index]);
      if (!normalized.ok) {
        throw new ToolCatalogError(
          'INVALID_DESCRIPTOR',
          'Tool descriptor is invalid.',
          normalized.issues
        );
      }

      if (next.has(normalized.descriptor.name)) {
        throw new ToolCatalogError(
          'DUPLICATE_TOOL',
          `Tool "${normalized.descriptor.name}" is already registered.`
        );
      }

      next.set(normalized.descriptor.name, normalized.descriptor);
      normalizedDescriptors.push(normalized.descriptor);
    }

    this.tools = next;
    return normalizedDescriptors;
  }

  public register(input: unknown): ToolDescriptor {
    const normalized = normalizeToolDescriptor(input);
    if (!normalized.ok) {
      throw new ToolCatalogError(
        'INVALID_DESCRIPTOR',
        'Tool descriptor is invalid.',
        normalized.issues
      );
    }

    if (this.tools.has(normalized.descriptor.name)) {
      throw new ToolCatalogError(
        'DUPLICATE_TOOL',
        `Tool "${normalized.descriptor.name}" is already registered.`
      );
    }

    this.tools.set(normalized.descriptor.name, normalized.descriptor);
    return normalized.descriptor;
  }

  public get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  public require(name: string): ToolDescriptor {
    const descriptor = this.get(name);
    if (!descriptor) {
      throw new ToolCatalogError(
        'TOOL_NOT_FOUND',
        `Tool "${name}" is not registered.`
      );
    }
    return descriptor;
  }

  public list(): ToolDescriptor[] {
    return [...this.tools.values()].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
  }

  public validateRequestTools(
    tools: readonly ToolDescriptor[] | undefined
  ): ToolCatalogValidation {
    if (!tools || tools.length === 0) {
      return { ok: true, tools: [] };
    }

    const issues: ToolCatalogError[] = [];
    const resolved: ToolDescriptor[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < tools.length; index += 1) {
      const normalized = normalizeToolDescriptor(tools[index]);
      if (!normalized.ok) {
        issues.push(
          new ToolCatalogError(
            'INVALID_DESCRIPTOR',
            'Tool descriptor is invalid.',
            normalized.issues
          )
        );
        continue;
      }

      const name = normalized.descriptor.name;
      if (seen.has(name)) {
        issues.push(
          new ToolCatalogError(
            'DUPLICATE_TOOL',
            `Tool "${name}" appears more than once.`
          )
        );
        continue;
      }
      seen.add(name);

      const registered = this.tools.get(name);
      if (!registered) {
        issues.push(
          new ToolCatalogError(
            'TOOL_NOT_FOUND',
            `Tool "${name}" is not registered.`
          )
        );
        continue;
      }

      if (
        stableStringify(registered) !== stableStringify(normalized.descriptor)
      ) {
        issues.push(
          new ToolCatalogError(
            'TOOL_MISMATCH',
            `Tool "${name}" does not match the registered descriptor.`
          )
        );
        continue;
      }

      resolved.push(registered);
    }

    return issues.length === 0
      ? { ok: true, tools: resolved }
      : { ok: false, issues };
  }

  public validateInput(name: string, input: unknown): ToolInputValidation {
    const descriptor = this.require(name);
    return validateToolInput(descriptor, input);
  }
}
