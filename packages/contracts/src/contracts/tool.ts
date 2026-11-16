export const TOOL_RISKS = [
  'read',
  'write',
  'network',
  'execute',
  'destructive'
] as const;

export type ToolRisk = (typeof TOOL_RISKS)[number];

export type JsonSchema = Record<string, unknown>;

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  idempotent: boolean;
  timeoutMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
}
