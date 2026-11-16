import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { getDataLayoutPaths } from '../core/data-root';

export const MAX_MARKDOWN_INSTRUCTIONS_CHARS = 32_000;

function sanitizeEntityId(entityId: string): string {
  const trimmed = (entityId || '').trim();
  if (!trimmed || /[/\\]|\.\./.test(trimmed)) {
    throw new Error(`Invalid entity id for markdown instructions: "${entityId}"`);
  }
  return trimmed;
}

function readBoundedMarkdown(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (!raw) return undefined;
  return raw.length > MAX_MARKDOWN_INSTRUCTIONS_CHARS
    ? raw.slice(0, MAX_MARKDOWN_INSTRUCTIONS_CHARS)
    : raw;
}

function writeMarkdown(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf-8');
}

/**
 * Loads per-agent standing instructions from `.data/state/agents/<agentId>/AGENTS.md`.
 */
export function loadAgentInstructionsMarkdown(agentId: string, dataRoot?: string): string | undefined {
  const safeId = sanitizeEntityId(agentId);
  const layout = getDataLayoutPaths(dataRoot);
  return readBoundedMarkdown(resolve(layout.agentsDir, safeId, 'AGENTS.md'));
}

/**
 * Saves per-agent standing instructions to `.data/state/agents/<agentId>/AGENTS.md`.
 */
export function saveAgentInstructionsMarkdown(
  agentId: string,
  content: string,
  dataRoot?: string
): void {
  const safeId = sanitizeEntityId(agentId);
  const layout = getDataLayoutPaths(dataRoot);
  writeMarkdown(resolve(layout.agentsDir, safeId, 'AGENTS.md'), content);
}

/**
 * Loads per-channel standing instructions from `.data/state/channels/<channelId>/CHANNEL.md`.
 */
export function loadChannelInstructionsMarkdown(
  channelId: string,
  dataRoot?: string
): string | undefined {
  const safeId = sanitizeEntityId(channelId);
  const layout = getDataLayoutPaths(dataRoot);
  return readBoundedMarkdown(resolve(layout.channelsDir, safeId, 'CHANNEL.md'));
}

/**
 * Saves per-channel standing instructions to `.data/state/channels/<channelId>/CHANNEL.md`.
 */
export function saveChannelInstructionsMarkdown(
  channelId: string,
  content: string,
  dataRoot?: string
): void {
  const safeId = sanitizeEntityId(channelId);
  const layout = getDataLayoutPaths(dataRoot);
  writeMarkdown(resolve(layout.channelsDir, safeId, 'CHANNEL.md'), content);
}

export interface ComposeTurnSystemPromptInput {
  agentName: string;
  baseSystemPrompt?: string;
  agentMarkdown?: string;
  channelMarkdown?: string;
}

/**
 * Composes a model-agnostic system prompt combining base role instructions,
 * per-agent `AGENTS.md`, per-channel `CHANNEL.md`, and identity directive.
 */
export function composeTurnSystemPrompt(input: ComposeTurnSystemPromptInput): string {
  const sections: string[] = [];

  if (input.baseSystemPrompt?.trim()) {
    sections.push(input.baseSystemPrompt.trim());
  }
  if (input.agentMarkdown?.trim()) {
    sections.push(`[Agent Instructions (AGENTS.md)]\n${input.agentMarkdown.trim()}`);
  }
  if (input.channelMarkdown?.trim()) {
    sections.push(`[Channel Instructions (CHANNEL.md)]\n${input.channelMarkdown.trim()}`);
  }

  sections.push(
    `CRITICAL IDENTITY & PERSONA DIRECTIVE:\nIf asked "Kamu menggunakan AI model apa?", "Model apa yang kamu pakai?", "What AI model are you using?", or about your AI model/engine, state your Persona (${input.agentName}) and role in Employee-agent. NEVER disclose or name the underlying AI model (e.g. GPT, Claude, Gemini, OpenAI, etc.).`
  );

  return sections.join('\n\n');
}
