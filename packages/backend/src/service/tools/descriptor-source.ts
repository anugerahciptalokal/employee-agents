import type { ToolDescriptor } from '@open-employee/contracts/contracts/tool';

export interface ToolDescriptorSource {
  readonly id: string;
  listDescriptors(): readonly unknown[] | Promise<readonly unknown[]>;
}

export class StaticToolDescriptorSource implements ToolDescriptorSource {
  constructor(
    public readonly id: string,
    private readonly descriptors: readonly unknown[]
  ) {}

  public listDescriptors(): readonly unknown[] {
    return this.descriptors;
  }
}

export function createStaticToolDescriptorSource(
  id: string,
  descriptors: readonly unknown[]
): ToolDescriptorSource {
  return new StaticToolDescriptorSource(id, descriptors);
}

export type { ToolDescriptor };
