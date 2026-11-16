import { randomUUID } from 'crypto';
import type { WorkspaceDatabase } from '../core/db';

export interface MemoryEntry {
  id: string;
  ownerId: string;
  ownerType: 'agent' | 'channel';
  category: 'preference' | 'fact' | 'instruction' | 'context';
  text: string;
  sourceTurnId?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface SaveMemoryInput {
  ownerId: string;
  ownerType?: 'agent' | 'channel';
  text: string;
  category?: 'preference' | 'fact' | 'instruction' | 'context';
  sourceTurnId?: string;
}

/**
 * Heuristic Token Estimator
 * ~4 characters or ~0.75 words per token for English & Code.
 */
export function estimateTokenCount(text: string): number {
  if (!text || typeof text !== 'string') return 0;
  const chars = text.length;
  const words = text.trim().split(/\s+/).length;
  // Blended estimation
  return Math.ceil(Math.max(chars / 4, words * 1.3));
}

/**
 * Checks whether a conversation message list exceeds token limits and needs compaction.
 */
export function shouldCompact(
  messages: Array<{ content: string }>,
  maxTokensThreshold = 3500
): boolean {
  if (!messages || messages.length === 0) return false;
  let totalEstimatedTokens = 0;
  for (const msg of messages) {
    totalEstimatedTokens += estimateTokenCount(msg.content);
    if (totalEstimatedTokens > maxTokensThreshold) {
      return true;
    }
  }
  return false;
}

/**
 * Compacts older turns of a conversation history into a structured summary.
 * Preserves the most recent N turns intact for immediate continuity.
 */
export function compactMessages<T extends { id: string; content: string; senderType?: string }>(
  messages: T[],
  options: {
    preserveRecentCount?: number;
    summaryPrefix?: string;
  } = {}
): {
  summary: string;
  remainingMessages: T[];
  compactedCount: number;
} {
  const preserveCount = options.preserveRecentCount ?? 6;
  const prefix = options.summaryPrefix ?? 'Earlier conversation recap:';

  if (messages.length <= preserveCount) {
    return {
      summary: '',
      remainingMessages: messages,
      compactedCount: 0
    };
  }

  const cutIndex = messages.length - preserveCount;
  const olderMessages = messages.slice(0, cutIndex);
  const remainingMessages = messages.slice(cutIndex);

  // Generate a structured historical summary bullets
  const summaryBullets = olderMessages
    .map((m) => {
      const snippet = m.content.replace(/\s+/g, ' ').slice(0, 150).trim();
      const role = m.senderType === 'user' ? 'User' : 'Assistant';
      return `- [${role}]: ${snippet}`;
    })
    .join('\n');

  const summary = `${prefix}\n${summaryBullets}`;

  return {
    summary,
    remainingMessages,
    compactedCount: olderMessages.length
  };
}

/**
 * Formats a compacted summary block for system prompt injection.
 */
export function formatCompactedContext<T>(
  summary: string,
  activeMessages: T[]
): {
  systemSummaryPrompt: string;
  activeMessages: T[];
} {
  const systemSummaryPrompt = summary && summary.trim()
    ? `<conversation_summary>\n${summary.trim()}\n</conversation_summary>`
    : '';

  return {
    systemSummaryPrompt,
    activeMessages
  };
}

export class AgentMemoryStore {
  private db?: WorkspaceDatabase;
  private inMemoryMap: Map<string, MemoryEntry[]> = new Map();

  constructor(db?: WorkspaceDatabase) {
    this.db = db;
  }

  public saveMemory(input: SaveMemoryInput): MemoryEntry {
    const ownerId = input.ownerId;
    const ownerType = input.ownerType || 'agent';
    const category = input.category || 'fact';
    const text = input.text.trim();
    const sourceTurnId = input.sourceTurnId;

    if (this.db) {
      const record = this.db.saveMemory({
        ownerId,
        ownerType,
        category,
        text,
        sourceTurnId
      });
      return {
        id: record.id,
        ownerId: record.ownerId,
        ownerType: record.ownerType,
        category: record.category as any,
        text: record.text,
        sourceTurnId: record.sourceTurnId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      };
    }

    // In-memory fallback
    const id = randomUUID();
    const now = Date.now();
    const entry: MemoryEntry = {
      id,
      ownerId,
      ownerType,
      category,
      text,
      sourceTurnId,
      createdAt: now,
      updatedAt: now
    };

    const existing = this.inMemoryMap.get(ownerId) || [];
    existing.unshift(entry);
    this.inMemoryMap.set(ownerId, existing);
    return entry;
  }

  public listMemories(ownerId: string, ownerType?: 'agent' | 'channel'): MemoryEntry[] {
    if (this.db) {
      return this.db.getMemoriesByOwner(ownerId, ownerType).map((r) => ({
        id: r.id,
        ownerId: r.ownerId,
        ownerType: r.ownerType,
        category: r.category as any,
        text: r.text,
        sourceTurnId: r.sourceTurnId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt
      }));
    }

    const list = this.inMemoryMap.get(ownerId) || [];
    if (!ownerType) return list;
    return list.filter((m) => m.ownerType === ownerType);
  }

  public deleteMemory(id: string): boolean {
    if (this.db) {
      return this.db.deleteMemory(id);
    }

    for (const [ownerId, list] of this.inMemoryMap.entries()) {
      const filtered = list.filter((m) => m.id !== id);
      if (filtered.length !== list.length) {
        this.inMemoryMap.set(ownerId, filtered);
        return true;
      }
    }
    return false;
  }

  public searchMemories(ownerId: string, query: string): MemoryEntry[] {
    if (this.db) {
      return this.db.searchMemories(ownerId, query).map((r) => ({
        id: r.id,
        ownerId: r.ownerId,
        ownerType: r.ownerType,
        category: r.category as any,
        text: r.text,
        createdAt: r.createdAt
      }));
    }

    const list = this.inMemoryMap.get(ownerId) || [];
    const lower = query.toLowerCase();
    return list.filter((m) => m.text.toLowerCase().includes(lower));
  }

  /**
   * Generates the XML prompt block to inject persistent memories into an agent's system prompt.
   */
  public buildMemoryPromptBlock(ownerId: string): string {
    const memories = this.listMemories(ownerId);
    if (!memories || memories.length === 0) {
      return '';
    }

    const bullets = memories
      .map((m) => `- [${m.category.toUpperCase()}]: ${m.text}`)
      .join('\n');

    return `<agent_memories>\n${bullets}\n</agent_memories>`;
  }
}

// Global Singleton
export const globalAgentMemoryStore = new AgentMemoryStore();

