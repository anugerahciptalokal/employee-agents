import { randomUUID } from 'crypto';
import type { Agent, Channel } from '@open-employee/contracts/types';

export interface ParsedSendToChannelDirective {
  targetChannel: Channel;
  recipients: Agent[];
  brief: string;
}

export interface ChannelRouteResult {
  owners: Agent[];
  routedBy: 'mention' | 'everyone' | 'lead' | 'fallback';
}

export interface RouteChannelOwnersInput {
  text: string;
  channel: Channel;
  members: Agent[];
  leadAgent?: Agent | null;
  runLeadRouter?: (prompt: string) => Promise<string>;
}

export interface SendToChannelHandoffInput {
  sourceConversationType: 'agent' | 'channel';
  sourceAgent: Agent;
  targetChannel: Channel;
  brief: string;
  explicitRecipients?: Agent[];
  members: Agent[];
  leadAgent?: Agent | null;
  runLeadRouter?: (prompt: string) => Promise<string>;
  postMessage: (msg: {
    channelId: string;
    content: string;
    senderId: string;
    senderName: string;
  }) => Promise<unknown>;
  dispatchOwners: (owners: Agent[], handoffContent: string) => Promise<void>;
}

export interface SendToChannelHandoffResult {
  accepted: boolean;
  reason?: string;
  owners?: Agent[];
}

const SEND_TO_CHANNEL_REGEX =
  /\[SEND_TO_CHANNEL\s+#?([^(\]:\n]+?)(?:\s*\(([^)\n]*)\))?\s*:\s*([^\]]+)\]/i;

/**
 * Parses leading `@everyone` or `@AgentName` mentions from the start of a channel message.
 * Matches longest agent names first (case-insensitive) and deduplicates in mention order.
 */
export function parseLeadingChannelMentions(text: string, members: Agent[]): Agent[] {
  if (!text || !members || members.length === 0) return [];
  let cursor = text.trimStart();
  if (!cursor.startsWith('@')) return [];

  if (/^@everyone(?=$|[\s,:;.!?])/i.test(cursor)) {
    return [...members];
  }

  const sortedMembers = [...members].sort((a, b) => b.name.length - a.name.length);
  const selected: Agent[] = [];
  const seenIds = new Set<string>();

  while (cursor.startsWith('@')) {
    const afterAt = cursor.slice(1);
    const matched = sortedMembers.find((member) => {
      const name = member.name.trim();
      if (!name) return false;
      if (!afterAt.toLowerCase().startsWith(name.toLowerCase())) return false;
      const boundary = afterAt.slice(name.length);
      return boundary.length === 0 || /^[\s,:;.!?]/.test(boundary);
    });

    if (!matched) break;

    if (!seenIds.has(matched.id)) {
      seenIds.add(matched.id);
      selected.push(matched);
    }

    cursor = afterAt.slice(matched.name.trim().length).replace(/^[\s,]+/, '');
  }

  return selected;
}

/**
 * Parses `[SEND_TO_CHANNEL #channel (@AgentA, @AgentB): brief]` directives emitted by an agent in 1:1 DM.
 */
export function parseSendToChannelDirective(
  text: string,
  channels: Channel[],
  agents: Agent[] = []
): ParsedSendToChannelDirective | null {
  if (!text || !channels || channels.length === 0) return null;
  const match = text.match(SEND_TO_CHANNEL_REGEX);
  if (!match) return null;

  const rawChannel = match[1].trim().toLowerCase();
  const rawRecipients = (match[2] || '').trim();
  const brief = match[3].trim();
  if (!rawChannel || !brief) return null;

  const targetChannel = channels.find(
    (c) => c.name.trim().toLowerCase() === rawChannel || c.id.toLowerCase() === rawChannel
  );
  if (!targetChannel) return null;

  const recipients: Agent[] = [];
  if (rawRecipients && agents.length > 0) {
    const seen = new Set<string>();
    for (const token of rawRecipients.split(',')) {
      const clean = token.trim().replace(/^@/, '').toLowerCase();
      if (!clean) continue;
      const found = agents.find(
        (a) => a.name.trim().toLowerCase() === clean || a.id.toLowerCase() === clean
      );
      if (found && !seen.has(found.id)) {
        seen.add(found.id);
        recipients.push(found);
      }
    }
  }

  return { targetChannel, recipients, brief };
}

/**
 * Strips `[SEND_TO_CHANNEL ...]` directives from user-facing assistant text.
 */
export function stripSendToChannelDirectives(text: string): string {
  return (text || '')
    .replace(/\[SEND_TO_CHANNEL\s+#?[^(\]:\n]+?(?:\s*\([^)\n]*\))?\s*:\s*[^\]]+\]/gi, '')
    .trim();
}

function parseLeadRouterOutput(raw: string, members: Agent[]): Agent[] {
  if (!raw) return [];
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]) as { agentIds?: unknown };
    if (!Array.isArray(parsed.agentIds)) return [];

    const memberById = new Map(members.map((m) => [m.id.toLowerCase(), m]));
    const memberByName = new Map(members.map((m) => [m.name.trim().toLowerCase(), m]));
    const resolved: Agent[] = [];
    const seen = new Set<string>();

    for (const entry of parsed.agentIds) {
      if (typeof entry !== 'string') continue;
      const key = entry.trim().toLowerCase();
      const agent = memberById.get(key) || memberByName.get(key);
      if (agent && !seen.has(agent.id)) {
        seen.add(agent.id);
        resolved.push(agent);
      }
    }
    return resolved;
  } catch {
    return [];
  }
}

/**
 * Resolves which channel member agent(s) should own an incoming channel message.
 * Leading `@mentions` and `@everyone` bypass the lead router; unmentioned messages
 * delegate owner selection to `leadAgent` and safely fall back to the lead on invalid output.
 */
export async function routeChannelMessageOwners(
  input: RouteChannelOwnersInput
): Promise<ChannelRouteResult> {
  const { text, channel, members, leadAgent, runLeadRouter } = input;
  if (members.length === 0) {
    return { owners: leadAgent ? [leadAgent] : [], routedBy: 'fallback' };
  }

  const trimmed = text.trimStart();
  if (/^@everyone(?=$|[\s,:;.!?])/i.test(trimmed)) {
    return { owners: [...members], routedBy: 'everyone' };
  }

  const mentioned = parseLeadingChannelMentions(trimmed, members);
  if (mentioned.length > 0) {
    return { owners: mentioned, routedBy: 'mention' };
  }

  if (members.length === 1) {
    return { owners: [members[0]], routedBy: 'fallback' };
  }

  const effectiveLead =
    (leadAgent && members.some((m) => m.id === leadAgent.id) ? leadAgent : null) ||
    leadAgent ||
    members[0];

  if (runLeadRouter) {
    const memberRoster = members
      .map((m) => `- id: "${m.id}", name: "${m.name}", role: "${m.systemPrompt || 'Generalist'}"`)
      .join('\n');
    const routerPrompt = [
      `You are the Lead Coordinator (${effectiveLead.name}) for channel #${channel.name}.`,
      `Select which member agent ID(s) should answer the user's message below.`,
      `Members:\n${memberRoster}`,
      `Message:\n"""\n${text}\n"""`,
      `Respond ONLY with valid JSON: {"agentIds": ["<id1>"]}. If unclear or general, select ["${effectiveLead.id}"].`
    ].join('\n\n');

    try {
      const rawOutput = await runLeadRouter(routerPrompt);
      const selected = parseLeadRouterOutput(rawOutput, members);
      if (selected.length > 0) {
        return { owners: selected, routedBy: 'lead' };
      }
    } catch {
      // Fall back to lead below on router error
    }
  }

  return { owners: [effectiveLead], routedBy: 'fallback' };
}

/**
 * Executes a one-way `send_to_channel` handoff from a 1:1 agent conversation into a target channel.
 * Nested calls originating inside a channel are rejected to prevent circular handoffs.
 */
export async function executeSendToChannelHandoff(
  input: SendToChannelHandoffInput
): Promise<SendToChannelHandoffResult> {
  if (input.sourceConversationType === 'channel') {
    return { accepted: false, reason: 'nested_channel_handoff_forbidden' };
  }

  const handoffContent = `Request from teammate ${input.sourceAgent.name} (${input.sourceAgent.id}):\n${input.brief}`;
  await input.postMessage({
    channelId: input.targetChannel.id,
    content: handoffContent,
    senderId: `agent:${input.sourceAgent.id}`,
    senderName: input.sourceAgent.name
  });

  let owners: Agent[];
  if (input.explicitRecipients && input.explicitRecipients.length > 0) {
    owners = input.explicitRecipients;
  } else {
    const routed = await routeChannelMessageOwners({
      text: input.brief,
      channel: input.targetChannel,
      members: input.members,
      leadAgent: input.leadAgent,
      runLeadRouter: input.runLeadRouter
    });
    owners = routed.owners;
  }

  if (owners.length > 0) {
    await input.dispatchOwners(owners, handoffContent);
  }

  return { accepted: true, owners };
}

export const CHANNEL_PARALLEL_LIMIT = 2;
export const CHANNEL_REPLY_LIMIT = 2;

export type ChannelTaskStatus = 'running' | 'waiting' | 'ready' | 'completed' | 'failed';

export interface ChannelTaskRecord {
  id: string;
  rootRequestId: string;
  channelId: string;
  ownerAgentId: string;
  instruction: string;
  parentTaskId?: string;
  dependencies: string[];
  status: ChannelTaskStatus;
  result?: string;
}

export interface ChannelReplyInput {
  rootRequestId: string;
  callerTaskId: string;
  targetAgentId: string;
  replyToMessageId: string;
  text: string;
  postReply: (payload: {
    channelId: string;
    replyToMessageId: string;
    targetAgentId: string;
    text: string;
  }) => Promise<unknown>;
}

/**
 * Coordinates internal channel collaboration (`channel_assign`, `channel_reply`, `channel_transfer`)
 * with bounded parallel child tasks and dependency-driven parent wakeups.
 */
export class ChannelCollaborationCoordinator {
  private readonly tasks = new Map<string, ChannelTaskRecord>();
  private readonly replyCounts = new Map<string, number>();

  public createRootTask(
    rootRequestId: string,
    channelId: string,
    ownerAgentId: string,
    instruction: string
  ): ChannelTaskRecord {
    const task: ChannelTaskRecord = {
      id: randomUUID(),
      rootRequestId,
      channelId,
      ownerAgentId,
      instruction,
      dependencies: [],
      status: 'running'
    };
    this.tasks.set(task.id, task);
    return task;
  }

  public getTask(taskId: string): ChannelTaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  public assignChildTask(
    parentTaskId: string,
    targetAgentId: string,
    instruction: string
  ): { accepted: boolean; reason?: string; task?: ChannelTaskRecord } {
    const parent = this.tasks.get(parentTaskId);
    if (!parent) {
      return { accepted: false, reason: 'parent_task_not_found' };
    }

    const activeChannelChildren = Array.from(this.tasks.values()).filter(
      (t) =>
        t.channelId === parent.channelId &&
        Boolean(t.parentTaskId) &&
        (t.status === 'running' || t.status === 'waiting')
    );

    if (activeChannelChildren.length >= CHANNEL_PARALLEL_LIMIT) {
      return { accepted: false, reason: 'parallel_limit_reached' };
    }

    const child: ChannelTaskRecord = {
      id: randomUUID(),
      rootRequestId: parent.rootRequestId,
      channelId: parent.channelId,
      ownerAgentId: targetAgentId,
      instruction,
      parentTaskId,
      dependencies: [],
      status: 'running'
    };

    this.tasks.set(child.id, child);
    parent.dependencies.push(child.id);
    parent.status = 'waiting';

    return { accepted: true, task: child };
  }

  public completeTask(taskId: string, result: string): ChannelTaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    task.status = 'completed';
    task.result = result;

    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent && parent.status === 'waiting') {
        const allSettled = parent.dependencies.every((depId) => {
          const dep = this.tasks.get(depId);
          return dep && (dep.status === 'completed' || dep.status === 'failed');
        });
        if (allSettled) {
          parent.status = 'ready';
        }
      }
    }

    return task;
  }

  public getCompletedChildResults(
    parentTaskId: string
  ): Array<{ agentId: string; result: string }> {
    const parent = this.tasks.get(parentTaskId);
    if (!parent) return [];

    return parent.dependencies
      .map((depId) => this.tasks.get(depId))
      .filter((t): t is ChannelTaskRecord => Boolean(t && t.status === 'completed'))
      .map((t) => ({ agentId: t.ownerAgentId, result: t.result || '' }));
  }

  public async replyToMember(
    input: ChannelReplyInput
  ): Promise<{ accepted: boolean; reason?: string }> {
    const caller = this.tasks.get(input.callerTaskId);
    if (!caller) {
      return { accepted: false, reason: 'caller_task_not_found' };
    }

    const currentCount = this.replyCounts.get(input.rootRequestId) || 0;
    if (currentCount >= CHANNEL_REPLY_LIMIT) {
      return { accepted: false, reason: 'reply_limit_reached' };
    }

    this.replyCounts.set(input.rootRequestId, currentCount + 1);
    await input.postReply({
      channelId: caller.channelId,
      replyToMessageId: input.replyToMessageId,
      targetAgentId: input.targetAgentId,
      text: input.text
    });

    return { accepted: true };
  }

  public transferTask(
    taskId: string,
    newOwnerAgentId: string
  ): { accepted: boolean; reason?: string; task?: ChannelTaskRecord } {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { accepted: false, reason: 'task_not_found' };
    }
    task.ownerAgentId = newOwnerAgentId;
    return { accepted: true, task };
  }
}

export interface AgentMailboxMessage {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  content: string;
  expectsReply: boolean;
  createdAt: number;
}

/**
 * Separates informational `steer` updates (`expectsReply: false`) from reply-expecting
 * requests (`expectsReply: true`), queuing requests for their own dedicated turn when busy.
 */
export class AgentMailboxQueue {
  private readonly activeTurns = new Map<string, boolean>();
  private readonly queues = new Map<string, AgentMailboxMessage[]>();

  public setActiveTurn(agentId: string, active: boolean): void {
    this.activeTurns.set(agentId, active);
  }

  public isTurnActive(agentId: string): boolean {
    return Boolean(this.activeTurns.get(agentId));
  }

  public enqueue(input: {
    fromAgentId: string;
    toAgentId: string;
    content: string;
    expectsReply: boolean;
  }): { delivery: 'steer' | 'queued'; queuedBecause?: 'own-turn'; message: AgentMailboxMessage } {
    const message: AgentMailboxMessage = {
      id: randomUUID(),
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      content: input.content,
      expectsReply: input.expectsReply,
      createdAt: Date.now()
    };

    const busy = this.isTurnActive(input.toAgentId);
    if (!input.expectsReply && busy) {
      return { delivery: 'steer', message };
    }

    const list = this.queues.get(input.toAgentId) || [];
    list.push(message);
    this.queues.set(input.toAgentId, list);

    return {
      delivery: 'queued',
      queuedBecause: busy ? 'own-turn' : undefined,
      message
    };
  }

  public drainQueued(agentId: string): AgentMailboxMessage[] {
    const pending = this.queues.get(agentId) || [];
    this.queues.delete(agentId);
    return pending;
  }
}
