import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import type { WorkspaceDatabase } from '../core/db';
import type { VaultManager } from '../core/vault/vault-manager';
import type { AIGatewayClient, ChatMessage, OpenAIToolDefinition } from '../core/agents/ai-gateway-client';
import { CodexClient } from '../core/agents/codex-client';
import type { FileManager } from '../core/file/file-manager';
import type { Agent, Message, QuotedMessage } from '@open-employee/contracts/types';
import { LOCAL_USER_SENDER_UUID, isValidUuid } from '@open-employee/contracts/uuid';
import { sanitizeAssistantReplyText } from '../core/chat/private-chat-service';
import {
  routeChannelMessageOwners,
  parseSendToChannelDirective,
  stripSendToChannelDirectives,
  executeSendToChannelHandoff,
  AgentMailboxQueue
} from './channel-orchestrator';
import {
  buildChannelContextPacket,
  ChannelSummaryStore
} from './channel-context';
import {
  loadAgentInstructionsMarkdown,
  loadChannelInstructionsMarkdown,
  composeTurnSystemPrompt
} from './markdown-instructions';
import { enrichMessagesWithUrlContext } from './url-context-enrichment';
import { runAgentToolLoop, type BrowserSyncEvent } from './agent-browser-tools';

export interface ParsedAskAgentDirective {
  targetAgent: Agent;
  question: string;
}

/**
 * Parses `[ASK_AGENT @TeammateName: question]` directives emitted by an agent
 * in 1:1 DM so the backend can relay the message to the real teammate agent.
 */
export function parseAskAgentDirective(
  text: string,
  allAgents: Agent[],
  currentAgentId: string
): ParsedAskAgentDirective | null {
  if (!text || !allAgents || allAgents.length === 0) return null;
  const match = text.match(/\[ASK_AGENT\s+@?([^:\]\n]+?):\s*([^\]]+)\]/i);
  if (!match) return null;

  const rawTarget = match[1].trim().toLowerCase();
  const question = match[2].trim();
  if (!rawTarget || !question) return null;

  const targetAgent = allAgents.find(
    (a) => a.id !== currentAgentId && a.name.trim().toLowerCase() === rawTarget
  );
  if (!targetAgent) return null;

  return { targetAgent, question };
}

export function stripAskAgentDirectives(text: string): string {
  return (text || '').replace(/\[ASK_AGENT\s+@?[^:\]\n]+?:\s*[^\]]+\]/gi, '').trim();
}

export interface BackgroundTurnIntent {
  conversationId: string;
  conversationType?: 'channel' | 'agent';
  content: string;
  messageId?: string;
  senderId?: string;
  senderName?: string;
  replyTo?: QuotedMessage;
  attachmentPath?: string;
  dataUrl?: string;
  visionAttachmentPath?: string;
  visionDataUrl?: string;
  requestId?: string;
  model?: string;
  systemPrompt?: string;
  contextMessages?: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

export type TurnActivityHookEvent =
  | {
      kind: 'turn:start' | 'turn:done';
      conversationId: string;
      turnId: string;
      agentName: string;
    }
  | {
      kind: 'turn:step';
      conversationId: string;
      turnId: string;
      agentName: string;
      step: string;
    }
  | {
      kind: 'assign';
      conversationId: string;
      turnId: string;
      targetAgentId: string;
      targetAgentName: string;
      status: 'asked' | 'working' | 'replied' | 'failed';
      preview?: string;
    };

export interface BackgroundTurnResult {
  success: boolean;
  userMessage?: Message;
  agentMessage?: Message;
  error?: string;
  errorCode?: string;
}

export class BackgroundTurnRunner {
  private readonly activeTurns = new Map<string, boolean>();
  private readonly summaryStore = new ChannelSummaryStore();
  private readonly mailbox = new AgentMailboxQueue();

  constructor(
    private readonly getDb: () => WorkspaceDatabase,
    private readonly getVault: () => VaultManager,
    private readonly getAiClient: () => AIGatewayClient,
    private readonly dataDir: string,
    private readonly getFileManager?: () => FileManager,
    private readonly onWorkspaceChanged?: (reason: string) => void,
    private readonly onBrowserEvent?: (event: BrowserSyncEvent) => void,
    private readonly onTurnActivity?: (event: TurnActivityHookEvent) => void
  ) {}

  public isGenerating(conversationId: string): boolean {
    if (!conversationId) return false;
    return Boolean(this.activeTurns.get(conversationId.trim().toLowerCase()));
  }

  public getGeneratingMap(): Record<string, boolean> {
    const map: Record<string, boolean> = {};
    for (const [id, isGen] of this.activeTurns.entries()) {
      if (isGen) map[id] = true;
    }
    return map;
  }

  public async executeTurn(intent: BackgroundTurnIntent): Promise<BackgroundTurnResult> {
    const rawConvId = typeof intent.conversationId === 'string' ? intent.conversationId.trim() : '';
    const rawContent = typeof intent.content === 'string' ? intent.content.trim() : '';
    if (!rawConvId || (!rawContent && !intent.attachmentPath && !intent.dataUrl)) {
      return {
        success: false,
        error: 'Invalid conversationId or empty message content.',
        errorCode: 'INVALID_INPUT'
      };
    }

    const conversationId = rawConvId.toLowerCase();
    const requestId = intent.requestId && isValidUuid(intent.requestId)
      ? intent.requestId.trim().toLowerCase()
      : randomUUID().toLowerCase();

    const db = this.getDb();
    const vault = this.getVault();
    const aiClient = this.getAiClient();

    // 1. Determine conversation type and entity
    const existingAgent = db.getAgentById(conversationId);
    const existingChannel = db.getChannelById(conversationId);
    const conversationType = intent.conversationType || (existingAgent ? 'agent' : 'channel');

    // 2. Instant Write-Ahead: Persist active conversation and user message to SQLite
    db.setActiveConversation(conversationId, conversationType);

    const clientMsgId =
      intent.messageId && isValidUuid(intent.messageId)
        ? intent.messageId.trim().toLowerCase()
        : undefined;

    const existingById = clientMsgId ? db.getMessageById(conversationId, clientMsgId) : null;
    const existingByReq = requestId ? db.getMessagesByRequestId(conversationId, requestId) : [];
    const existingUser = existingById || existingByReq.find((m) => m.senderType === 'user');

    if (existingUser && !existingUser.replyTo && intent.replyTo) {
      try {
        (db as any).db
          .prepare('UPDATE messages SET reply_to_json = ? WHERE id = ?')
          .run(JSON.stringify(intent.replyTo), existingUser.id);
        existingUser.replyTo = intent.replyTo;
      } catch {}
    }

    const userMessage =
      existingUser ||
      db.addMessage(
        conversationId,
        rawContent,
        'user',
        intent.senderName || 'You',
        intent.senderId || LOCAL_USER_SENDER_UUID,
        intent.replyTo,
        requestId,
        intent.attachmentPath,
        clientMsgId
      );

    // 3. Mark conversation as actively generating in background
    this.activeTurns.set(conversationId, true);
    this.onWorkspaceChanged?.('turn:started');

    // 4. Decoupled execution in background Node process
    const runWorker = async (): Promise<BackgroundTurnResult> => {
      try {
        const targetAgent = existingAgent || (existingChannel?.leaderAgentId ? db.getAgentById(existingChannel.leaderAgentId) : null) || db.getAllAgents()[0];
        const agentName = targetAgent ? targetAgent.name : 'AI Agent';
        const agentId = targetAgent ? targetAgent.id : conversationId;

        // Resolve Gateway credentials
        const gateways = vault.listAIGateways();
        const activeGateway =
          gateways.find((g) => g.model === intent.model) ||
          gateways.find((g) => g.isDefault) ||
          gateways[0];

        const defaultStatus = vault.getOpenRouterCredentialStatus();
        const baseUrl =
          activeGateway?.baseUrl || defaultStatus.baseUrl || 'https://openrouter.ai/api/v1';
        const model = activeGateway?.model || intent.model || defaultStatus.model || 'gemini/gemini-2.5-flash';
        const provider = activeGateway?.provider || defaultStatus.provider || 'openrouter';

        const rawKey =
          (activeGateway && vault.getDecryptedGatewayKey(activeGateway.id)) ||
          vault.getDecryptedAIGatewayKey();

        if (provider !== 'chatgpt' && !rawKey) {
          const errNotice = db.addMessage(
            conversationId,
            '⚠️ No API key configured. Please configure your model and API key in Settings > AI Models & Gateway.',
            'agent',
            agentName,
            agentId,
            undefined,
            requestId
          );
          return {
            success: false,
            userMessage,
            agentMessage: errNotice,
            errorCode: 'NO_API_KEY',
            error: 'No API key configured.'
          };
        }

        this.onTurnActivity?.({
          kind: 'turn:start',
          conversationId,
          turnId: requestId,
          agentName
        });

        // Multimodal image resolution
        let imageUrl: string | undefined = intent.visionDataUrl || intent.dataUrl;
        const targetVisionPath = intent.visionAttachmentPath || intent.attachmentPath;
        if (!imageUrl && targetVisionPath) {
          try {
            if (this.getFileManager) {
              const fm = this.getFileManager();
              let cleanPath = targetVisionPath;
              if (cleanPath.startsWith('.data/')) {
                cleanPath = cleanPath.slice('.data/'.length);
              }
              const readRes = await fm.readAttachment(cleanPath);
              if (readRes?.data && readRes.data.startsWith('data:image/')) {
                imageUrl = readRes.data;
              }
            }
          } catch {
            // Fallback to local fs read
          }

          if (!imageUrl) {
            try {
              const cleanRel = targetVisionPath.replace(/^\.data\//, '');
              const fullPath = resolve(this.dataDir, cleanRel);
              if (existsSync(fullPath)) {
                const mimeType = targetVisionPath.endsWith('.png')
                  ? 'image/png'
                  : targetVisionPath.endsWith('.webp')
                  ? 'image/webp'
                  : targetVisionPath.endsWith('.gif')
                  ? 'image/gif'
                  : 'image/jpeg';
                const b64 = readFileSync(fullPath).toString('base64');
                imageUrl = `data:${mimeType};base64,${b64}`;
              }
            } catch {
              // Ignore
            }
          }
        }

        // Prepare context messages
        let chatMessages: ChatMessage[] = [];
        if (Array.isArray(intent.contextMessages) && intent.contextMessages.length > 0) {
          chatMessages = intent.contextMessages.map((m) => ({
            role: m.role,
            content: m.content
          }));
        } else {
          // Reconstruct from SQLite message history (last 12 messages)
          const history = db.getMessages(conversationId).slice(-12);
          chatMessages = history.map((m) => ({
            role: (m.senderType === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.content
          }));
        }

        if (imageUrl && chatMessages.length > 0) {
          const lastIdx = chatMessages.map((m) => m.role).lastIndexOf('user');
          if (lastIdx >= 0) {
            const u = chatMessages[lastIdx];
            const textContent = typeof u.content === 'string' ? u.content : '';
            chatMessages[lastIdx] = {
              ...u,
              content: [
                { type: 'text', text: textContent },
                { type: 'image_url', image_url: { url: imageUrl } }
              ] as any
            };
          }
        }

        const enriched = await enrichMessagesWithUrlContext({
          messages: chatMessages,
          imageUrl,
          conversationId,
          conversationType
        });
        chatMessages = enriched.messages;
        imageUrl = enriched.imageUrl;
        const urlContextBlock = enriched.urlContextBlock;

        if (imageUrl && chatMessages.length > 0) {
          const lastIdx = chatMessages.map((m) => m.role).lastIndexOf('user');
          if (lastIdx >= 0) {
            const u = chatMessages[lastIdx];
            if (typeof u.content === 'string') {
              chatMessages[lastIdx] = {
                ...u,
                content: [
                  { type: 'text', text: u.content },
                  { type: 'image_url', image_url: { url: imageUrl } }
                ] as any
              };
            }
          }
        }

        const baseSystemPrompt = intent.systemPrompt || (targetAgent?.systemPrompt ? targetAgent.systemPrompt : undefined);
        const finalSystemPrompt = composeTurnSystemPrompt({
          agentName,
          baseSystemPrompt,
          agentMarkdown: loadAgentInstructionsMarkdown(agentId, this.dataDir)
        });

        const runCompletion = async (
          targetModel: string,
          targetSystemPrompt: string,
          targetMessages: ChatMessage[],
          tools?: OpenAIToolDefinition[]
        ) => {
          const gw =
            gateways.find((g) => g.model === targetModel) ||
            activeGateway;
          const gwBaseUrl = gw?.baseUrl || baseUrl;
          const gwProvider = gw?.provider || provider;
          const gwKey =
            (gw && vault.getDecryptedGatewayKey(gw.id)) ||
            rawKey;

          return gwProvider === 'chatgpt'
            ? await new CodexClient().chatCompletion({
                model: targetModel,
                systemPrompt: targetSystemPrompt,
                messages: targetMessages
              })
            : await aiClient.chatCompletion({
                baseUrl: gwBaseUrl,
                apiKey: gwKey!,
                model: targetModel,
                provider: gwProvider,
                systemPrompt: targetSystemPrompt,
                messages: targetMessages,
                ...(tools && tools.length > 0 ? { tools } : {})
              });
        };

        if (conversationType === 'channel' && existingChannel) {
          const allChannelMembers = (existingChannel.agentIds || [])
            .map((id) => db.getAgentById(id))
            .filter((a): a is Agent => Boolean(a));
          const members =
            allChannelMembers.length > 0
              ? allChannelMembers
              : targetAgent
              ? [targetAgent]
              : [];
          const leadAgent = existingChannel.leaderAgentId
            ? db.getAgentById(existingChannel.leaderAgentId) || targetAgent
            : targetAgent;

          const routed = await routeChannelMessageOwners({
            text: rawContent,
            channel: existingChannel,
            members,
            leadAgent,
            runLeadRouter:
              members.length > 1
                ? async (routerPrompt) => {
                    const leadModel = leadAgent?.model || model;
                    const res = await runCompletion(
                      leadModel,
                      'You are a channel routing coordinator. Reply with JSON only.',
                      [{ role: 'user', content: routerPrompt }]
                    );
                    return res.success && res.content ? res.content : '';
                  }
                : undefined
          });

          const owners = routed.owners.length > 0 ? routed.owners : targetAgent ? [targetAgent] : [];
          const fullChannelHistory = db.getMessages(conversationId);
          const channelPacket =
            Array.isArray(intent.contextMessages) && intent.contextMessages.length > 0
              ? null
              : buildChannelContextPacket({
                  assignment: rawContent,
                  summary: this.summaryStore.get(conversationId),
                  messages: fullChannelHistory
                });
          const channelTurnMessages: ChatMessage[] = channelPacket
            ? [
                {
                  role: 'user',
                  content: urlContextBlock
                    ? `${channelPacket.promptText}\n\n${urlContextBlock}`
                    : channelPacket.promptText
                }
              ]
            : chatMessages;

          const channelMarkdown = loadChannelInstructionsMarkdown(existingChannel.id, this.dataDir);
          let lastMessage: Message | undefined;
          let lastError: string | undefined;

          for (const owner of owners) {
            this.mailbox.setActiveTurn(owner.id, true);
            const ownerModel = owner.model || model;
            const ownerBasePrompt = intent.systemPrompt || owner.systemPrompt || undefined;
            const ownerSystemPrompt = composeTurnSystemPrompt({
              agentName: owner.name,
              baseSystemPrompt: ownerBasePrompt,
              agentMarkdown: loadAgentInstructionsMarkdown(owner.id, this.dataDir),
              channelMarkdown
            });

            let ownerCompletion;
            try {
              ownerCompletion = await runAgentToolLoop({
                model: ownerModel,
                systemPrompt: ownerSystemPrompt,
                messages: channelTurnMessages,
                conversationId,
                conversationType: 'channel',
                runCompletion,
                vault,
                onBrowserEvent: this.onBrowserEvent,
                dataRoot: this.dataDir
              });
            } finally {
              this.mailbox.setActiveTurn(owner.id, false);
            }
            db.recordUsage({
              conversationId,
              agentId: owner.id,
              model: ownerModel,
              provider,
              gatewayId: activeGateway?.id,
              inputTokens: ownerCompletion.usage?.inputTokens,
              outputTokens: ownerCompletion.usage?.outputTokens,
              totalTokens: ownerCompletion.usage?.totalTokens,
              costUsd: ownerCompletion.usage?.costUsd
            });

            if (ownerCompletion.success && ownerCompletion.content) {
              const sanitized = sanitizeAssistantReplyText(ownerCompletion.content, owner.name);
              const cleanReply =
                stripSendToChannelDirectives(stripAskAgentDirectives(sanitized)) || sanitized;
              const redacted = vault.redactSecrets(cleanReply);
              const ownerAttachmentPath = ownerCompletion.savedAttachments[0]?.relativePath;
              lastMessage = db.addMessage(
                conversationId,
                redacted,
                'agent',
                owner.name,
                owner.id,
                undefined,
                requestId,
                ownerAttachmentPath
              );
              this.onWorkspaceChanged?.('channel:reply');
            } else {
              lastError = ownerCompletion.error || 'Unable to connect to AI Gateway.';
            }
          }

          if (lastMessage && this.summaryStore.shouldRefresh(conversationId, fullChannelHistory.length + 1)) {
            const leadModel = leadAgent?.model || model;
            const recentSnippet = fullChannelHistory
              .slice(-16)
              .map((m) => `[${m.senderName}]: ${m.content.slice(0, 400)}`)
              .join('\n');
            void runCompletion(
              leadModel,
              'Summarize the channel discussion concisely in bullet points for future agent context.',
              [{ role: 'user', content: recentSnippet }]
            )
              .then((sumRes) => {
                if (sumRes.success && sumRes.content) {
                  this.summaryStore.set(conversationId, sumRes.content, fullChannelHistory.length + 1);
                }
              })
              .catch(() => {
                // Background summary refresh is best-effort
              });
          }

          if (lastMessage) {
            return {
              success: true,
              userMessage,
              agentMessage: lastMessage
            };
          }

          const redactedErr = vault.redactSecrets(lastError || 'Unable to connect to AI Gateway.');
          const errMsg = db.addMessage(
            conversationId,
            `⚠️ [AI Gateway Error]: ${redactedErr}`,
            'agent',
            agentName,
            agentId,
            undefined,
            requestId
          );
          return {
            success: false,
            userMessage,
            agentMessage: errMsg,
            error: redactedErr,
            errorCode: 'GATEWAY_ERROR'
          };
        }

        const toolResult = await runAgentToolLoop({
          model,
          systemPrompt: finalSystemPrompt,
          messages: chatMessages,
          conversationId,
          conversationType,
          runCompletion,
          vault,
          onBrowserEvent: this.onBrowserEvent,
          onToolStep: (step) => {
            this.onTurnActivity?.({
              kind: 'turn:step',
              conversationId,
              turnId: requestId,
              agentName,
              step
            });
          },
          dataRoot: this.dataDir
        });
        let completion: import('../core/agents/ai-gateway-client').ChatCompletionResult = toolResult;
        const savedAttachments = toolResult.savedAttachments;

        db.recordUsage({
          conversationId,
          agentId,
          model,
          provider,
          gatewayId: activeGateway?.id,
          inputTokens: completion.usage?.inputTokens,
          outputTokens: completion.usage?.outputTokens,
          totalTokens: completion.usage?.totalTokens,
          costUsd: completion.usage?.costUsd
        });

        // Inter-agent DM relay: if Agent A emitted [ASK_AGENT @Teammate: question],
        // actually execute a real turn with Teammate B and feed B's real answer back to A.
        if (conversationType === 'agent' && completion.success && completion.content) {
          const directive = parseAskAgentDirective(
            completion.content,
            db.getAllAgents(),
            agentId
          );
          if (directive) {
            const { targetAgent: teammate, question } = directive;
            const teammateModel = teammate.model || model;

            this.onTurnActivity?.({
              kind: 'assign',
              conversationId,
              turnId: requestId,
              targetAgentId: teammate.id,
              targetAgentName: teammate.name,
              status: 'asked',
              preview: question.slice(0, 120)
            });

            db.addMessage(
              teammate.id,
              `[Message from @${agentName}]: ${question}`,
              'agent',
              agentName,
              agentId
            );

            const teammateHistory: ChatMessage[] = db
              .getMessages(teammate.id)
              .slice(-12)
              .map((m) => {
                const isOwnReply = m.senderType === 'agent' && m.senderId === teammate.id;
                const contentText =
                  !isOwnReply && m.senderType === 'agent'
                    ? `[${m.senderName}]: ${m.content}`
                    : m.content;
                return {
                  role: isOwnReply ? ('assistant' as const) : ('user' as const),
                  content: contentText
                };
              });

            const teammateSystemPrompt = [
              teammate.systemPrompt || `You are ${teammate.name}.`,
              `Your colleague @${agentName} from this workspace is messaging you directly. Reply naturally and concisely in character as ${teammate.name}.`
            ].join('\n\n');

            this.onTurnActivity?.({
              kind: 'assign',
              conversationId,
              turnId: requestId,
              targetAgentId: teammate.id,
              targetAgentName: teammate.name,
              status: 'working',
              preview: question.slice(0, 120)
            });

            const teammateCompletion = await runCompletion(
              teammateModel,
              teammateSystemPrompt,
              teammateHistory
            );

            const rawTeammateReply =
              teammateCompletion.success && teammateCompletion.content
                ? sanitizeAssistantReplyText(teammateCompletion.content, teammate.name)
                : teammateCompletion.error || 'Maaf, belum bisa merespons saat ini.';
            const cleanTeammateReply = vault.redactSecrets(
              stripAskAgentDirectives(rawTeammateReply) || rawTeammateReply
            );

            this.onTurnActivity?.({
              kind: 'assign',
              conversationId,
              turnId: requestId,
              targetAgentId: teammate.id,
              targetAgentName: teammate.name,
              status: teammateCompletion.success ? 'replied' : 'failed',
              preview: cleanTeammateReply.slice(0, 140)
            });

            db.addMessage(
              teammate.id,
              cleanTeammateReply,
              'agent',
              teammate.name,
              teammate.id
            );
            this.onWorkspaceChanged?.('agent:relay');

            completion = await runCompletion(model, finalSystemPrompt, [
              ...chatMessages,
              { role: 'assistant', content: completion.content },
              {
                role: 'user',
                content: `[System Relay — Real reply from @${teammate.name}]:\n${cleanTeammateReply}\n\nNow answer the user based on @${teammate.name}'s actual reply above. Do NOT emit [ASK_AGENT ...] again.`
              }
            ]);
          }
        }

        if (conversationType === 'agent' && targetAgent && completion.success && completion.content) {
          const handoff = parseSendToChannelDirective(
            completion.content,
            db.getAllChannels(),
            db.getAllAgents()
          );
          if (handoff) {
            const targetMembers = (handoff.targetChannel.agentIds || [])
              .map((id) => db.getAgentById(id))
              .filter((a): a is Agent => Boolean(a));
            const targetLead = handoff.targetChannel.leaderAgentId
              ? db.getAgentById(handoff.targetChannel.leaderAgentId)
              : targetMembers[0] || null;

            await executeSendToChannelHandoff({
              sourceConversationType: conversationType,
              sourceAgent: targetAgent,
              targetChannel: handoff.targetChannel,
              brief: handoff.brief,
              explicitRecipients: handoff.recipients,
              members: targetMembers,
              leadAgent: targetLead,
              postMessage: async (msg) => {
                db.addMessage(msg.channelId, msg.content, 'agent', msg.senderName, msg.senderId);
                this.onWorkspaceChanged?.('channel:handoff');
              },
              dispatchOwners: async (owners, handoffContent) => {
                for (const owner of owners) {
                  const ownerModel = owner.model || model;
                  const ownerPrompt = owner.systemPrompt || `You are ${owner.name}.`;
                  const ownerRes = await runCompletion(ownerModel, ownerPrompt, [
                    { role: 'user', content: handoffContent }
                  ]);
                  if (ownerRes.success && ownerRes.content) {
                    const sanitized = sanitizeAssistantReplyText(ownerRes.content, owner.name);
                    const clean =
                      stripSendToChannelDirectives(stripAskAgentDirectives(sanitized)) || sanitized;
                    db.addMessage(
                      handoff.targetChannel.id,
                      vault.redactSecrets(clean),
                      'agent',
                      owner.name,
                      owner.id
                    );
                    this.onWorkspaceChanged?.('channel:reply');
                  }
                }
              }
            });
          }
        }

        if (completion.success && completion.content) {
          const sanitized = sanitizeAssistantReplyText(completion.content, agentName);
          const cleanReply =
            stripSendToChannelDirectives(stripAskAgentDirectives(sanitized)) || sanitized;
          const redacted = vault.redactSecrets(cleanReply);
          const agentAttachmentPath = savedAttachments[0]?.relativePath;
          const agentMessage = db.addMessage(
            conversationId,
            redacted,
            'agent',
            agentName,
            agentId,
            undefined,
            requestId,
            agentAttachmentPath
          );

          return {
            success: true,
            userMessage,
            agentMessage
          };
        }

        const errText = completion.error || 'Unable to connect to AI Gateway.';
        const redactedErr = vault.redactSecrets(errText);
        const agentMessage = db.addMessage(
          conversationId,
          `⚠️ [AI Gateway Error]: ${redactedErr}`,
          'agent',
          agentName,
          agentId,
          undefined,
          requestId
        );

        return {
          success: false,
          userMessage,
          agentMessage,
          error: redactedErr,
          errorCode: 'GATEWAY_ERROR'
        };
      } catch (err) {
        const errMsg = vault.redactSecrets(err instanceof Error ? err.message : String(err));
        const agentMessage = db.addMessage(
          conversationId,
          `⚠️ [AI Gateway Error]: ${errMsg}`,
          'agent',
          'AI Agent',
          conversationId,
          undefined,
          requestId
        );
        return {
          success: false,
          userMessage,
          agentMessage,
          error: errMsg,
          errorCode: 'UNHANDLED_ERROR'
        };
      } finally {
        this.activeTurns.delete(conversationId);
        this.onTurnActivity?.({
          kind: 'turn:done',
          conversationId,
          turnId: requestId,
          agentName
        });
        this.onWorkspaceChanged?.('turn:completed');
      }
    };

    // Execute background worker promise (caller receives result, but Node process holds promise alive)
    return runWorker();
  }
}

