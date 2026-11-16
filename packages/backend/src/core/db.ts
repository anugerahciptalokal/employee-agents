import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import type {
  Channel,
  Agent,
  Message,
  QuotedMessage,
  CreateChannelResult,
  CreateAgentResult,
  FileAttachment
} from '@open-employee/contracts/types';
import {
  isValidUuid,
  legacyIdToDeterministicUuid,
  LOCAL_USER_SENDER_UUID
} from '@open-employee/contracts/uuid';
import { getDataLayoutPaths, migrateLegacyDataLayout } from './data-root';
import { redactSecrets } from '../service/providers/redaction';

export interface WorkspaceDatabaseOptions {
  secretRedactor?: (text: string) => string;
}

export interface UsageRecordInput {
  conversationId?: string | null;
  agentId?: string | null;
  model?: string | null;
  provider?: string | null;
  gatewayId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
}

export interface UsageModelSummary {
  provider: string;
  model: string;
  requests: number;
  untrackedRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  since: number | null;
  totals: {
    requests: number;
    untrackedRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costUsd: number;
  };
  models: UsageModelSummary[];
}

export interface PairedDeviceRecord {
  id: string;
  deviceName: string;
  platform: string;
  clientType: string;
  pairedAt: number;
  lastActiveAt: number;
  ipAddress?: string;
  isRevoked: number;
}

export class WorkspaceDatabase {
  private db: Database.Database;
  private readonly redactText: (text: string) => string;

  constructor(dbPath?: string, options: WorkspaceDatabaseOptions = {}) {
    if (!dbPath) {
      migrateLegacyDataLayout();
    }

    const layout = getDataLayoutPaths();
    const targetPath = dbPath || layout.dbPath;
    const targetDir = dirname(targetPath);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    this.db = new Database(targetPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = OFF');
    this.redactText = options.secretRedactor ?? ((text: string) => redactSecrets(text));

    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        is_default INTEGER NOT NULL DEFAULT 0,
        leader_agent_id TEXT,
        agent_ids TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        sender_type TEXT NOT NULL,
        content TEXT NOT NULL,
        reply_to_json TEXT,
        request_id TEXT,
        attachment_path TEXT,
        is_starred INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (channel_id) REFERENCES channels(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);

      CREATE TABLE IF NOT EXISTS workspace_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS paired_devices (
        id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL,
        client_type TEXT NOT NULL,
        paired_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        ip_address TEXT,
        is_revoked INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_paired_devices_active ON paired_devices(is_revoked, last_active_at);
      DELETE FROM paired_devices WHERE client_type = 'browser' OR platform = 'web';

      CREATE TABLE IF NOT EXISTS agent_memories (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'fact',
        text TEXT NOT NULL,
        source_turn_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_memories_owner ON agent_memories(owner_id, owner_type);

      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        conversation_id TEXT,
        agent_id TEXT,
        model TEXT,
        provider TEXT,
        gateway_id TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd REAL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_events_created_at ON usage_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_events_model ON usage_events(model);

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        compacted_until_message_id TEXT NOT NULL,
        compacted_message_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN reply_to_json TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN request_id TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN attachment_path TEXT;');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec(
        'CREATE INDEX IF NOT EXISTS idx_messages_channel_request_id ON messages(channel_id, request_id);'
      );
    } catch {
      // Index already exists
    }

    this.migrateLegacyIdsToUuid();
  }

  /**
   * Transactional, idempotent, collision-checked migration of any legacy non-UUID
   * identifiers in SQLite (`agents`, `channels`, `messages`) to canonical RFC 4122 UUIDs.
   * Existing canonical UUIDs are preserved unchanged (normalized to lowercase).
   * If a collision is detected, the transaction aborts and throws without modifying data.
   */
  public migrateLegacyIdsToUuid(): {
    migratedAgents: number;
    migratedChannels: number;
    migratedMessages: number;
  } {
    const migrateTx = this.db.transaction(() => {
      const agentRows = this.db
        .prepare('SELECT id FROM agents')
        .all() as Array<{ id: string }>;
      const channelRows = this.db
        .prepare('SELECT id, leader_agent_id, agent_ids FROM channels')
        .all() as Array<{
          id: string;
          leader_agent_id: string | null;
          agent_ids: string | null;
        }>;
      const messageRows = this.db
        .prepare('SELECT id, channel_id, sender_id, reply_to_json, request_id FROM messages')
        .all() as Array<{
          id: string;
          channel_id: string;
          sender_id: string;
          reply_to_json: string | null;
          request_id: string | null;
        }>;

      // 1. Pre-flight collision audit across primary keys
      const checkPrimaryCollision = (tableName: string, ids: string[]) => {
        const targetToSource = new Map<string, string>();
        for (const rawId of ids) {
          const targetUuid = isValidUuid(rawId)
            ? rawId.trim().toLowerCase()
            : legacyIdToDeterministicUuid(rawId);
          const existingSource = targetToSource.get(targetUuid);
          if (existingSource !== undefined && existingSource !== rawId) {
            throw new Error(
              `UUID migration collision detected in ${tableName}: "${existingSource}" and "${rawId}" both map to "${targetUuid}".`
            );
          }
          targetToSource.set(targetUuid, rawId);
        }
      };

      checkPrimaryCollision(
        'agents',
        agentRows.map((r) => r.id)
      );
      checkPrimaryCollision(
        'channels',
        channelRows.map((r) => r.id)
      );
      checkPrimaryCollision(
        'messages',
        messageRows.map((r) => r.id)
      );

      // Verify no agent and channel map to the same conversation UUID
      const agentTargetSet = new Set(
        agentRows.map((r) =>
          isValidUuid(r.id) ? r.id.trim().toLowerCase() : legacyIdToDeterministicUuid(r.id)
        )
      );
      for (const ch of channelRows) {
        const chTarget = isValidUuid(ch.id)
          ? ch.id.trim().toLowerCase()
          : legacyIdToDeterministicUuid(ch.id);
        if (agentTargetSet.has(chTarget)) {
          throw new Error(
            `UUID migration cross-entity collision detected: channel "${ch.id}" collides with an agent on UUID "${chTarget}".`
          );
        }
      }

      let migratedAgents = 0;
      let migratedChannels = 0;
      let migratedMessages = 0;

      const updateAgentIdStmt = this.db.prepare('UPDATE agents SET id = ? WHERE id = ?');
      for (const a of agentRows) {
        const nextId = isValidUuid(a.id)
          ? a.id.trim().toLowerCase()
          : legacyIdToDeterministicUuid(a.id);
        if (nextId !== a.id) {
          updateAgentIdStmt.run(nextId, a.id);
          migratedAgents++;
        }
      }

      const updateChannelStmt = this.db.prepare(
        'UPDATE channels SET id = ?, leader_agent_id = ?, agent_ids = ? WHERE id = ?'
      );
      for (const c of channelRows) {
        const nextId = isValidUuid(c.id)
          ? c.id.trim().toLowerCase()
          : legacyIdToDeterministicUuid(c.id);
        const nextLeaderId = c.leader_agent_id
          ? isValidUuid(c.leader_agent_id)
            ? c.leader_agent_id.trim().toLowerCase()
            : legacyIdToDeterministicUuid(c.leader_agent_id)
          : null;

        let nextAgentIdsJson = c.agent_ids;
        let agentIdsChanged = false;
        if (c.agent_ids) {
          try {
            const parsed = JSON.parse(c.agent_ids);
            if (Array.isArray(parsed)) {
              const mapped = parsed.map((aid: unknown) => {
                const str = String(aid || '');
                return isValidUuid(str)
                  ? str.trim().toLowerCase()
                  : legacyIdToDeterministicUuid(str);
              });
              const serialized = JSON.stringify(mapped);
              if (serialized !== c.agent_ids) {
                nextAgentIdsJson = serialized;
                agentIdsChanged = true;
              }
            }
          } catch {
            // Keep malformed JSON untouched
          }
        }

        if (nextId !== c.id || nextLeaderId !== c.leader_agent_id || agentIdsChanged) {
          updateChannelStmt.run(nextId, nextLeaderId, nextAgentIdsJson, c.id);
          migratedChannels++;
        }
      }

      const updateMessageStmt = this.db.prepare(
        'UPDATE messages SET id = ?, channel_id = ?, sender_id = ?, reply_to_json = ?, request_id = ? WHERE id = ?'
      );
      for (const m of messageRows) {
        const nextId = isValidUuid(m.id)
          ? m.id.trim().toLowerCase()
          : legacyIdToDeterministicUuid(m.id);
        const nextChannelId = isValidUuid(m.channel_id)
          ? m.channel_id.trim().toLowerCase()
          : legacyIdToDeterministicUuid(m.channel_id);
        const nextSenderId = isValidUuid(m.sender_id)
          ? m.sender_id.trim().toLowerCase()
          : legacyIdToDeterministicUuid(m.sender_id);
        const nextRequestId = m.request_id
          ? isValidUuid(m.request_id)
            ? m.request_id.trim().toLowerCase()
            : legacyIdToDeterministicUuid(m.request_id)
          : null;

        let nextReplyToJson = m.reply_to_json;
        let replyToChanged = false;
        if (m.reply_to_json) {
          try {
            const parsed = JSON.parse(m.reply_to_json) as QuotedMessage;
            if (parsed && typeof parsed.id === 'string') {
              const nextReplyId = isValidUuid(parsed.id)
                ? parsed.id.trim().toLowerCase()
                : legacyIdToDeterministicUuid(parsed.id);
              if (nextReplyId !== parsed.id) {
                nextReplyToJson = JSON.stringify({
                  ...parsed,
                  id: nextReplyId
                });
                replyToChanged = true;
              }
            }
          } catch {
            // Ignore malformed reply_to_json
          }
        }

        if (
          nextId !== m.id ||
          nextChannelId !== m.channel_id ||
          nextSenderId !== m.sender_id ||
          nextRequestId !== m.request_id ||
          replyToChanged
        ) {
          updateMessageStmt.run(
            nextId,
            nextChannelId,
            nextSenderId,
            nextReplyToJson,
            nextRequestId,
            m.id
          );
          migratedMessages++;
        }
      }

      return { migratedAgents, migratedChannels, migratedMessages };
    });

    return migrateTx();
  }

  // Channel Operations
  public getAllChannels(): Channel[] {
    const rows = this.db.prepare(`
      SELECT id, name, description, is_default as isDefault,
             leader_agent_id as leaderAgentId, agent_ids as agentIds,
             created_at as createdAt
      FROM channels
      ORDER BY created_at ASC
    `).all() as Array<{
      id: string;
      name: string;
      description: string | null;
      isDefault: number;
      leaderAgentId: string | null;
      agentIds: string | null;
      createdAt: number;
    }>;

    return rows.map((r) => {
      let parsedAgentIds: string[] | undefined = undefined;
      if (r.agentIds) {
        try {
          parsedAgentIds = JSON.parse(r.agentIds);
        } catch {
          parsedAgentIds = undefined;
        }
      }

      return {
        id: r.id,
        name: r.name,
        description: r.description || undefined,
        isDefault: Boolean(r.isDefault),
        leaderAgentId: r.leaderAgentId || undefined,
        agentIds: parsedAgentIds,
        createdAt: r.createdAt
      };
    });
  }

  public createChannel(
    name: string,
    description?: string,
    agentIds?: string[],
    leaderAgentId?: string,
    id?: string
  ): CreateChannelResult {
    const trimmed = (name || '').trim();

    if (!trimmed || trimmed.length < 1 || trimmed.length > 64) {
      return {
        success: false,
        error: 'Channel name must be between 1 and 64 characters.'
      };
    }

    let channelId: string;
    if (id !== undefined && id.trim() !== '') {
      if (!isValidUuid(id.trim())) {
        return {
          success: false,
          error: 'Channel ID must be a canonical UUID.'
        };
      }
      channelId = id.trim().toLowerCase();
      if (this.getChannelById(channelId) || this.getAgentById(channelId)) {
        return {
          success: false,
          error: 'Channel ID already exists.'
        };
      }
    } else {
      channelId = randomUUID().toLowerCase();
    }

    if (leaderAgentId !== undefined && leaderAgentId.trim() !== '') {
      if (!isValidUuid(leaderAgentId.trim())) {
        return {
          success: false,
          error: 'Leader agent ID must be a canonical UUID.'
        };
      }
    }

    if (agentIds && agentIds.some((aid) => !isValidUuid(aid))) {
      return {
        success: false,
        error: 'All channel member agent IDs must be canonical UUIDs.'
      };
    }

    const existing = this.db.prepare('SELECT id FROM channels WHERE LOWER(name) = LOWER(?)').get(trimmed);
    if (existing) {
      return {
        success: false,
        error: `Channel "${trimmed}" already exists.`
      };
    }

    const normalizedAgentIds = agentIds?.map((aid) => aid.trim().toLowerCase());
    const normalizedLeaderId = leaderAgentId ? leaderAgentId.trim().toLowerCase() : undefined;

    const newChannel: Channel = {
      id: channelId,
      name: trimmed,
      description,
      isDefault: false,
      agentIds: normalizedAgentIds,
      leaderAgentId: normalizedLeaderId,
      createdAt: Date.now()
    };

    this.db.prepare(`
      INSERT INTO channels (id, name, description, is_default, leader_agent_id, agent_ids, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      newChannel.id,
      newChannel.name,
      newChannel.description || null,
      0,
      newChannel.leaderAgentId || null,
      newChannel.agentIds ? JSON.stringify(newChannel.agentIds) : null,
      newChannel.createdAt
    );

    return {
      success: true,
      channel: newChannel
    };
  }

  // Agent Operations
  public getAllAgents(): Agent[] {
    const rows = this.db.prepare(`
      SELECT id, name, model, system_prompt as systemPrompt, created_at as createdAt
      FROM agents
      ORDER BY created_at ASC
    `).all() as Array<{ id: string; name: string; model: string; systemPrompt: string | null; createdAt: number }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      model: r.model,
      systemPrompt: r.systemPrompt || undefined,
      createdAt: r.createdAt
    }));
  }

  public getAgentById(agentId: string): Agent | null {
    if (!agentId || !agentId.trim()) return null;
    const row = this.db
      .prepare(
        `
      SELECT id, name, model, system_prompt as systemPrompt, created_at as createdAt
      FROM agents
      WHERE id = ?
    `
      )
      .get(agentId.trim().toLowerCase()) as
      | { id: string; name: string; model: string; systemPrompt: string | null; createdAt: number }
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      model: row.model,
      systemPrompt: row.systemPrompt || undefined,
      createdAt: row.createdAt
    };
  }

  public getChannelById(channelId: string): Channel | null {
    if (!channelId || !channelId.trim()) return null;
    const row = this.db
      .prepare(
        `
      SELECT id, name, description, is_default as isDefault,
             leader_agent_id as leaderAgentId, agent_ids as agentIds,
             created_at as createdAt
      FROM channels
      WHERE id = ?
    `
      )
      .get(channelId.trim().toLowerCase()) as
      | {
          id: string;
          name: string;
          description: string | null;
          isDefault: number;
          leaderAgentId: string | null;
          agentIds: string | null;
          createdAt: number;
        }
      | undefined;

    if (!row) return null;
    let parsedAgentIds: string[] | undefined = undefined;
    if (row.agentIds) {
      try {
        parsedAgentIds = JSON.parse(row.agentIds);
      } catch {
        parsedAgentIds = undefined;
      }
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      isDefault: Boolean(row.isDefault),
      leaderAgentId: row.leaderAgentId || undefined,
      agentIds: parsedAgentIds,
      createdAt: row.createdAt
    };
  }

  public createAgent(
    data: Omit<Agent, 'id' | 'createdAt'> & { id?: string; createdAt?: number }
  ): CreateAgentResult {
    const trimmedName = (data.name || '').trim();
    if (!trimmedName || trimmedName.length > 64) {
      return {
        success: false,
        error: 'Agent name must be between 1 and 64 characters.'
      };
    }

    let requestedId: string;
    if (data.id !== undefined && data.id.trim() !== '') {
      if (!isValidUuid(data.id.trim())) {
        return {
          success: false,
          error: 'Agent ID must be a canonical UUID.'
        };
      }
      requestedId = data.id.trim().toLowerCase();
      if (this.getAgentById(requestedId) || this.getChannelById(requestedId)) {
        return {
          success: false,
          error: 'Agent with this ID already exists.'
        };
      }
    } else {
      requestedId = randomUUID().toLowerCase();
    }

    const newAgent: Agent = {
      id: requestedId,
      name: trimmedName,
      model: (data.model || 'claude-3-5-sonnet').trim(),
      systemPrompt: data.systemPrompt,
      createdAt: data.createdAt ?? Date.now()
    };

    this.db.prepare(`
      INSERT INTO agents (id, name, model, system_prompt, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(newAgent.id, newAgent.name, newAgent.model, newAgent.systemPrompt || null, newAgent.createdAt);

    return {
      success: true,
      agent: newAgent
    };
  }

  public deleteAgent(agentId: string): boolean {
    if (!agentId || !agentId.trim()) return false;
    const res = this.db
      .prepare('DELETE FROM agents WHERE id = ?')
      .run(agentId.trim().toLowerCase());
    return res.changes > 0;
  }

  public updateAgentModel(agentId: string, model: string): boolean {
    const res = this.db
      .prepare('UPDATE agents SET model = ? WHERE id = ?')
      .run(model.trim(), agentId.trim().toLowerCase());
    return res.changes > 0;
  }

  // Message Operations
  private hydrateMessageRow(r: {
    id: string;
    channelId: string;
    senderId: string;
    senderName: string;
    senderType: 'user' | 'agent';
    content: string;
    replyToJson: string | null;
    attachmentPath?: string | null;
    isStarred: number;
    createdAt: number;
  }): Message {
    let replyTo: QuotedMessage | undefined;
    if (r.replyToJson) {
      try {
        const parsed = JSON.parse(r.replyToJson) as QuotedMessage;
        if (parsed && typeof parsed.id === 'string' && typeof parsed.content === 'string') {
          replyTo = {
            id: parsed.id,
            senderName: this.redactText(String(parsed.senderName || '')),
            content: this.redactText(String(parsed.content || '')),
            ...(typeof parsed.attachmentPath === 'string' && parsed.attachmentPath.trim()
              ? { attachmentPath: parsed.attachmentPath.trim() }
              : {}),
            ...(typeof parsed.attachmentName === 'string' && parsed.attachmentName.trim()
              ? { attachmentName: parsed.attachmentName.trim() }
              : {}),
            ...(typeof parsed.attachmentMimeType === 'string' && parsed.attachmentMimeType.trim()
              ? { attachmentMimeType: parsed.attachmentMimeType.trim() }
              : {})
          };
        }
      } catch {
        replyTo = undefined;
      }
    }

    const safeAttachmentPath =
      r.attachmentPath && typeof r.attachmentPath === 'string' && r.attachmentPath.trim()
        ? r.attachmentPath.trim()
        : undefined;

    let attachments: FileAttachment[] | undefined;
    if (safeAttachmentPath) {
      const fileName = safeAttachmentPath.split('/').pop() || 'attachment';
      const isImg = /\.(jpe?g|png|gif|webp|svg)$/i.test(fileName);
      attachments = [
        {
          id: `att-${r.id}`,
          name: fileName,
          originalName: fileName,
          size: 0,
          mimeType: isImg
            ? `image/${fileName.split('.').pop()?.toLowerCase() || 'jpeg'}`
            : 'application/octet-stream',
          relativePath: safeAttachmentPath,
          createdAt: r.createdAt
        }
      ];
    }

    return {
      id: r.id,
      channelId: r.channelId,
      senderId: r.senderId,
      senderName: r.senderName,
      senderType: r.senderType,
      content: r.content,
      ...(replyTo ? { replyTo } : {}),
      ...(safeAttachmentPath ? { attachmentPath: safeAttachmentPath } : {}),
      ...(attachments ? { attachments } : {}),
      isStarred: Boolean(r.isStarred),
      createdAt: r.createdAt
    };
  }

  public getMessages(channelId: string): Message[] {
    if (!channelId || !channelId.trim()) return [];
    const rows = this.db.prepare(`
      SELECT id, channel_id as channelId, sender_id as senderId, sender_name as senderName,
             sender_type as senderType, content, reply_to_json as replyToJson,
             attachment_path as attachmentPath,
             is_starred as isStarred, created_at as createdAt
      FROM messages
      WHERE channel_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(channelId.trim().toLowerCase()) as Array<{
      id: string;
      channelId: string;
      senderId: string;
      senderName: string;
      senderType: 'user' | 'agent';
      content: string;
      replyToJson: string | null;
      attachmentPath?: string | null;
      isStarred: number;
      createdAt: number;
    }>;

    return rows.map((r) => this.hydrateMessageRow(r));
  }

  public getMessageById(channelId: string, messageId: string): Message | null {
    if (!channelId || !messageId) return null;
    const row = this.db
      .prepare(
        `
      SELECT id, channel_id as channelId, sender_id as senderId, sender_name as senderName,
             sender_type as senderType, content, reply_to_json as replyToJson,
             attachment_path as attachmentPath,
             is_starred as isStarred, created_at as createdAt
      FROM messages
      WHERE channel_id = ? AND id = ?
    `
      )
      .get(channelId.trim().toLowerCase(), messageId.trim().toLowerCase()) as
      | {
          id: string;
          channelId: string;
          senderId: string;
          senderName: string;
          senderType: 'user' | 'agent';
          content: string;
          replyToJson: string | null;
          attachmentPath?: string | null;
          isStarred: number;
          createdAt: number;
        }
      | undefined;

    if (!row) return null;
    return this.hydrateMessageRow(row);
  }

  /**
   * Returns all messages in a conversation correlated with a given requestId.
   * Used for persistent idempotency and retry deduplication across app restarts.
   */
  public getMessagesByRequestId(channelId: string, requestId: string): Message[] {
    if (!channelId || !requestId) return [];
    const rows = this.db
      .prepare(
        `
      SELECT id, channel_id as channelId, sender_id as senderId, sender_name as senderName,
             sender_type as senderType, content, reply_to_json as replyToJson,
             attachment_path as attachmentPath,
             is_starred as isStarred, created_at as createdAt
      FROM messages
      WHERE channel_id = ? AND request_id = ?
      ORDER BY created_at ASC, rowid ASC
    `
      )
      .all(channelId.trim().toLowerCase(), requestId.trim().toLowerCase()) as Array<{
      id: string;
      channelId: string;
      senderId: string;
      senderName: string;
      senderType: 'user' | 'agent';
      content: string;
      replyToJson: string | null;
      attachmentPath?: string | null;
      isStarred: number;
      createdAt: number;
    }>;

    return rows.map((r) => this.hydrateMessageRow(r));
  }

  public toggleStarMessage(messageId: string): boolean {
    const normalizedId = (messageId || '').trim().toLowerCase();
    const row = this.db.prepare('SELECT is_starred FROM messages WHERE id = ?').get(normalizedId) as { is_starred: number } | undefined;
    if (!row) return false;
    const nextVal = row.is_starred ? 0 : 1;
    this.db.prepare('UPDATE messages SET is_starred = ? WHERE id = ?').run(nextVal, normalizedId);
    return true;
  }

  public addMessage(
    channelId: string,
    content: string,
    senderType: 'user' | 'agent' = 'user',
    senderName: string = 'You',
    senderId?: string,
    replyTo?: QuotedMessage,
    requestId?: string,
    attachmentPath?: string,
    messageId?: string
  ): Message {
    const normalizedChannelId = isValidUuid(channelId)
      ? channelId.trim().toLowerCase()
      : legacyIdToDeterministicUuid(channelId);

    const finalId =
      messageId && isValidUuid(messageId)
        ? messageId.trim().toLowerCase()
        : randomUUID().toLowerCase();

    // Idempotency: return existing message if already inserted with this ID
    const existing = this.db.prepare('SELECT id FROM messages WHERE id = ?').get(finalId);
    if (existing) {
      const found = this.getMessageById(normalizedChannelId, finalId);
      if (found) return found;
    }

    const resolvedSenderId = senderId
      ? isValidUuid(senderId)
        ? senderId.trim().toLowerCase()
        : legacyIdToDeterministicUuid(senderId)
      : senderType === 'user'
        ? LOCAL_USER_SENDER_UUID
        : randomUUID().toLowerCase();

    const normalizedRequestId =
      requestId && isValidUuid(requestId) ? requestId.trim().toLowerCase() : null;

    const sanitizedContent = this.redactText(content);
    const sanitizedSenderName = this.redactText(senderName);
    const sanitizedReplyTo = replyTo
      ? {
          id: isValidUuid(replyTo.id)
            ? replyTo.id.trim().toLowerCase()
            : legacyIdToDeterministicUuid(replyTo.id),
          senderName: this.redactText(String(replyTo.senderName || '')),
          content: this.redactText(String(replyTo.content || '')),
          ...(typeof replyTo.attachmentPath === 'string' && replyTo.attachmentPath.trim()
            ? { attachmentPath: replyTo.attachmentPath.trim() }
            : {}),
          ...(typeof replyTo.attachmentName === 'string' && replyTo.attachmentName.trim()
            ? { attachmentName: replyTo.attachmentName.trim() }
            : {}),
          ...(typeof replyTo.attachmentMimeType === 'string' && replyTo.attachmentMimeType.trim()
            ? { attachmentMimeType: replyTo.attachmentMimeType.trim() }
            : {})
        }
      : undefined;

    const safeAttachmentPath = attachmentPath && typeof attachmentPath === 'string' && attachmentPath.trim()
      ? attachmentPath.trim()
      : undefined;

    const message: Message = {
      id: finalId,
      channelId: normalizedChannelId,
      senderId: resolvedSenderId,
      senderName: sanitizedSenderName,
      senderType,
      content: sanitizedContent,
      ...(sanitizedReplyTo ? { replyTo: sanitizedReplyTo } : {}),
      ...(safeAttachmentPath ? { attachmentPath: safeAttachmentPath } : {}),
      createdAt: Date.now()
    };

    this.db.prepare(`
      INSERT INTO messages (id, channel_id, sender_id, sender_name, sender_type, content, reply_to_json, request_id, attachment_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.channelId,
      message.senderId,
      message.senderName,
      message.senderType,
      message.content,
      sanitizedReplyTo ? JSON.stringify(sanitizedReplyTo) : null,
      normalizedRequestId,
      safeAttachmentPath || null,
      message.createdAt
    );

    return message;
  }

  public getWorkspaceState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM workspace_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  public setWorkspaceState(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO workspace_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, value);
  }

  public getActiveConversation(): {
    activeConversationId: string;
    activeConversationType: 'channel' | 'agent';
  } {
    const id = this.getWorkspaceState('active_conversation_id') || '';
    const rawType = this.getWorkspaceState('active_conversation_type');
    const type = rawType === 'agent' ? 'agent' : 'channel';
    return { activeConversationId: id, activeConversationType: type };
  }

  public setActiveConversation(id: string, type: 'channel' | 'agent' = 'channel'): void {
    if (id) {
      this.setWorkspaceState('active_conversation_id', id);
      this.setWorkspaceState('active_conversation_type', type);
    }
  }

  public registerPairedDevice(device: {
    id: string;
    deviceName: string;
    platform: string;
    clientType: string;
    ipAddress?: string;
  }): void {
    if (device.clientType === 'browser' || device.platform === 'web') {
      return;
    }
    const now = Date.now();
    const existing = this.db.prepare('SELECT id, paired_at FROM paired_devices WHERE id = ?').get(device.id) as
      | { id: string; paired_at: number }
      | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE paired_devices
           SET device_name = ?, platform = ?, client_type = ?, last_active_at = ?, ip_address = COALESCE(?, ip_address), is_revoked = 0
           WHERE id = ?`
        )
        .run(device.deviceName, device.platform, device.clientType, now, device.ipAddress || null, device.id);
    } else {
      this.db
        .prepare(
          `INSERT INTO paired_devices (id, device_name, platform, client_type, paired_at, last_active_at, ip_address, is_revoked)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          device.id,
          device.deviceName,
          device.platform,
          device.clientType,
          now,
          now,
          device.ipAddress || null
        );
    }
  }

  public getPairedDevices(): PairedDeviceRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, device_name, platform, client_type, paired_at, last_active_at, ip_address, is_revoked FROM paired_devices ORDER BY last_active_at DESC'
      )
      .all() as Array<{
        id: string;
        device_name: string;
        platform: string;
        client_type: string;
        paired_at: number;
        last_active_at: number;
        ip_address: string | null;
        is_revoked: number;
      }>;

    return rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      platform: r.platform,
      clientType: r.client_type,
      pairedAt: r.paired_at,
      lastActiveAt: r.last_active_at,
      ipAddress: r.ip_address || undefined,
      isRevoked: r.is_revoked
    }));
  }

  public getPairedDevice(id: string): PairedDeviceRecord | null {
    const r = this.db
      .prepare(
        'SELECT id, device_name, platform, client_type, paired_at, last_active_at, ip_address, is_revoked FROM paired_devices WHERE id = ?'
      )
      .get(id) as
      | {
          id: string;
          device_name: string;
          platform: string;
          client_type: string;
          paired_at: number;
          last_active_at: number;
          ip_address: string | null;
          is_revoked: number;
        }
      | undefined;

    if (!r) return null;
    return {
      id: r.id,
      deviceName: r.device_name,
      platform: r.platform,
      clientType: r.client_type,
      pairedAt: r.paired_at,
      lastActiveAt: r.last_active_at,
      ipAddress: r.ip_address || undefined,
      isRevoked: r.is_revoked
    };
  }

  public updateDeviceHeartbeat(id: string, ipAddress?: string): boolean {
    const now = Date.now();
    const result = this.db
      .prepare(
        'UPDATE paired_devices SET last_active_at = ?, ip_address = COALESCE(?, ip_address) WHERE id = ?'
      )
      .run(now, ipAddress || null, id);
    return result.changes > 0;
  }

  public renamePairedDevice(id: string, newName: string): boolean {
    const result = this.db
      .prepare('UPDATE paired_devices SET device_name = ? WHERE id = ?')
      .run(newName, id);
    return result.changes > 0;
  }

  public revokePairedDevice(id: string): boolean {
    const result = this.db
      .prepare('UPDATE paired_devices SET is_revoked = 1 WHERE id = ?')
      .run(id);
    return result.changes > 0;
  }

  // --- Agent & Channel Long-Term Memory ---

  public saveMemory(entry: {
    id?: string;
    ownerId: string;
    ownerType: 'agent' | 'channel';
    text: string;
    category?: string;
    sourceTurnId?: string;
  }): {
    id: string;
    ownerId: string;
    ownerType: 'agent' | 'channel';
    category: string;
    text: string;
    sourceTurnId?: string;
    createdAt: number;
    updatedAt: number;
  } {
    const id = entry.id || randomUUID();
    const now = Date.now();
    const category = entry.category || 'fact';
    const text = this.redactText(entry.text.trim());

    this.db
      .prepare(`
        INSERT INTO agent_memories (id, owner_id, owner_type, category, text, source_turn_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text,
          category = excluded.category,
          updated_at = excluded.updated_at
      `)
      .run(id, entry.ownerId, entry.ownerType, category, text, entry.sourceTurnId || null, now, now);

    return {
      id,
      ownerId: entry.ownerId,
      ownerType: entry.ownerType,
      category,
      text,
      sourceTurnId: entry.sourceTurnId,
      createdAt: now,
      updatedAt: now
    };
  }

  public getMemoriesByOwner(ownerId: string, ownerType?: string): Array<{
    id: string;
    ownerId: string;
    ownerType: 'agent' | 'channel';
    category: string;
    text: string;
    sourceTurnId?: string;
    createdAt: number;
    updatedAt: number;
  }> {
    let query = 'SELECT * FROM agent_memories WHERE owner_id = ?';
    const params: any[] = [ownerId];
    if (ownerType) {
      query += ' AND owner_type = ?';
      params.push(ownerType);
    }
    query += ' ORDER BY created_at DESC';

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      ownerType: r.owner_type,
      category: r.category,
      text: r.text,
      sourceTurnId: r.source_turn_id || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }

  public deleteMemory(id: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  public searchMemories(ownerId: string, query: string): Array<{
    id: string;
    ownerId: string;
    ownerType: 'agent' | 'channel';
    category: string;
    text: string;
    createdAt: number;
  }> {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.db
      .prepare('SELECT * FROM agent_memories WHERE owner_id = ? AND LOWER(text) LIKE ? ORDER BY created_at DESC')
      .all(ownerId, like) as any[];

    return rows.map((r) => ({
      id: r.id,
      ownerId: r.owner_id,
      ownerType: r.owner_type,
      category: r.category,
      text: r.text,
      createdAt: r.created_at
    }));
  }

  // --- Context Auto-Compaction Summaries ---

  public saveConversationSummary(
    conversationId: string,
    summary: string,
    compactedUntilMessageId: string,
    count: number
  ): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO conversation_summaries (conversation_id, summary, compacted_until_message_id, compacted_message_count, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          summary = excluded.summary,
          compacted_until_message_id = excluded.compacted_until_message_id,
          compacted_message_count = excluded.compacted_message_count,
          updated_at = excluded.updated_at
      `)
      .run(conversationId, summary, compactedUntilMessageId, count, now);
  }

  public getConversationSummary(conversationId: string): {
    conversationId: string;
    summary: string;
    compactedUntilMessageId: string;
    compactedMessageCount: number;
    updatedAt: number;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?')
      .get(conversationId) as any;
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      summary: row.summary,
      compactedUntilMessageId: row.compacted_until_message_id,
      compactedMessageCount: row.compacted_message_count,
      updatedAt: row.updated_at
    };
  }

  // Usage Tracking Operations
  public recordUsage(input: UsageRecordInput): void {
    const finite = (value?: number | null): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    this.db
      .prepare(
        `INSERT INTO usage_events
         (id, conversation_id, agent_id, model, provider, gateway_id, input_tokens, output_tokens, total_tokens, cost_usd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID().toLowerCase(),
        input.conversationId || null,
        input.agentId || null,
        input.model || null,
        input.provider || null,
        input.gatewayId || null,
        finite(input.inputTokens),
        finite(input.outputTokens),
        finite(input.totalTokens),
        finite(input.costUsd),
        Date.now()
      );
  }

  public getUsageSummary(since?: number | null): UsageSummary {
    const rows = this.db
      .prepare(
        `SELECT COALESCE(provider, 'unknown') AS provider,
                COALESCE(model, 'unknown') AS model,
                COUNT(*) AS requests,
                SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS untracked_requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_events
         WHERE (? IS NULL OR created_at >= ?)
         GROUP BY provider, model
         ORDER BY total_tokens DESC, requests DESC`
      )
      .all(since ?? null, since ?? null) as Array<{
      provider: string;
      model: string;
      requests: number;
      untracked_requests: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cost_usd: number;
    }>;

    const models: UsageModelSummary[] = rows.map((row) => ({
      provider: row.provider,
      model: row.model,
      requests: row.requests,
      untrackedRequests: row.untracked_requests,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      totalTokens: row.total_tokens,
      costUsd: row.cost_usd
    }));

    const totals = models.reduce(
      (acc, item) => ({
        requests: acc.requests + item.requests,
        untrackedRequests: acc.untrackedRequests + item.untrackedRequests,
        inputTokens: acc.inputTokens + item.inputTokens,
        outputTokens: acc.outputTokens + item.outputTokens,
        totalTokens: acc.totalTokens + item.totalTokens,
        costUsd: acc.costUsd + item.costUsd
      }),
      {
        requests: 0,
        untrackedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0
      }
    );

    return { since: since ?? null, totals, models };
  }

  public close(): void {
    this.db.close();
  }
}
