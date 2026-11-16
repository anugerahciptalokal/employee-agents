import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { getDataRootDir } from '../data-root';
import type {
  CodexAuthStatus,
  CodexDeviceLoginChallenge,
  CodexModelInfo
} from '@open-employee/contracts/types';
import type { ChatCompletionResult, ChatMessage } from './ai-gateway-client';

const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

export interface ParsedDeviceAuth {
  verificationUrl: string;
  userCode: string;
}

/**
 * Strips ANSI escape sequences and extracts the verification URL and one-time
 * device code emitted by `codex login --device-auth`.
 */
export function parseCodexDeviceAuthOutput(raw: string): ParsedDeviceAuth | null {
  const clean = (raw || '').replace(ANSI_ESCAPE_REGEX, '');
  const urlMatch = clean.match(/https:\/\/[^\s]+/i);
  const codeMatch = clean.match(/\b([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/);
  if (!urlMatch || !codeMatch) {
    return null;
  }
  return {
    verificationUrl: urlMatch[0].trim(),
    userCode: codeMatch[1].trim()
  };
}

export interface CodexClientOptions {
  codexHome?: string;
  resolveBinary?: () => string | null;
  spawnImpl?: typeof spawn;
}

export interface CodexChatParams {
  model: string;
  systemPrompt?: string;
  messages: ChatMessage[];
  timeoutMs?: number;
}

function defaultResolveBinary(): string | null {
  const envBin = process.env.OPEN_EMPLOYEE_CODEX_BIN?.trim();
  if (envBin && existsSync(envBin)) {
    return envBin;
  }

  const localBin = resolve(
    process.cwd(),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'codex.cmd' : 'codex'
  );
  if (existsSync(localBin)) {
    return localBin;
  }

  return 'codex';
}

function formatConversationPrompt(systemPrompt: string | undefined, messages: ChatMessage[]): string {
  const sections: string[] = [];
  if (systemPrompt && systemPrompt.trim()) {
    sections.push(`[System Instructions]\n${systemPrompt.trim()}`);
  }
  for (const msg of messages) {
    if (msg.role === 'system') {
      sections.push(`[System]\n${msg.content}`);
    } else if (msg.role === 'assistant') {
      sections.push(`[Assistant]\n${msg.content}`);
    } else {
      sections.push(`[User]\n${msg.content}`);
    }
  }
  return sections.join('\n\n');
}

const PROACTIVE_WEB_SEARCH_GUIDANCE = [
  'You are chatting as an AI assistant, not editing a repository.',
  'When the user asks about people, public figures, current news, recent events, documentation, or any factual information that benefits from live lookup, proactively use your built-in web_search tool right away without waiting to be asked twice.',
  'Do not claim that you cannot search the internet or verify public information before actually calling web_search.'
].join(' ');

function buildDeveloperInstructions(systemPrompt?: string): string {
  const trimmed = systemPrompt?.trim();
  return trimmed ? `${trimmed}\n\n${PROACTIVE_WEB_SEARCH_GUIDANCE}` : PROACTIVE_WEB_SEARCH_GUIDANCE;
}

export class CodexClient {
  private readonly codexHome: string;
  private readonly resolveBinary: () => string | null;
  private readonly spawnImpl: typeof spawn;
  private activeLoginProc: ChildProcessWithoutNullStreams | null = null;

  constructor(options: CodexClientOptions = {}) {
    this.codexHome = options.codexHome ?? join(getDataRootDir(), 'codex-home');
    this.resolveBinary = options.resolveBinary ?? defaultResolveBinary;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  private ensureCodexHome(): string {
    if (!existsSync(this.codexHome)) {
      mkdirSync(this.codexHome, { recursive: true });
    }
    return this.codexHome;
  }

  private ensureChatCwd(): string {
    const chatCwd = join(this.ensureCodexHome(), 'chat-cwd');
    if (!existsSync(chatCwd)) {
      mkdirSync(chatCwd, { recursive: true });
    }
    return chatCwd;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CODEX_HOME: this.ensureCodexHome()
    };
  }

  private spawnAppServer(): ChildProcessWithoutNullStreams {
    const bin = this.resolveBinary();
    if (!bin) {
      throw new Error('Codex CLI is not available. Install @openai/codex first.');
    }
    return this.spawnImpl(bin, ['app-server'], {
      env: this.buildEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  private async runAppServerSession<T>(
    handler: (
      sendRequest: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
      onNotification: (listener: (method: string, params: Record<string, unknown>) => void) => void
    ) => Promise<T>,
    timeoutMs = 120_000
  ): Promise<T> {
    const proc = this.spawnAppServer();
    let nextId = 1;
    let stdoutBuffer = '';
    const pending = new Map<
      number,
      { resolve: (val: unknown) => void; reject: (err: Error) => void }
    >();
    const notificationListeners: Array<(method: string, params: Record<string, unknown>) => void> =
      [];

    const cleanup = () => {
      for (const entry of pending.values()) {
        entry.reject(new Error('Codex app-server closed unexpectedly.'));
      }
      pending.clear();
      try {
        proc.kill();
      } catch {
        // Ignore cleanup errors
      }
    };

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error('Codex app-server request timed out.'));
      }, timeoutMs);

      proc.on('error', (err) => {
        clearTimeout(timer);
        cleanup();
        rejectPromise(err);
      });

      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString('utf-8');
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(trimmed) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (typeof parsed.id === 'number' && pending.has(parsed.id)) {
            const waiter = pending.get(parsed.id)!;
            pending.delete(parsed.id);
            if (parsed.error && typeof parsed.error === 'object') {
              const errMsg =
                (parsed.error as { message?: string }).message || 'Codex JSON-RPC error';
              waiter.reject(new Error(errMsg));
            } else {
              waiter.resolve(parsed.result);
            }
          } else if (typeof parsed.method === 'string') {
            const params =
              parsed.params && typeof parsed.params === 'object'
                ? (parsed.params as Record<string, unknown>)
                : {};
            for (const listener of notificationListeners) {
              listener(parsed.method, params);
            }
          }
        }
      });

      const sendRequest = (method: string, params: Record<string, unknown> = {}) => {
        const id = nextId++;
        return new Promise<unknown>((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
        });
      };

      const onNotification = (
        listener: (method: string, params: Record<string, unknown>) => void
      ) => {
        notificationListeners.push(listener);
      };

      sendRequest('initialize', {
        clientInfo: { name: 'open-employee', version: '1.0.0' }
      })
        .then(() => handler(sendRequest, onNotification))
        .then((result) => {
          clearTimeout(timer);
          cleanup();
          resolvePromise(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          cleanup();
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  public async getAccountStatus(): Promise<CodexAuthStatus> {
    try {
      const result = await this.runAppServerSession(async (sendRequest) => {
        return sendRequest('account/read', {});
      }, 10_000);

      const record = (result ?? {}) as {
        account?: { type?: string; email?: string | null; planType?: string | null } | null;
      };
      const account = record.account;
      if (account && account.type === 'chatgpt') {
        return {
          available: true,
          connected: true,
          email: account.email ?? null,
          planType: account.planType ?? null
        };
      }
      return {
        available: true,
        connected: false,
        email: null,
        planType: null
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const isMissing = message.includes('ENOENT') || message.includes('not available');
      return {
        available: !isMissing,
        connected: false,
        email: null,
        planType: null,
        error: message
      };
    }
  }

  /**
   * Lists non-hidden models supported by the local Codex CLI for the active account.
   */
  public async listModels(): Promise<CodexModelInfo[]> {
    const result = await this.runAppServerSession(async (sendRequest) => {
      return sendRequest('model/list', {});
    }, 10_000);

    const record = (result ?? {}) as {
      data?: Array<{
        id?: string;
        model?: string;
        displayName?: string;
        hidden?: boolean;
        isDefault?: boolean;
      }>;
    };

    const items = Array.isArray(record.data) ? record.data : [];
    const seen = new Set<string>();
    const models: CodexModelInfo[] = [];
    for (const item of items) {
      if (item.hidden) continue;
      const id = (item.model || item.id || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        displayName: (item.displayName || id).trim(),
        isDefault: Boolean(item.isDefault)
      });
    }
    return models;
  }

  public async startDeviceLogin(): Promise<CodexDeviceLoginChallenge> {
    const bin = this.resolveBinary();
    if (!bin) {
      return {
        success: false,
        error: 'Codex CLI is not available. Install @openai/codex first.'
      };
    }

    if (this.activeLoginProc) {
      try {
        this.activeLoginProc.kill();
      } catch {
        // Ignore
      }
      this.activeLoginProc = null;
    }

    return new Promise<CodexDeviceLoginChallenge>((resolvePromise) => {
      const proc = this.spawnImpl(bin, ['login', '--device-auth'], {
        env: this.buildEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.activeLoginProc = proc;

      let combinedOutput = '';
      let settled = false;

      const finish = (res: CodexDeviceLoginChallenge) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(res);
      };

      const timer = setTimeout(() => {
        finish({
          success: false,
          error: 'Timed out waiting for OpenAI device login link from Codex CLI.'
        });
      }, 10_000);

      const handleChunk = (chunk: Buffer) => {
        combinedOutput += chunk.toString('utf-8');
        const parsed = parseCodexDeviceAuthOutput(combinedOutput);
        if (parsed) {
          finish({
            success: true,
            verificationUrl: parsed.verificationUrl,
            userCode: parsed.userCode
          });
        }
      };

      proc.stdout.on('data', handleChunk);
      proc.stderr.on('data', handleChunk);
      proc.on('error', (err) => {
        finish({ success: false, error: err.message });
      });
      proc.on('exit', (code) => {
        if (this.activeLoginProc === proc) {
          this.activeLoginProc = null;
        }
        if (!settled && code !== 0) {
          finish({
            success: false,
            error: `Codex login exited with code ${code}: ${combinedOutput.trim()}`
          });
        }
      });
    });
  }

  public async logout(): Promise<{ success: boolean; error?: string }> {
    const bin = this.resolveBinary();
    if (!bin) {
      return { success: false, error: 'Codex CLI is not available.' };
    }

    if (this.activeLoginProc) {
      try {
        this.activeLoginProc.kill();
      } catch {
        // Ignore
      }
      this.activeLoginProc = null;
    }

    return new Promise((resolvePromise) => {
      const proc = this.spawnImpl(bin, ['logout'], {
        env: this.buildEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let errOut = '';
      proc.stderr.on('data', (chunk) => {
        errOut += chunk.toString('utf-8');
      });
      proc.on('error', (err) => {
        resolvePromise({ success: false, error: err.message });
      });
      proc.on('exit', (code) => {
        if (code === 0) {
          resolvePromise({ success: true });
        } else {
          resolvePromise({ success: false, error: errOut.trim() || `Logout failed (${code})` });
        }
      });
    });
  }

  public async chatCompletion(params: CodexChatParams): Promise<ChatCompletionResult> {
    try {
      const content = await this.runAppServerSession<string>(async (sendRequest, onNotification) => {
        const threadResult = (await sendRequest('thread/start', {
          ...(params.model ? { model: params.model } : {}),
          cwd: this.ensureChatCwd(),
          approvalPolicy: 'never',
          sandbox: 'read-only',
          config: {
            web_search: 'live'
          },
          developerInstructions: buildDeveloperInstructions(params.systemPrompt)
        })) as { thread?: { id?: string } } | undefined;

        const threadId = threadResult?.thread?.id;
        if (!threadId) {
          throw new Error('Codex app-server did not return a thread ID.');
        }

        const promptText = formatConversationPrompt(undefined, params.messages);
        const commentaryItemIds = new Set<string>();
        const deltasByItem = new Map<string, string>();
        const completedAnswerByItem = new Map<string, string>();
        const answerItemOrder: string[] = [];

        const recordItemId = (id: string) => {
          if (!answerItemOrder.includes(id)) {
            answerItemOrder.push(id);
          }
        };

        return new Promise<string>((resolveTurn, rejectTurn) => {
          onNotification((method, notifParams) => {
            if (method === 'item/started') {
              const item = notifParams.item as { id?: unknown; phase?: unknown } | undefined;
              if (item && typeof item.id === 'string' && item.phase === 'commentary') {
                commentaryItemIds.add(item.id);
              }
            } else if (method === 'item/agentMessage/delta') {
              const delta = notifParams.delta;
              const itemId = typeof notifParams.itemId === 'string' ? notifParams.itemId : '__default__';
              const phase = notifParams.phase;
              if (phase === 'commentary' || commentaryItemIds.has(itemId)) {
                return;
              }
              if (typeof delta === 'string') {
                recordItemId(itemId);
                deltasByItem.set(itemId, (deltasByItem.get(itemId) || '') + delta);
              }
            } else if (method === 'item/completed') {
              const item = notifParams.item as
                | { id?: unknown; type?: unknown; text?: unknown; phase?: unknown }
                | undefined;
              if (item && item.type === 'agentMessage') {
                const itemId = typeof item.id === 'string' ? item.id : '__default__';
                if (item.phase === 'commentary') {
                  commentaryItemIds.add(itemId);
                  deltasByItem.delete(itemId);
                  completedAnswerByItem.delete(itemId);
                  return;
                }
                if (typeof item.text === 'string' && item.text.trim()) {
                  recordItemId(itemId);
                  completedAnswerByItem.set(itemId, item.text);
                }
              }
            } else if (method === 'turn/completed') {
              const turn = notifParams.turn as { status?: string; error?: { message?: string } } | undefined;
              if (turn?.status === 'failed') {
                rejectTurn(new Error(turn.error?.message || 'Codex turn failed.'));
              } else {
                const finalParts: string[] = [];
                for (const id of answerItemOrder) {
                  if (commentaryItemIds.has(id)) continue;
                  const text = completedAnswerByItem.get(id) ?? deltasByItem.get(id) ?? '';
                  if (text) {
                    finalParts.push(text);
                  }
                }
                resolveTurn(finalParts.join('\n\n').trim());
              }
            } else if (method === 'error') {
              if (notifParams.willRetry === true) {
                return;
              }
              const nestedErr =
                notifParams.error && typeof notifParams.error === 'object'
                  ? (notifParams.error as { message?: unknown }).message
                  : undefined;
              const msg =
                typeof notifParams.message === 'string' && notifParams.message.trim()
                  ? notifParams.message
                  : typeof nestedErr === 'string' && nestedErr.trim()
                    ? nestedErr
                    : JSON.stringify(notifParams) || 'Codex turn error.';
              rejectTurn(new Error(msg));
            }
          });

          sendRequest('turn/start', {
            threadId,
            input: [{ type: 'text', text: promptText }]
          }).catch(rejectTurn);
        });
      }, params.timeoutMs ?? 120_000);

      return {
        success: true,
        content
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: message
      };
    }
  }
}

