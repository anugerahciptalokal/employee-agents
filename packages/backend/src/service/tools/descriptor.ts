import type {
  JsonSchema,
  ToolDescriptor
} from '@open-employee/contracts/contracts/tool';
import { validateToolDescriptor } from '../providers/contract-guards';

export interface ToolDescriptorIssue {
  path: string;
  message: string;
}

export type ToolDescriptorValidation =
  | { ok: true; descriptor: ToolDescriptor }
  | { ok: false; issues: ToolDescriptorIssue[] };

export type ToolInputValidation =
  | { ok: true }
  | { ok: false; issues: ToolDescriptorIssue[] };

const JSON_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function schemaIssues(
  schema: unknown,
  path = 'inputSchema',
  depth = 0
): ToolDescriptorIssue[] {
  if (!isRecord(schema)) {
    return [{ path, message: 'Schema must be an object.' }];
  }
  if (depth > 32) {
    return [{ path, message: 'Schema nesting is too deep.' }];
  }

  const issues: ToolDescriptorIssue[] = [];
  const type = schema.type;
  if (type !== undefined) {
    if (typeof type === 'string') {
      if (!JSON_TYPES.has(type)) {
        issues.push({ path: `${path}.type`, message: 'Unsupported schema type.' });
      }
    } else if (Array.isArray(type)) {
      for (let index = 0; index < type.length; index += 1) {
        if (typeof type[index] !== 'string' || !JSON_TYPES.has(type[index])) {
          issues.push({
            path: `${path}.type[${index}]`,
            message: 'Unsupported schema type.'
          });
        }
      }
    } else {
      issues.push({ path: `${path}.type`, message: 'Schema type must be a string or array.' });
    }
  }

  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) {
      issues.push({
        path: `${path}.properties`,
        message: 'properties must be an object.'
      });
    } else {
      for (const [key, child] of Object.entries(schema.properties)) {
        issues.push(...schemaIssues(child, `${path}.properties.${key}`, depth + 1));
      }
    }
  }

  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((entry) => typeof entry !== 'string')
    ) {
      issues.push({
        path: `${path}.required`,
        message: 'required must be an array of strings.'
      });
    }
  }

  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    if (!isRecord(schema.additionalProperties)) {
      issues.push({
        path: `${path}.additionalProperties`,
        message: 'additionalProperties must be boolean or a schema object.'
      });
    } else {
      issues.push(
        ...schemaIssues(
          schema.additionalProperties,
          `${path}.additionalProperties`,
          depth + 1
        )
      );
    }
  }

  if (schema.items !== undefined) {
    if (!isRecord(schema.items)) {
      issues.push({ path: `${path}.items`, message: 'items must be a schema object.' });
    } else {
      issues.push(...schemaIssues(schema.items, `${path}.items`, depth + 1));
    }
  }

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (branches === undefined) continue;
    if (!Array.isArray(branches)) {
      issues.push({ path: `${path}.${key}`, message: `${key} must be an array.` });
      continue;
    }
    for (let index = 0; index < branches.length; index += 1) {
      issues.push(
        ...schemaIssues(branches[index], `${path}.${key}[${index}]`, depth + 1)
      );
    }
  }

  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    issues.push({ path: `${path}.enum`, message: 'enum must be an array.' });
  }

  return issues;
}

function cloneDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  return JSON.parse(JSON.stringify(descriptor)) as ToolDescriptor;
}

export function normalizeToolDescriptor(input: unknown): ToolDescriptorValidation {
  const validation = validateToolDescriptor(input);
  if (!validation.ok) {
    return {
      ok: false,
      issues: validation.issues.map((issue) => ({
        path: issue.path,
        message: issue.message
      }))
    };
  }

  const descriptor = validation.value;
  const schemaProblems = schemaIssues(descriptor.inputSchema);
  if (schemaProblems.length > 0) {
    return { ok: false, issues: schemaProblems };
  }

  return { ok: true, descriptor: cloneDescriptor(descriptor) };
}

function matchesEnum(value: unknown, values: unknown[]): boolean {
  return values.some((entry) => {
    if (entry === value) return true;
    try {
      return JSON.stringify(entry) === JSON.stringify(value);
    } catch {
      return false;
    }
  });
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  depth = 0
): ToolDescriptorIssue[] {
  if (depth > 32) {
    return [{ path, message: 'Value nesting is too deep.' }];
  }

  const issues: ToolDescriptorIssue[] = [];
  if (Array.isArray(schema.enum) && !matchesEnum(value, schema.enum)) {
    issues.push({ path, message: 'Value is not in the allowed enum.' });
  }

  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const matched = anyOf.some(
      (branch) =>
        isRecord(branch) &&
        validateValue(branch, value, path, depth + 1).length === 0
    );
    if (!matched) {
      issues.push({ path, message: 'Value does not match any allowed schema.' });
    }
  }

  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter(
      (branch) =>
        isRecord(branch) &&
        validateValue(branch, value, path, depth + 1).length === 0
    );
    if (matches.length !== 1) {
      issues.push({ path, message: 'Value must match exactly one schema.' });
    }
  }

  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      if (isRecord(branch)) {
        issues.push(...validateValue(branch, value, path, depth + 1));
      }
    }
  }

  const type = schema.type;
  if (typeof type === 'string') {
    if (!validateType(type, value, path, issues)) {
      return issues;
    }
  } else if (Array.isArray(type)) {
    const matched = type.some(
      (entry) =>
        typeof entry === 'string' &&
        validateType(entry, value, path, [])
    );
    if (!matched) {
      issues.push({ path, message: 'Value does not match an allowed type.' });
    }
    return issues;
  }

  if (issues.length > 0) return issues;

  if (isRecord(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];
    for (const key of required) {
      if (!(key in value)) {
        issues.push({ path: `${path}.${key}`, message: 'Required field is missing.' });
      }
    }

    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in value && isRecord(child)) {
        issues.push(
          ...validateValue(child, value[key], `${path}.${key}`, depth + 1)
        );
      }
    }

    for (const key of Object.keys(value)) {
      if (key in properties) continue;
      if (schema.additionalProperties === false) {
        issues.push({
          path: `${path}.${key}`,
          message: 'Additional field is not allowed.'
        });
      } else if (isRecord(schema.additionalProperties)) {
        issues.push(
          ...validateValue(
            schema.additionalProperties,
            value[key],
            `${path}.${key}`,
            depth + 1
          )
        );
      }
    }
  }

  if (
    Array.isArray(value) &&
    isRecord(schema.items)
  ) {
    for (let index = 0; index < value.length; index += 1) {
      issues.push(
        ...validateValue(
          schema.items,
          value[index],
          `${path}[${index}]`,
          depth + 1
        )
      );
    }
  }

  return issues;
}

function validateType(
  type: string,
  value: unknown,
  path: string,
  issues: ToolDescriptorIssue[]
): boolean {
  if (type === 'object') {
    if (!isRecord(value)) {
      issues.push({ path, message: 'Value must be an object.' });
      return false;
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ path, message: 'Value must be an array.' });
      return false;
    }
  } else if (type === 'string') {
    if (typeof value !== 'string') {
      issues.push({ path, message: 'Value must be a string.' });
      return false;
    }
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      issues.push({ path, message: 'Value must be a number.' });
      return false;
    }
  } else if (type === 'integer') {
    if (!Number.isInteger(value)) {
      issues.push({ path, message: 'Value must be an integer.' });
      return false;
    }
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      issues.push({ path, message: 'Value must be a boolean.' });
      return false;
    }
  } else if (type === 'null') {
    if (value !== null) {
      issues.push({ path, message: 'Value must be null.' });
      return false;
    }
  }

  if (type === 'object' && isRecord(value)) {
    // Object property validation is handled by the caller after type checks.
    return true;
  }
  if (type === 'array' && Array.isArray(value)) {
    // Array item validation is handled by the caller after type checks.
    return true;
  }

  return issues.length === 0;
}

export function validateToolInput(
  descriptor: ToolDescriptor,
  input: unknown
): ToolInputValidation {
  const issues = validateValue(descriptor.inputSchema, input, 'input');
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}
