import type { Message } from '@open-employee/contracts/types';

export const MAX_CHANNEL_CONTEXT_CHARACTERS = 200_000;
export const CHARS_PER_TOKEN = 4;
export const TRANSCRIPT_SHARE = 0.25;
export const REPEATED_ASSIGNMENT_CHARACTERS = 2_000;

export interface ChannelContextPacketInput {
  assignment: string;
  summary?: string;
  messages: Message[];
  maxCharacters?: number;
  contextWindowTokens?: number;
}

export interface ChannelContextPacket {
  promptText: string;
  totalCharacters: number;
  budgetCharacters: number;
  includedMessageIds: string[];
  omittedMessageCount: number;
}

/**
 * Resolves the effective character budget for a channel context packet.
 * Caps at `MAX_CHANNEL_CONTEXT_CHARACTERS` (200,000) and scales down to ~50%
 * of a model's context window when a smaller `contextWindowTokens` is specified.
 */
export function resolveEffectiveContextBudget(contextWindowTokens?: number): number {
  if (typeof contextWindowTokens === 'number' && contextWindowTokens > 0) {
    const scaled = Math.floor(contextWindowTokens * 0.5 * CHARS_PER_TOKEN);
    return Math.max(4_000, Math.min(MAX_CHANNEL_CONTEXT_CHARACTERS, scaled));
  }
  return MAX_CHANNEL_CONTEXT_CHARACTERS;
}

/**
 * Builds a bounded channel context packet prioritizing:
 * 1) Current assignment, 2) Background channel summary, 3) Newest transcript messages.
 */
export function buildChannelContextPacket(input: ChannelContextPacketInput): ChannelContextPacket {
  const budget = Math.min(
    MAX_CHANNEL_CONTEXT_CHARACTERS,
    input.maxCharacters ?? resolveEffectiveContextBudget(input.contextWindowTokens)
  );

  const assignmentBlock = `[Current Assignment]\n${input.assignment.trim()}`;
  const summaryText = input.summary?.trim() || '';
  const summaryBlock = summaryText ? `[Channel Summary]\n${summaryText}` : '';
  const repeatBlock =
    input.assignment.trim().length <= REPEATED_ASSIGNMENT_CHARACTERS
      ? `[Assignment Reminder]\n${input.assignment.trim()}`
      : '';

  const fixedOverhead =
    assignmentBlock.length +
    (summaryBlock ? summaryBlock.length + 2 : 0) +
    (repeatBlock ? repeatBlock.length + 2 : 0) +
    32;

  const remainingBudget = Math.max(0, budget - fixedOverhead);
  const transcriptBudget = Math.min(
    remainingBudget,
    Math.max(remainingBudget, Math.floor(budget * TRANSCRIPT_SHARE))
  );

  const includedLines: string[] = [];
  const includedMessageIds: string[] = [];
  let usedTranscriptChars = 0;

  // Walk newest-first so recent context is always preserved
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const msg = input.messages[i];
    const line = `[${msg.senderName} (${msg.senderType})]: ${msg.content}`;
    const lineCost = line.length + (includedLines.length > 0 ? 1 : 0);
    if (usedTranscriptChars + lineCost > transcriptBudget) {
      break;
    }
    includedLines.unshift(line);
    includedMessageIds.unshift(msg.id);
    usedTranscriptChars += lineCost;
  }

  const omittedMessageCount = Math.max(0, input.messages.length - includedMessageIds.length);
  const sections: string[] = [assignmentBlock];
  if (summaryBlock) sections.push(summaryBlock);
  if (includedLines.length > 0) {
    const omittedNote =
      omittedMessageCount > 0 ? `(${omittedMessageCount} earlier messages summarized/omitted)\n` : '';
    sections.push(`[Recent Transcript]\n${omittedNote}${includedLines.join('\n')}`);
  }
  if (repeatBlock) sections.push(repeatBlock);

  let promptText = sections.join('\n\n');
  if (promptText.length > budget) {
    promptText = promptText.slice(0, budget);
  }

  return {
    promptText,
    totalCharacters: promptText.length,
    budgetCharacters: budget,
    includedMessageIds,
    omittedMessageCount
  };
}

export class ChannelSummaryStore {
  private readonly summaries = new Map<string, { summary: string; messageCount: number }>();

  public get(channelId: string): string | undefined {
    return this.summaries.get(channelId)?.summary;
  }

  public shouldRefresh(channelId: string, currentMessageCount: number, minDelta = 8): boolean {
    const existing = this.summaries.get(channelId);
    if (!existing) return currentMessageCount >= minDelta;
    return currentMessageCount - existing.messageCount >= minDelta;
  }

  public set(channelId: string, summary: string, messageCount: number): void {
    this.summaries.set(channelId, { summary, messageCount });
  }
}
