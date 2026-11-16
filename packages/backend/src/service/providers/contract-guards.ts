import {
  PROVIDER_ERROR_CODES,
  PROVIDER_KINDS,
  type ModelInfo,
  type ProviderCapabilities,
  type ProviderConfig,
  type ProviderError,
  type ProviderEvent,
  type ProviderMessage,
  type TurnRequest,
  type UsageMetadata
} from '@open-employee/contracts/contracts/provider';
import {
  TOOL_RISKS,
  type ToolCall,
  type ToolDescriptor
} from '@open-employee/contracts/contracts/tool';

export type ContractIssueCode =
  | 'INVALID_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_VALUE';

export interface ContractIssue {
  code: ContractIssueCode;
  path: string;
  message: string;
}

export type ContractValidation<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ContractIssue[] };

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid<T>(path: string, message: string, code: ContractIssueCode = 'INVALID_TYPE'): ContractValidation<T> {
  return { ok: false, issues: [{ code, path, message }] };
}

function unknownFields(
  value: RecordValue,
  allowed: readonly string[],
  path: string,
  issues: ContractIssue[]
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      issues.push({
        code: 'UNKNOWN_FIELD',
        path: `${path}.${key}`,
        message: `Unknown field "${key}".`
      });
    }
  }
}

function readString(
  value: RecordValue,
  key: string,
  path: string,
  issues: ContractIssue[],
  options: { required?: boolean; allowEmpty?: boolean; maxLength?: number } = {}
): string | null {
  const fieldPath = `${path}.${key}`;
  const field = value[key];
  const required = options.required ?? true;

  if (field === undefined) {
    if (required) {
      issues.push({ code: 'MISSING_FIELD', path: fieldPath, message: `Missing field "${key}".` });
    }
    return null;
  }

  if (typeof field !== 'string') {
    issues.push({ code: 'INVALID_TYPE', path: fieldPath, message: `"${key}" must be a string.` });
    return null;
  }

  if (!options.allowEmpty && field.trim() === '') {
    issues.push({ code: 'INVALID_VALUE', path: fieldPath, message: `"${key}" must not be empty.` });
    return null;
  }

  if (options.maxLength !== undefined && field.length > options.maxLength) {
    issues.push({ code: 'INVALID_VALUE', path: fieldPath, message: `"${key}" is too long.` });
    return null;
  }

  return field;
}

function readNumber(
  value: RecordValue,
  key: string,
  path: string,
  issues: ContractIssue[],
  options: { required?: boolean; integer?: boolean; min?: number; max?: number } = {}
): number | null {
  const fieldPath = `${path}.${key}`;
  const field = value[key];
  const required = options.required ?? true;

  if (field === undefined) {
    if (required) {
      issues.push({ code: 'MISSING_FIELD', path: fieldPath, message: `Missing field "${key}".` });
    }
    return null;
  }

  if (typeof field !== 'number' || !Number.isFinite(field)) {
    issues.push({ code: 'INVALID_TYPE', path: fieldPath, message: `"${key}" must be a number.` });
    return null;
  }

  if (options.integer && !Number.isInteger(field)) {
    issues.push({ code: 'INVALID_VALUE', path: fieldPath, message: `"${key}" must be an integer.` });
    return null;
  }

  if (options.min !== undefined && field < options.min) {
    issues.push({ code: 'INVALID_VALUE', path: fieldPath, message: `"${key}" is below the minimum.` });
    return null;
  }

  if (options.max !== undefined && field > options.max) {
    issues.push({ code: 'INVALID_VALUE', path: fieldPath, message: `"${key}" is above the maximum.` });
    return null;
  }

  return field;
}

function readBoolean(
  value: RecordValue,
  key: string,
  path: string,
  issues: ContractIssue[],
  required = true
): boolean | null {
  const fieldPath = `${path}.${key}`;
  const field = value[key];

  if (field === undefined) {
    if (required) {
      issues.push({ code: 'MISSING_FIELD', path: fieldPath, message: `Missing field "${key}".` });
    }
    return null;
  }

  if (typeof field !== 'boolean') {
    issues.push({ code: 'INVALID_TYPE', path: fieldPath, message: `"${key}" must be a boolean.` });
    return null;
  }

  return field;
}

function readRecord(
  value: RecordValue,
  key: string,
  path: string,
  issues: ContractIssue[],
  required = true
): RecordValue | null {
  const fieldPath = `${path}.${key}`;
  const field = value[key];

  if (field === undefined) {
    if (required) {
      issues.push({ code: 'MISSING_FIELD', path: fieldPath, message: `Missing field "${key}".` });
    }
    return null;
  }

  if (!isRecord(field)) {
    issues.push({ code: 'INVALID_TYPE', path: fieldPath, message: `"${key}" must be an object.` });
    return null;
  }

  return field;
}

function readStringMap(
  value: RecordValue,
  key: string,
  path: string,
  issues: ContractIssue[],
  required = true
): Record<string, string> | null {
  const fieldPath = `${path}.${key}`;
  const field = value[key];

  if (field === undefined) {
    if (required) {
      issues.push({ code: 'MISSING_FIELD', path: fieldPath, message: `Missing field "${key}".` });
    }
    return null;
  }

  if (!isRecord(field)) {
    issues.push({ code: 'INVALID_TYPE', path: fieldPath, message: `"${key}" must be an object.` });
    return null;
  }

  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(field)) {
    if (typeof entryValue !== 'string') {
      issues.push({
        code: 'INVALID_TYPE',
        path: `${fieldPath}.${entryKey}`,
        message: 'Map values must be strings.'
      });
    } else {
      result[entryKey] = entryValue;
    }
  }

  return result;
}

function finish<T>(value: unknown, issues: ContractIssue[]): ContractValidation<T> {
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: value as T };
}

export function validateProviderCapabilities(
  value: unknown,
  path = 'capabilities'
): ContractValidation<ProviderCapabilities> {
  if (!isRecord(value)) return invalid(path, 'Capabilities must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    ['text', 'tools', 'streaming', 'images', 'jsonMode', 'sessions'],
    path,
    issues
  );

  for (const key of ['text', 'tools', 'streaming', 'images', 'jsonMode', 'sessions']) {
    readBoolean(value, key, path, issues);
  }

  return finish<ProviderCapabilities>(value, issues);
}

export function validateModelInfo(
  value: unknown,
  path = 'model'
): ContractValidation<ModelInfo> {
  if (!isRecord(value)) return invalid(path, 'Model info must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    [
      'providerId',
      'modelId',
      'displayName',
      'capabilities',
      'contextWindow',
      'maxOutputTokens',
      'inputCostPerMillionUsd',
      'outputCostPerMillionUsd'
    ],
    path,
    issues
  );

  readString(value, 'providerId', path, issues);
  readString(value, 'modelId', path, issues);
  readString(value, 'displayName', path, issues, { required: false, maxLength: 256 });
  const capabilities = value['capabilities'];
  if (capabilities !== undefined) {
    const result = validateProviderCapabilities(capabilities, `${path}.capabilities`);
    if (!result.ok) issues.push(...result.issues);
  } else {
    issues.push({
      code: 'MISSING_FIELD',
      path: `${path}.capabilities`,
      message: 'Missing field "capabilities".'
    });
  }
  readNumber(value, 'contextWindow', path, issues, { required: false, integer: true, min: 1 });
  readNumber(value, 'maxOutputTokens', path, issues, { required: false, integer: true, min: 1 });
  readNumber(value, 'inputCostPerMillionUsd', path, issues, { required: false, min: 0 });
  readNumber(value, 'outputCostPerMillionUsd', path, issues, { required: false, min: 0 });

  return finish<ModelInfo>(value, issues);
}

export function validateProviderConfig(
  value: unknown,
  path = 'config'
): ContractValidation<ProviderConfig> {
  if (!isRecord(value)) return invalid(path, 'Provider config must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    [
      'id',
      'kind',
      'baseUrl',
      'model',
      'credentialRef',
      'timeoutMs',
      'maxRetries',
      'streamIdleTimeoutMs'
    ],
    path,
    issues
  );

  readString(value, 'id', path, issues);
  const kind = readString(value, 'kind', path, issues);
  if (kind !== null && !PROVIDER_KINDS.includes(kind as (typeof PROVIDER_KINDS)[number])) {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.kind`, message: 'Unsupported provider kind.' });
  }
  const baseUrl = readString(value, 'baseUrl', path, issues);
  if (baseUrl !== null) {
    try {
      const parsed = new URL(baseUrl);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username !== '' ||
        parsed.password !== ''
      ) {
        issues.push({
          code: 'INVALID_VALUE',
          path: `${path}.baseUrl`,
          message: 'baseUrl must be HTTP(S) without embedded credentials.'
        });
      }
    } catch {
      issues.push({
        code: 'INVALID_VALUE',
        path: `${path}.baseUrl`,
        message: 'baseUrl is not a valid URL.'
      });
    }
  }
  readString(value, 'model', path, issues);
  readString(value, 'credentialRef', path, issues);
  readNumber(value, 'timeoutMs', path, issues, { integer: true, min: 1 });
  readNumber(value, 'maxRetries', path, issues, { integer: true, min: 0, max: 2 });
  readNumber(value, 'streamIdleTimeoutMs', path, issues, { integer: true, min: 1 });

  return finish<ProviderConfig>(value, issues);
}

export function validateUsageMetadata(
  value: unknown,
  path = 'usage'
): ContractValidation<UsageMetadata> {
  if (!isRecord(value)) return invalid(path, 'Usage metadata must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cachedInputTokens',
      'reasoningTokens'
    ],
    path,
    issues
  );

  const tokenFields = [
    ['inputTokens', true],
    ['outputTokens', true],
    ['totalTokens', true],
    ['cachedInputTokens', false],
    ['reasoningTokens', false]
  ] as const;

  for (const [key, required] of tokenFields) {
    const fieldPath = `${path}.${key}`;
    const field = value[key];

    if (field === undefined) {
      if (required) {
        issues.push({ code: 'MISSING_FIELD', path: fieldPath, message: `Missing field "${key}".` });
      }
      continue;
    }

    if (field === null) continue;

    if (typeof field !== 'number' || !Number.isInteger(field) || field < 0) {
      issues.push({
        code: typeof field === 'number' ? 'INVALID_VALUE' : 'INVALID_TYPE',
        path: fieldPath,
        message: `"${key}" must be a non-negative integer or null.`
      });
    }
  }

  return finish<UsageMetadata>(value, issues);
}

export function validateProviderError(
  value: unknown,
  path = 'error'
): ContractValidation<ProviderError> {
  if (!isRecord(value)) return invalid(path, 'Provider error must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    [
      'code',
      'message',
      'retryable',
      'providerStatus',
      'providerCode',
      'retryAfterMs',
      'requestId'
    ],
    path,
    issues
  );

  const code = readString(value, 'code', path, issues);
  if (code !== null && !PROVIDER_ERROR_CODES.includes(code as (typeof PROVIDER_ERROR_CODES)[number])) {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.code`, message: 'Unsupported provider error code.' });
  }
  readString(value, 'message', path, issues, { maxLength: 2000 });
  readBoolean(value, 'retryable', path, issues);
  readNumber(value, 'providerStatus', path, issues, { required: false, integer: true, min: 100, max: 599 });
  readString(value, 'providerCode', path, issues, { required: false, maxLength: 256 });
  readNumber(value, 'retryAfterMs', path, issues, { required: false, integer: true, min: 0 });
  readString(value, 'requestId', path, issues, { required: false, maxLength: 256 });

  return finish<ProviderError>(value, issues);
}

export function validateToolDescriptor(
  value: unknown,
  path = 'tool'
): ContractValidation<ToolDescriptor> {
  if (!isRecord(value)) return invalid(path, 'Tool descriptor must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    ['name', 'description', 'inputSchema', 'risk', 'idempotent', 'timeoutMs'],
    path,
    issues
  );

  const name = readString(value, 'name', path, issues);
  if (name !== null && !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.name`, message: 'Invalid tool name.' });
  }
  readString(value, 'description', path, issues, { maxLength: 2000 });
  readRecord(value, 'inputSchema', path, issues);
  const risk = readString(value, 'risk', path, issues);
  if (risk !== null && !TOOL_RISKS.includes(risk as (typeof TOOL_RISKS)[number])) {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.risk`, message: 'Unsupported tool risk.' });
  }
  readBoolean(value, 'idempotent', path, issues);
  readNumber(value, 'timeoutMs', path, issues, { required: false, integer: true, min: 1 });

  return finish<ToolDescriptor>(value, issues);
}

export function validateToolCall(
  value: unknown,
  path = 'toolCall'
): ContractValidation<ToolCall> {
  if (!isRecord(value)) return invalid(path, 'Tool call must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(value, ['id', 'name', 'arguments', 'rawArguments'], path, issues);

  readString(value, 'id', path, issues);
  const name = readString(value, 'name', path, issues);
  if (name !== null && !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.name`, message: 'Invalid tool name.' });
  }
  readRecord(value, 'arguments', path, issues);
  readString(value, 'rawArguments', path, issues, { required: false, maxLength: 100_000 });

  return finish<ToolCall>(value, issues);
}

export function validateProviderMessage(
  value: unknown,
  path = 'message'
): ContractValidation<ProviderMessage> {
  if (!isRecord(value)) return invalid(path, 'Provider message must be an object.');

  const issues: ContractIssue[] = [];
  const role = readString(value, 'role', path, issues);

  if (role === null) return finish<ProviderMessage>(value, issues);

  if (role === 'user') {
    unknownFields(value, ['role', 'content'], path, issues);
    readString(value, 'content', path, issues, { allowEmpty: true });
  } else if (role === 'assistant') {
    unknownFields(value, ['role', 'content', 'toolCalls'], path, issues);
    readString(value, 'content', path, issues, { allowEmpty: true });
    const toolCalls = value['toolCalls'];
    if (toolCalls !== undefined) {
      if (!Array.isArray(toolCalls)) {
        issues.push({
          code: 'INVALID_TYPE',
          path: `${path}.toolCalls`,
          message: 'toolCalls must be an array.'
        });
      } else {
        toolCalls.forEach((call, index) => {
          const result = validateToolCall(call, `${path}.toolCalls[${index}]`);
          if (!result.ok) issues.push(...result.issues);
        });
      }
    }
  } else if (role === 'tool') {
    unknownFields(value, ['role', 'toolCallId', 'content', 'isError'], path, issues);
    readString(value, 'toolCallId', path, issues);
    readString(value, 'content', path, issues, { allowEmpty: true });
    readBoolean(value, 'isError', path, issues, false);
  } else {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.role`, message: 'Unsupported message role.' });
  }

  return finish<ProviderMessage>(value, issues);
}

export function validateTurnRequest(
  value: unknown,
  path = 'request'
): ContractValidation<TurnRequest> {
  if (!isRecord(value)) return invalid(path, 'Turn request must be an object.');

  const issues: ContractIssue[] = [];
  unknownFields(
    value,
    [
      'turnId',
      'providerId',
      'model',
      'systemPrompt',
      'messages',
      'tools',
      'toolChoice',
      'temperature',
      'maxOutputTokens',
      'responseFormat',
      'metadata',
      'timeoutMs'
    ],
    path,
    issues
  );

  readString(value, 'turnId', path, issues);
  readString(value, 'providerId', path, issues);
  readString(value, 'model', path, issues);
  readString(value, 'systemPrompt', path, issues, { required: false, allowEmpty: true, maxLength: 200_000 });

  const messages = value['messages'];
  if (!Array.isArray(messages)) {
    issues.push({
      code: messages === undefined ? 'MISSING_FIELD' : 'INVALID_TYPE',
      path: `${path}.messages`,
      message: 'messages must be an array.'
    });
  } else {
    messages.forEach((message, index) => {
      const result = validateProviderMessage(message, `${path}.messages[${index}]`);
      if (!result.ok) issues.push(...result.issues);
    });
  }

  const tools = value['tools'];
  if (tools !== undefined) {
    if (!Array.isArray(tools)) {
      issues.push({ code: 'INVALID_TYPE', path: `${path}.tools`, message: 'tools must be an array.' });
    } else {
      tools.forEach((tool, index) => {
        const result = validateToolDescriptor(tool, `${path}.tools[${index}]`);
        if (!result.ok) issues.push(...result.issues);
      });
    }
  }

  const toolChoice = value['toolChoice'];
  if (toolChoice !== undefined) {
    if (typeof toolChoice === 'string') {
      if (!['auto', 'none', 'required'].includes(toolChoice)) {
        issues.push({
          code: 'INVALID_VALUE',
          path: `${path}.toolChoice`,
          message: 'Unsupported toolChoice.'
        });
      }
    } else if (isRecord(toolChoice)) {
      unknownFields(toolChoice, ['name'], `${path}.toolChoice`, issues);
      readString(toolChoice, 'name', `${path}.toolChoice`, issues);
    } else {
      issues.push({
        code: 'INVALID_TYPE',
        path: `${path}.toolChoice`,
        message: 'toolChoice must be a string or object.'
      });
    }
  }

  readNumber(value, 'temperature', path, issues, { required: false, min: 0, max: 2 });
  readNumber(value, 'maxOutputTokens', path, issues, { required: false, integer: true, min: 1 });
  const responseFormat = readString(value, 'responseFormat', path, issues, { required: false });
  if (responseFormat !== null && !['text', 'json'].includes(responseFormat)) {
    issues.push({
      code: 'INVALID_VALUE',
      path: `${path}.responseFormat`,
      message: 'responseFormat must be text or json.'
    });
  }
  readStringMap(value, 'metadata', path, issues, false);
  readNumber(value, 'timeoutMs', path, issues, { required: false, integer: true, min: 1 });

  return finish<TurnRequest>(value, issues);
}

const FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'cancelled',
  'error'
]);

export function validateProviderEvent(
  value: unknown,
  path = 'event'
): ContractValidation<ProviderEvent> {
  if (!isRecord(value)) return invalid(path, 'Provider event must be an object.');

  const issues: ContractIssue[] = [];
  const type = readString(value, 'type', path, issues);
  if (type === null) return finish<ProviderEvent>(value, issues);

  if (type === 'text_delta') {
    unknownFields(value, ['type', 'text'], path, issues);
    readString(value, 'text', path, issues, { allowEmpty: true });
  } else if (type === 'tool_call_delta') {
    unknownFields(value, ['type', 'index', 'id', 'name', 'argumentsDelta'], path, issues);
    readNumber(value, 'index', path, issues, { integer: true, min: 0 });
    readString(value, 'id', path, issues, { required: false });
    readString(value, 'name', path, issues, { required: false });
    readString(value, 'argumentsDelta', path, issues, { required: false, allowEmpty: true });
  } else if (type === 'tool_call') {
    unknownFields(value, ['type', 'call'], path, issues);
    const call = value['call'];
    if (call === undefined) {
      issues.push({ code: 'MISSING_FIELD', path: `${path}.call`, message: 'Missing field "call".' });
    } else {
      const result = validateToolCall(call, `${path}.call`);
      if (!result.ok) issues.push(...result.issues);
    }
  } else if (type === 'usage') {
    unknownFields(value, ['type', 'usage'], path, issues);
    const usage = value['usage'];
    if (usage === undefined) {
      issues.push({ code: 'MISSING_FIELD', path: `${path}.usage`, message: 'Missing field "usage".' });
    } else {
      const result = validateUsageMetadata(usage, `${path}.usage`);
      if (!result.ok) issues.push(...result.issues);
    }
  } else if (type === 'finish') {
    unknownFields(value, ['type', 'reason', 'usage'], path, issues);
    const reason = readString(value, 'reason', path, issues);
    if (reason !== null && !FINISH_REASONS.has(reason)) {
      issues.push({ code: 'INVALID_VALUE', path: `${path}.reason`, message: 'Unsupported finish reason.' });
    }
    const usage = value['usage'];
    if (usage !== undefined) {
      const result = validateUsageMetadata(usage, `${path}.usage`);
      if (!result.ok) issues.push(...result.issues);
    }
  } else if (type === 'error') {
    unknownFields(value, ['type', 'error'], path, issues);
    const error = value['error'];
    if (error === undefined) {
      issues.push({ code: 'MISSING_FIELD', path: `${path}.error`, message: 'Missing field "error".' });
    } else {
      const result = validateProviderError(error, `${path}.error`);
      if (!result.ok) issues.push(...result.issues);
    }
  } else {
    issues.push({ code: 'INVALID_VALUE', path: `${path}.type`, message: 'Unsupported provider event type.' });
  }

  return finish<ProviderEvent>(value, issues);
}
