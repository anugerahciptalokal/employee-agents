import type { ToolDescriptor } from '@open-employee/contracts/contracts/tool';
import { ToolCatalog } from './catalog';
import {
  normalizeToolDescriptor,
  type ToolDescriptorValidation
} from './descriptor';
import type { ToolDescriptorSource } from './descriptor-source';

export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();

  public register(input: unknown): ToolDescriptor {
    const normalized = normalizeToolDescriptor(input);
    if (!normalized.ok) {
      throw new ToolRegistryError(
        'INVALID_DESCRIPTOR',
        'Tool descriptor is invalid.',
        normalized
      );
    }

    if (this.tools.has(normalized.descriptor.name)) {
      throw new ToolRegistryError(
        'DUPLICATE_TOOL',
        `Tool "${normalized.descriptor.name}" is already registered.`
      );
    }

    this.tools.set(normalized.descriptor.name, normalized.descriptor);
    return normalized.descriptor;
  }

  public async registerSource(
    source: ToolDescriptorSource
  ): Promise<ToolDescriptor[]> {
    const descriptors = await source.listDescriptors();
    const staged = new Map(this.tools);
    const added: ToolDescriptor[] = [];

    for (let index = 0; index < descriptors.length; index += 1) {
      const normalized = normalizeToolDescriptor(descriptors[index]);
      if (!normalized.ok) {
        throw new ToolRegistryError(
          'INVALID_DESCRIPTOR',
          'Tool descriptor is invalid.',
          normalized
        );
      }

      if (staged.has(normalized.descriptor.name)) {
        throw new ToolRegistryError(
          'DUPLICATE_TOOL',
          `Tool "${normalized.descriptor.name}" is already registered.`
        );
      }

      staged.set(normalized.descriptor.name, normalized.descriptor);
      added.push(normalized.descriptor);
    }

    this.tools = staged;
    return added;
  }

  public get(name: string): ToolDescriptor | undefined {
    return this.tools.get(name);
  }

  public require(name: string): ToolDescriptor {
    const descriptor = this.get(name);
    if (!descriptor) {
      throw new ToolRegistryError(
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

  public snapshot(): ToolDescriptor[] {
    return this.list().map((descriptor) => {
      const normalized = normalizeToolDescriptor(descriptor);
      if (!normalized.ok) {
        throw new ToolRegistryError(
          'INVALID_DESCRIPTOR',
          'Tool descriptor is invalid.',
          normalized
        );
      }
      return normalized.descriptor;
    });
  }

  public toCatalog(): ToolCatalog {
    const catalog = new ToolCatalog();
    catalog.replaceAll(this.snapshot());
    return catalog;
  }
}

export class ToolRegistryError extends Error {
  constructor(
    public readonly code: 'INVALID_DESCRIPTOR' | 'DUPLICATE_TOOL' | 'TOOL_NOT_FOUND',
    message: string,
    public readonly validation?: ToolDescriptorValidation
  ) {
    super(message);
    this.name = 'ToolRegistryError';
  }
}
