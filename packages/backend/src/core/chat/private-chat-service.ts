import { randomUUID } from 'crypto';
import type { WorkspaceDatabase } from '../db';
import {
  isValidOpenRouterBaseUrl,
  isValidAIGatewayUrl,
  isCustomGatewayAllowed,
  normalizeOpenRouterBaseUrl,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MODEL,
  type VaultManager
} from '../vault/vault-manager';
import {
  MainCredentialBroker,
  createVaultCredentialResolver
} from '../credential-broker';
import type {
  CredentialBroker,
  CredentialPurpose,
  CredentialResolveOptions,
  CredentialResponseMessage,
  ProviderCredential
} from '../../service/credentials/credential-broker';
import { CredentialBrokerError } from '../../service/credentials/broker-client';
import { createOpenRouterConfig } from '../../service/providers/openrouter';
import { OpenRouterProviderRuntime } from '../../service/providers/openrouter-runtime';
import type {
  ProviderError,
  ProviderMessage,
  TurnRequest,
  UsageMetadata
} from '@open-employee/contracts/contracts/provider';
import { redactSecrets } from '../../service/providers/redaction';
import {
  isValidUuid,
  LOCAL_USER_SENDER_UUID
} from '@open-employee/contracts/uuid';
import type {
  Agent,
  Message,
  PrivateChatLifecycleState,
  PrivateChatSendIntent,
  PrivateChatSendResult,
  QuotedMessage
} from '@open-employee/contracts/types';

export const MAX_PRIVATE_MESSAGE_LENGTH = 32_000;

export interface PrivateChatServiceOptions {
  db: () => WorkspaceDatabase | null;
  vault: () => VaultManager | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  contextWindowMessages?: number;
}

interface ActivePrivateTurn {
  turnId: string;
  conversationId: string;
  agentId: string;
  requestId: string;
  controller: AbortController;
  runtime: OpenRouterProviderRuntime;
}

/**
 * Strips any self-prefixed "[AgentName]:" or "@AgentName:" emitted by the LLM
 * so the model cannot spoof or alter sender identity in the rendered transcript.
 */
export function sanitizeAssistantReplyText(reply: string, agentName: string): string {
  if (!reply) return '';
  let cleaned = reply.trim();
  cleaned = cleaned.replace(/^(?:\[[^\]]*\]:\s*)+/, '').trim();
  if (agentName && agentName.trim()) {
    const escaped = agentName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const bareRegex = new RegExp(`^@?${escaped}:\\s*`, 'i');
    cleaned = cleaned.replace(bareRegex, '').trim();
  }
  return cleaned;
}

/**
 * Builds the authoritative private 1:1 system prompt in the Main process.
 * Renderer never supplies or overrides the final system prompt.
 */
export function buildAuthoritativePrivateSystemPrompt(
  agent: Agent,
  quotedMessage?: QuotedMessage
): string {
  const sections: string[] = [];
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    sections.push(agent.systemPrompt.trim());
  } else {
    sections.push(`You are ${agent.name}, a helpful AI teammate.`);
  }

  if (quotedMessage) {
    const snippet =
      quotedMessage.content.length > 150
        ? `${quotedMessage.content.slice(0, 150)}...`
        : quotedMessage.content;
    sections.push(
      `[Discussion Context: The user is replying to a previous message by ${quotedMessage.senderName}: "${snippet}". Address their reply directly.]`
    );
  }

  sections.push(
    `CRITICAL IDENTITY & PERSONA DIRECTIVE:\nIf the user asks "Kamu menggunakan AI model apa?", "Model apa yang kamu pakai?", "What AI model are you using?", "What LLM are you?", or any variation asking about your underlying AI model, provider, or engine, you MUST strictly respond with your Persona name (${agent.name}) and your role in Employee Agents. You MUST NEVER state, name, or disclose the underlying AI model (e.g. GPT-4, Claude, Gemini, Llama, OpenAI, Anthropic, Google, etc.). You are ${agent.name}, an employee/agent of Employee Agents.`
  );

  sections.push(
    `Private 1:1 Chat Rules: You are in a private 1:1 conversation with the user as ${agent.name}. Respond directly and concisely using clean Markdown. NEVER prefix your response with your name or brackets like '[${agent.name}]:' and NEVER impersonate another agent or user.`
  );

  return sections.join('\n\n');
}

/**
 * Creates an in-process CredentialBroker backed by MainCredentialBroker
 * so that OpenRouterProviderRuntime resolves credentials strictly through MainCredentialBroker.
 * All internal identifiers (`nonce`, `requestId`) are pure canonical UUIDs.
 */
export function createInProcessMainCredentialBroker(
  getVault: () => VaultManager | null
): CredentialBroker {
  const nonce = randomUUID().toLowerCase();
  const mainBroker = new MainCredentialBroker({
    nonce,
    resolver: (input) => createVaultCredentialResolver(getVault())(input)
  });

  return {
    async resolve(
      providerId: string,
      purpose: CredentialPurpose,
      credentialRef: string,
      options: CredentialResolveOptions = {}
    ): Promise<ProviderCredential> {
      if (options.signal?.aborted) {
        throw new CredentialBrokerError(
          'BROKER_CANCELLED',
          'Credential request was cancelled.'
        );
      }

      const requestId = randomUUID().toLowerCase();
      let response: CredentialResponseMessage | null = null;

      const onAbort = () => {
        void mainBroker.handleMessage(
          {
            type: 'credential_cancel',
            requestId,
            nonce
          },
          () => undefined
        );
      };

      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        await mainBroker.handleRequest(
          {
            type: 'credential_request',
            requestId,
            nonce,
            providerId,
            purpose,
            credentialRef
          },
          (res) => {
            response = res;
          }
        );
      } finally {
        if (options.signal) {
          options.signal.removeEventListener('abort', onAbort);
        }
      }

      if (options.signal?.aborted) {
        throw new CredentialBrokerError(
          'BROKER_CANCELLED',
          'Credential request was cancelled.'
        );
      }

      if (!response) {
        throw new CredentialBrokerError(
          'BROKER_INVALID_RESPONSE',
          'Credential broker did not return a response.'
        );
      }

      const settled = response as CredentialResponseMessage;
      if (!settled.ok) {
        throw new CredentialBrokerError(
          settled.error.code,
          settled.error.message
        );
      }

      return settled.credential;
    }
  };
}

export class PrivateChatService {
  private readonly getDb: () => WorkspaceDatabase | null;
  private readonly getVault: () => VaultManager | null;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly contextWindowMessages: number;
  private readonly credentialBroker: CredentialBroker;
  private readonly activeTurns = new Map<string, ActivePrivateTurn>();
  private readonly lifecycleStates = new Map<string, PrivateChatLifecycleState>();

  constructor(options: PrivateChatServiceOptions) {
    this.getDb = options.db;
    this.getVault = options.vault;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 1;
    this.contextWindowMessages = options.contextWindowMessages ?? 12;
    this.credentialBroker = createInProcessMainCredentialBroker(this.getVault);
  }

  private redact(text: string): string {
    const vault = this.getVault();
    return vault ? vault.redactSecrets(text) : redactSecrets(text);
  }

  public getLifecycleState(conversationId: string): PrivateChatLifecycleState {
    if (!conversationId || !isValidUuid(conversationId)) return 'idle';
    return this.lifecycleStates.get(conversationId.trim().toLowerCase()) ?? 'idle';
  }

  private setLifecycleState(
    conversationId: string,
    state: PrivateChatLifecycleState
  ): void {
    this.lifecycleStates.set(conversationId.trim().toLowerCase(), state);
  }

  public getConversationHistory(
    conversationId: string,
    agentId: string
  ): { success: boolean; messages: Message[]; error?: string; errorCode?: string } {
    const db = this.getDb();
    if (!db) {
      return {
        success: false,
        messages: [],
        errorCode: 'SERVICE_UNAVAILABLE',
        error: 'Database is not initialized.'
      };
    }

    const cleanConvId = (conversationId || '').trim().toLowerCase();
    const cleanAgentId = (agentId || '').trim().toLowerCase();
    if (!isValidUuid(cleanConvId) || !isValidUuid(cleanAgentId)) {
      return {
        success: false,
        messages: [],
        errorCode: 'INVALID_UUID',
        error: 'Both conversationId and agentId must be canonical UUIDs.'
      };
    }

    if (cleanConvId !== cleanAgentId) {
      return {
        success: false,
        messages: [],
        errorCode: 'INVALID_PRIVATE_CONVERSATION',
        error: 'Invalid private conversation identifier.'
      };
    }

    if (db.getChannelById(cleanConvId)) {
      return {
        success: false,
        messages: [],
        errorCode: 'GROUP_CHANNEL_NOT_SUPPORTED',
        error: 'Group channels are not allowed in PrivateChatService.'
      };
    }

    const agent = db.getAgentById(cleanAgentId);
    if (!agent) {
      return {
        success: false,
        messages: [],
        errorCode: 'AGENT_NOT_FOUND',
        error: 'Target agent does not exist.'
      };
    }

    return {
      success: true,
      messages: db.getMessages(cleanConvId)
    };
  }

  public async cancelConversation(
    conversationId: string
  ): Promise<{ success: boolean; lifecycleState: PrivateChatLifecycleState }> {
    const cleanConvId = (conversationId || '').trim().toLowerCase();
    if (!isValidUuid(cleanConvId)) {
      return { success: false, lifecycleState: 'idle' };
    }

    const active = this.activeTurns.get(cleanConvId);
    if (!active) {
      return {
        success: true,
        lifecycleState: this.getLifecycleState(cleanConvId)
      };
    }

    this.setLifecycleState(cleanConvId, 'cancelled');
    active.controller.abort();
    try {
      await active.runtime.cancel(active.turnId);
    } catch {
      // Ignore cancel cleanup errors
    } finally {
      this.activeTurns.delete(cleanConvId);
    }

    return {
      success: true,
      lifecycleState: 'cancelled'
    };
  }

  public async cancelAll(): Promise<void> {
    const ids = [...this.activeTurns.keys()];
    await Promise.allSettled(ids.map((id) => this.cancelConversation(id)));
  }

  public async sendPrivateMessage(
    intent: PrivateChatSendIntent
  ): Promise<PrivateChatSendResult> {
    const rawConvId = typeof intent?.conversationId === 'string' ? intent.conversationId.trim() : '';
    const rawAgentId = typeof intent?.agentId === 'string' ? intent.agentId.trim() : '';
    const rawContent = typeof intent?.content === 'string' ? intent.content.trim() : '';
    const rawReplyToId =
      typeof intent?.replyToMessageId === 'string' && intent.replyToMessageId.trim()
        ? intent.replyToMessageId.trim()
        : undefined;
    const rawRequestId =
      typeof intent?.requestId === 'string' && intent.requestId.trim()
        ? intent.requestId.trim()
        : undefined;

    if (!rawConvId || !rawAgentId) {
      return {
        success: false,
        conversationId: rawConvId,
        agentId: rawAgentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_CONVERSATION',
        error: 'Both conversationId and agentId are required for private chat.'
      };
    }

    // Strict canonical UUID validation on Main IPC boundary (HIGH-01 / MED-03)
    if (!isValidUuid(rawConvId) || !isValidUuid(rawAgentId)) {
      return {
        success: false,
        conversationId: rawConvId,
        agentId: rawAgentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_UUID',
        error: 'conversationId and agentId must be canonical UUIDs without prefixes.'
      };
    }

    const conversationId = rawConvId.toLowerCase();
    const agentId = rawAgentId.toLowerCase();

    // Strict 1:1 private conversation rule: conversationId must match agentId
    if (conversationId !== agentId) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_PRIVATE_CONVERSATION',
        error: 'Private chat requires a 1:1 conversation matching the target agentId.'
      };
    }

    if (rawRequestId !== undefined && !isValidUuid(rawRequestId)) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_REQUEST_ID',
        error: 'requestId must be a canonical UUID without prefixes.'
      };
    }

    const requestId = rawRequestId ? rawRequestId.toLowerCase() : randomUUID().toLowerCase();

    if (rawReplyToId !== undefined && !isValidUuid(rawReplyToId)) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_REPLY_TARGET',
        error: 'replyToMessageId must be a canonical UUID.'
      };
    }

    const replyToMessageId = rawReplyToId ? rawReplyToId.toLowerCase() : undefined;

    if (!rawContent) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'EMPTY_MESSAGE',
        error: 'Message content cannot be empty.'
      };
    }

    if (rawContent.length > MAX_PRIVATE_MESSAGE_LENGTH) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'MESSAGE_TOO_LONG',
        error: `Message content exceeds maximum allowed length of ${MAX_PRIVATE_MESSAGE_LENGTH} characters.`
      };
    }

    const db = this.getDb();
    const vault = this.getVault();
    if (!db || !vault) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'SERVICE_UNAVAILABLE',
        error: 'Chat service dependencies are not initialized.'
      };
    }

    // Reject if conversationId belongs to a group channel
    if (db.getChannelById(conversationId)) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'GROUP_CHANNEL_NOT_SUPPORTED',
        error: 'PrivateChatService only handles 1:1 agent conversations.'
      };
    }

    // Validate agent existence from authoritative SQLite database
    const agent = db.getAgentById(agentId);
    if (!agent) {
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'AGENT_NOT_FOUND',
        error: 'Target AI agent was not found.'
      };
    }

    // Guard against duplicate submission or concurrent overlapping turn in the same conversation (MED-01)
    const existingActive = this.activeTurns.get(conversationId);
    if (existingActive) {
      const isSameRequestId =
        rawRequestId !== undefined && existingActive.requestId === requestId;
      return {
        success: false,
        conversationId,
        agentId,
        turnId: existingActive.turnId,
        lifecycleState: this.getLifecycleState(conversationId),
        errorCode: isSameRequestId ? 'DUPLICATE_SUBMISSION' : 'CONVERSATION_BUSY',
        error: isSameRequestId
          ? 'Duplicate message submission ignored while request is already in progress.'
          : 'Agent is already responding in this conversation.'
      };
    }

    // Persistent SQLite-backed idempotency check across restarts (MED-01)
    let reusableUserMessage: Message | null = null;
    if (rawRequestId !== undefined) {
      const existingByRequest = db.getMessagesByRequestId(conversationId, requestId);
      const persistedUser = existingByRequest.find((m) => m.senderType === 'user');
      const persistedAgent = existingByRequest.find((m) => m.senderType === 'agent');
      if (persistedUser && persistedAgent) {
        this.setLifecycleState(conversationId, 'completed');
        return {
          success: true,
          conversationId,
          agentId: agent.id,
          lifecycleState: 'completed',
          userMessage: persistedUser,
          agentMessage: persistedAgent
        };
      }
      if (persistedUser && !persistedAgent) {
        reusableUserMessage = persistedUser;
      }
    }

    // Validate optional replyToMessageId strictly against the target conversation (MED-03)
    let quotedMessage: QuotedMessage | undefined;
    if (replyToMessageId) {
      const targetMsg = db.getMessageById(conversationId, replyToMessageId);
      if (!targetMsg) {
        return {
          success: false,
          conversationId,
          agentId,
          lifecycleState: 'failed',
          errorCode: 'REPLY_TARGET_NOT_FOUND',
          error: 'The referenced replyToMessageId does not exist in this conversation.'
        };
      }
      quotedMessage = {
        id: targetMsg.id,
        senderName: targetMsg.senderName,
        content: targetMsg.content
      };
    }

    // Pre-flight OpenRouter credential & configuration validation BEFORE persisting user message (MED-02)
    const gatewayStatus = vault.getOpenRouterCredentialStatus();
    if (gatewayStatus.validationStatus === 'migration_required') {
      this.setLifecycleState(conversationId, 'failed');
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'MIGRATION_REQUIRED',
        error:
          gatewayStatus.migrationError ||
          'Stored OpenRouter key requires re-entry in Settings.'
      };
    }

    if (!gatewayStatus.hasKey) {
      this.setLifecycleState(conversationId, 'failed');
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'NO_API_KEY',
        error:
          'No OpenRouter API key configured. Please set your OpenRouter API key in Settings.'
      };
    }

    const effectiveBaseUrl =
      isValidOpenRouterBaseUrl(gatewayStatus.baseUrl) ||
      (isCustomGatewayAllowed() && isValidAIGatewayUrl(gatewayStatus.baseUrl))
        ? normalizeOpenRouterBaseUrl(gatewayStatus.baseUrl)
        : OPENROUTER_DEFAULT_BASE_URL;

    const effectiveModel =
      (agent.model && agent.model.trim()) ||
      (gatewayStatus.model && gatewayStatus.model.trim()) ||
      OPENROUTER_DEFAULT_MODEL;

    const configValidation = createOpenRouterConfig({
      model: effectiveModel,
      baseUrl: effectiveBaseUrl,
      credentialRef: 'openrouter',
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries
    });

    if (!configValidation.ok) {
      this.setLifecycleState(conversationId, 'failed');
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_CONFIG',
        error: this.redact(
          configValidation.issues.map((i) => i.message).join('; ')
        )
      };
    }

    let runtime: OpenRouterProviderRuntime;
    try {
      runtime = new OpenRouterProviderRuntime({
        config: configValidation.config,
        credentialBroker: this.credentialBroker,
        fetchImpl: this.fetchImpl
      });
    } catch (err) {
      this.setLifecycleState(conversationId, 'failed');
      const rawErr = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        conversationId,
        agentId,
        lifecycleState: 'failed',
        errorCode: 'INVALID_CONFIG',
        error: this.redact(rawErr)
      };
    }

    // Transition to 'sending' now that all pre-flight checks succeeded
    this.setLifecycleState(conversationId, 'sending');

    const allExistingMessages = db.getMessages(conversationId);
    const sanitizedIncomingContent = this.redact(rawContent);

    // Retry deduplication: if the last persisted message in this conversation is an unanswered
    // user message with the exact same content (e.g. user retrying after a provider 500/timeout),
    // reuse that persisted user message instead of inserting a duplicate row (MED-02).
    if (!reusableUserMessage && allExistingMessages.length > 0) {
      const lastMsg = allExistingMessages[allExistingMessages.length - 1];
      if (
        lastMsg.senderType === 'user' &&
        lastMsg.content === sanitizedIncomingContent
      ) {
        reusableUserMessage = lastMsg;
      }
    }

    const historyBeforeUserMessage = reusableUserMessage
      ? allExistingMessages
          .filter((m) => m.id !== reusableUserMessage!.id)
          .slice(-(this.contextWindowMessages - 1))
      : allExistingMessages.slice(-(this.contextWindowMessages - 1));

    const userMessage =
      reusableUserMessage ??
      db.addMessage(
        conversationId,
        rawContent,
        'user',
        'You',
        LOCAL_USER_SENDER_UUID,
        quotedMessage,
        requestId
      );

    // Pure canonical UUID for turnId without prefixes (HIGH-01)
    const turnId = randomUUID().toLowerCase();
    const controller = new AbortController();
    const activeTurn: ActivePrivateTurn = {
      turnId,
      conversationId,
      agentId: agent.id,
      requestId,
      controller,
      runtime
    };
    this.activeTurns.set(conversationId, activeTurn);

    // Format conversation history into ProviderMessage[]
    const providerMessages: ProviderMessage[] = [
      ...historyBeforeUserMessage.map((m): ProviderMessage => {
        let content = m.content;
        if (m.replyTo) {
          const snippet =
            m.replyTo.content.length > 120
              ? `${m.replyTo.content.slice(0, 120)}...`
              : m.replyTo.content;
          content = `[Replying to ${m.replyTo.senderName}: "${snippet}"]\n${content}`;
        }
        return {
          role: m.senderType === 'user' ? 'user' : 'assistant',
          content
        };
      }),
      {
        role: 'user',
        content: userMessage.content
      }
    ];

    const systemPrompt = buildAuthoritativePrivateSystemPrompt(agent, quotedMessage);
    const turnRequest: TurnRequest = {
      turnId,
      providerId: 'openrouter',
      model: effectiveModel,
      systemPrompt,
      messages: providerMessages,
      temperature: 0.7,
      timeoutMs: this.timeoutMs
    };

    this.setLifecycleState(conversationId, 'responding');

    let accumulatedText = '';
    let providerErr: ProviderError | null = null;
    let finishReason: string | null = null;
    let turnUsage: UsageMetadata | null = null;

    try {
      for await (const event of runtime.startTurn(turnRequest, controller.signal)) {
        if (controller.signal.aborted || this.activeTurns.get(conversationId)?.turnId !== turnId) {
          this.setLifecycleState(conversationId, 'cancelled');
          return {
            success: false,
            conversationId,
            agentId: agent.id,
            turnId,
            lifecycleState: 'cancelled',
            userMessage,
            errorCode: 'CANCELLED',
            error: 'Private chat request was cancelled.'
          };
        }

        if (event.type === 'text_delta') {
          accumulatedText += event.text;
        } else if (event.type === 'error') {
          providerErr = event.error;
        } else if (event.type === 'usage') {
          turnUsage = event.usage;
        } else if (event.type === 'finish') {
          finishReason = event.reason;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        this.setLifecycleState(conversationId, 'cancelled');
        return {
          success: false,
          conversationId,
          agentId,
          turnId,
          lifecycleState: 'cancelled',
          userMessage,
          errorCode: 'CANCELLED',
          error: 'Private chat request was cancelled.'
        };
      }

      this.setLifecycleState(conversationId, 'failed');
      const rawErr = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        conversationId,
        agentId: agent.id,
        turnId,
        lifecycleState: 'failed',
        userMessage,
        errorCode: 'PROVIDER_ERROR',
        error: this.redact(rawErr)
      };
    } finally {
      if (this.activeTurns.get(conversationId)?.turnId === turnId) {
        this.activeTurns.delete(conversationId);
      }
    }

    if (controller.signal.aborted || finishReason === 'cancelled' || providerErr?.code === 'cancelled') {
      this.setLifecycleState(conversationId, 'cancelled');
      return {
        success: false,
        conversationId,
        agentId: agent.id,
        turnId,
        lifecycleState: 'cancelled',
        userMessage,
        errorCode: 'CANCELLED',
        error: 'Private chat request was cancelled.'
      };
    }

    if (providerErr) {
      this.setLifecycleState(conversationId, 'failed');
      return {
        success: false,
        conversationId,
        agentId: agent.id,
        turnId,
        lifecycleState: 'failed',
        userMessage,
        errorCode: providerErr.code.toUpperCase(),
        error: this.redact(providerErr.message)
      };
    }

    const cleanedReply = sanitizeAssistantReplyText(accumulatedText, agent.name);

    db.recordUsage({
      conversationId,
      agentId: agent.id,
      model: effectiveModel,
      provider: 'openrouter',
      inputTokens: turnUsage?.inputTokens ?? null,
      outputTokens: turnUsage?.outputTokens ?? null,
      totalTokens: turnUsage?.totalTokens ?? null
    });

    if (!cleanedReply) {
      this.setLifecycleState(conversationId, 'failed');
      return {
        success: false,
        conversationId,
        agentId: agent.id,
        turnId,
        lifecycleState: 'failed',
        userMessage,
        errorCode: 'EMPTY_RESPONSE',
        error: 'No text response was returned by OpenRouter.'
      };
    }

    // Re-verify target agent still exists in SQLite before persisting reply (LOW-02)
    const currentAgent = db.getAgentById(agent.id);
    if (!currentAgent) {
      this.setLifecycleState(conversationId, 'failed');
      return {
        success: false,
        conversationId,
        agentId: agent.id,
        turnId,
        lifecycleState: 'failed',
        userMessage,
        errorCode: 'AGENT_DELETED',
        error: 'Target AI agent was deleted while the response was being generated.'
      };
    }

    // Persist agent reply strictly to the bound conversationId with authoritative agent identity and requestId
    const agentMessage = db.addMessage(
      conversationId,
      this.redact(cleanedReply),
      'agent',
      currentAgent.name,
      currentAgent.id,
      undefined,
      requestId
    );

    this.setLifecycleState(conversationId, 'completed');

    return {
      success: true,
      conversationId,
      agentId: currentAgent.id,
      turnId,
      lifecycleState: 'completed',
      userMessage,
      agentMessage
    };
  }
}
