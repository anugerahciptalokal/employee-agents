import { mkdirSync, writeFileSync } from 'fs';
import { extname, resolve } from 'path';
import { getDataLayoutPaths } from '../core/data-root';
import {
  HeadlessChromeRemoteManager,
  resolveBrowserProfileDir,
  type BrowserPageSnapshot
} from '../core/browser/headless-chrome-remote';
import {
  extractReadableTextFromHtml,
  isPrivateOrLoopbackHost,
  validateScrapeUrl
} from '../core/browser/scraper';
import type { VaultManager } from '../core/vault/vault-manager';
import type {
  ChatCompletionResult,
  ChatMessage,
  OpenAIToolDefinition,
  TokenUsage
} from '../core/agents/ai-gateway-client';

export interface BrowserSyncEvent {
  action: 'open' | 'navigate';
  url: string;
  title?: string;
  conversationId?: string;
}

export interface SavedMediaAttachment {
  relativePath: string;
  apiUrl: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolLoopResult {
  success: boolean;
  content?: string;
  error?: string;
  usage?: TokenUsage | null;
  savedAttachments: SavedMediaAttachment[];
}

export type RunCompletionFn = (
  targetModel: string,
  targetSystemPrompt: string,
  targetMessages: ChatMessage[],
  tools?: OpenAIToolDefinition[]
) => Promise<ChatCompletionResult>;

export const BROWSER_OPENAI_TOOLS: OpenAIToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open or navigate the live visible Chromium browser to a public http(s) URL.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full http(s) URL to open.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_snapshot',
      description: 'Capture and inspect the current live browser page (URL, visible text with optional pagination, interactive elements, media URLs, screenshot).',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'number', description: 'Optional character offset for reading long documentation pages.' },
          maxChars: { type: 'number', description: 'Optional max characters of visible text to return (default 6000, max 15000).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element on the current live browser page by CSS selector, visible text, or coordinates.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          x: { type: 'number' },
          y: { type: 'number' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input field on the current live browser page and optionally press Enter.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          text: { type: 'string' },
          submit: { type: 'boolean' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the current live browser page up or down.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down'] },
          amount: { type: 'number' }
        },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_download_media',
      description: 'Download an image, poster, or media file using the live browser cookies/session and attach it to the chat.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Optional direct media URL. Omit to auto-pick from current page.' },
          filename: { type: 'string', description: 'Optional target filename.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_vault_login',
      description: 'Log into the current website using encrypted username and password stored in the user Vault (by Vault label or target domain). Never exposes password to chat.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Vault label/key name (e.g. ig_entarsaja).' },
          domain: { type: 'string', description: 'Optional target domain. Defaults to current browser hostname.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch_doc',
      description: 'Fetch a public documentation page, llms.txt, Markdown file, or OpenAPI/Swagger JSON spec directly and return readable text with pagination.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Public http(s) URL of the documentation, llms.txt, or OpenAPI spec.' },
          offset: { type: 'number', description: 'Optional character offset for reading long docs (default 0).' },
          maxChars: { type: 'number', description: 'Optional max characters to return (default 8000, max 15000).' }
        },
        required: ['url']
      }
    }
  }
];

const TOOL_CALL_REGEX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
const DSML_CALLS_WRAPPER_REGEX = /<[｜|│┃]+\s*DSML\s*[｜|│┃]+\s*calls>([\s\S]*?)<\/[｜|│┃]+\s*DSML\s*[｜|│┃]+\s*calls>/gi;
const DSML_INVOKE_REGEX =
  /<[｜|│┃]+\s*DSML\s*[｜|│┃]+\s*invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)(?:<\/[｜|│┃]+\s*DSML\s*[｜|│┃]+\s*invoke>|<\/tool_call>|$)/gi;
const DSML_PARAM_REGEX =
  /<[｜|│┃]+\s*DSML\s*[｜|│┃]+\s*parameter\s+name=["']([^"']+)["'](?:\s+string=["']([^"']+)["'])?[^>]*>([\s\S]*?)(?:<\/[｜|│┃]+\s*DSML\s*[｜|│┃]+\s*parameter>|$)/gi;
const STRAY_TOOL_TAG_REGEX = /<\/?(?:[｜|│┃]+\s*DSML\s*[｜|│┃]+[^>\n]*|tool_call)>/gi;

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function buildBrowserToolsSystemPrompt(
  browserStatus: {
    isRunning: boolean;
    currentUrl: string;
  },
  vaultEntries?: Array<{ name: string; category: string; serviceDomain?: string }>
): string {
  const statusLine = browserStatus.isRunning
    ? `Live Browser Status: OPEN at ${browserStatus.currentUrl}`
    : 'Live Browser Status: Not open yet (calling browser_open will launch it and show it live to the user).';

  const vaultSummaryLine =
    vaultEntries && vaultEntries.length > 0
      ? `Available Vault Labels (no secrets shown): ${vaultEntries
          .map((v) => `${v.name}${v.serviceDomain ? ` (domain: ${v.serviceDomain})` : ''}`)
          .join(', ')}`
      : 'Available Vault Labels: none saved yet.';

  return [
    '## Live Persistent Browser & Media Tools',
    statusLine,
    vaultSummaryLine,
    'You have REAL interactive browser tools connected to a persistent Chromium browser streamed live to the user UI. Cookies and logins persist across turns, and the user can watch and manually log in inside the Live Browser panel.',
    'NEVER claim you do not have a browser or cannot open/download links. When the user asks to open a page, inspect it, click, scroll, type, or download an image/poster/media (even if the URL was sent in an earlier message), call the appropriate tool.',
    '',
    'To call a tool, output ONLY a `<tool_call>` block with valid JSON:',
    '<tool_call>{"name": "tool_name", "arguments": {...}}</tool_call>',
    '',
    'Available tools:',
    '- `browser_open` (alias `browser_navigate`): Open/navigate the live visible browser to a URL. Args: `{"url": "https://..."}`',
    '- `browser_snapshot`: Inspect the current open browser page (URL, visible text, interactive elements, media URLs, screenshot). Supports optional pagination for long docs: `{"offset"?: 0, "maxChars"?: 6000}`',
    '- `browser_click`: Click an element on the current page by CSS selector, visible text, or coordinates. Args: `{"selector"?: "...", "text"?: "...", "x"?: 100, "y"?: 200}`',
    '- `browser_type`: Type text into an input field (optionally submit with Enter). Args: `{"selector"?: "...", "text": "...", "submit"?: true}`',
    '- `browser_scroll`: Scroll the current page up or down. Args: `{"direction": "down" | "up", "amount"?: 600}`',
    '- `browser_download_media`: Download an image/poster/video from a URL or automatically from the current live browser page using the browser cookies/session, and attach it to the chat. Args: `{"url"?: "https://...", "filename"?: "poster.jpg"}`',
    '- `browser_vault_login`: Log into the current website using encrypted username & password stored in the user Vault (by Vault label or domain). Args: `{"label"?: "...", "domain"?: "..."}`',
    '- `web_fetch_doc`: Fetch a public documentation page, `llms.txt`, Markdown, or OpenAPI/Swagger JSON spec directly with pagination (`offset`, `maxChars`). Args: `{"url": "https://...", "offset"?: 0, "maxChars"?: 8000}`',
    '',
    'Rules:',
    '- After emitting `<tool_call>...</tool_call>`, wait for the `[Tool Observation]` before giving your final answer.',
    '- When you are ready to answer the user, respond normally WITHOUT `<tool_call>` tags.',
    '- If a page shows a login wall / age gate, first call `browser_vault_login` for that domain. If the Vault has no saved credentials for that domain, tell the user to add their username and password for that domain in **Settings -> Vault** and then say "lanjut".',
    '- If a page shows a CAPTCHA, "Verify you are human", or 2FA/OTP challenge, STOP immediately (never attempt to bypass CAPTCHA). Tell the user to complete the CAPTCHA/2FA in the Live Browser panel and then say "lanjut".'
  ].join('\n');
}

export function shouldAutoOpenBrowserForRequest(messages: ChatMessage[]): boolean {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return false;
  const text =
    typeof lastUser.content === 'string'
      ? lastUser.content
      : Array.isArray(lastUser.content)
      ? (lastUser.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join(' ')
      : '';
  return /\b(?:buka|open|tampilkan|lihat|show)\b[\s\S]{0,30}browser\b|\b(?:di\s*|live\s*)browser\b/i.test(text);
}

export function detectCaptchaOr2FA(text: string): string | null {
  if (!text) return null;
  if (/recaptcha|hcaptcha|turnstile|i['’]m not a robot|verify you are human|are you human|captcha|security check|bukan robot/i.test(text)) {
    return 'CAPTCHA / human verification detected';
  }
  if (/two[- ]factor|2fa|authentication code|verification code|enter the code|kode verifikasi|one[- ]time password|\botp\b/i.test(text)) {
    return '2FA / OTP verification detected';
  }
  return null;
}

function parseDsmlInvokeBlocks(source: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  DSML_INVOKE_REGEX.lastIndex = 0;
  let invokeMatch: RegExpExecArray | null;

  while ((invokeMatch = DSML_INVOKE_REGEX.exec(source)) !== null) {
    const toolName = invokeMatch[1].trim();
    const body = invokeMatch[2] || '';
    if (!toolName) continue;

    let args: Record<string, unknown> = {};
    DSML_PARAM_REGEX.lastIndex = 0;
    let paramMatch: RegExpExecArray | null;
    let hasParamTags = false;

    while ((paramMatch = DSML_PARAM_REGEX.exec(body)) !== null) {
      hasParamTags = true;
      const paramName = paramMatch[1].trim();
      const isStringAttr = paramMatch[2]?.toLowerCase() === 'true';
      const rawVal = (paramMatch[3] || '').trim();
      if (!paramName) continue;

      let parsedVal: unknown = rawVal;
      if (!isStringAttr) {
        try {
          parsedVal = JSON.parse(rawVal);
        } catch {
          parsedVal = rawVal;
        }
      }

      if (
        paramName === 'arguments' &&
        parsedVal &&
        typeof parsedVal === 'object' &&
        !Array.isArray(parsedVal)
      ) {
        args = { ...args, ...(parsedVal as Record<string, unknown>) };
      } else {
        args[paramName] = parsedVal;
      }
    }

    // Handle hybrid DSML/JSON where body is raw JSON directly (e.g. <｜｜DSML｜｜ invoke name="browser_snapshot">{}</tool_call>)
    if (!hasParamTags) {
      const strippedBody = body
        .replace(STRAY_TOOL_TAG_REGEX, '')
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      if (strippedBody.startsWith('{') && strippedBody.endsWith('}')) {
        try {
          const parsedBody = JSON.parse(strippedBody);
          if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
            args = parsedBody as Record<string, unknown>;
          }
        } catch {
          // Keep empty args
        }
      }
    }

    results.push({ name: toolName, arguments: args });
  }

  return results;
}

export function parseToolCalls(text: string): {
  toolCalls: ParsedToolCall[];
  cleanText: string;
} {
  if (!text) return { toolCalls: [], cleanText: '' };
  const toolCalls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_CALL_REGEX.lastIndex = 0;

  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    const rawJson = match[1]
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (!rawJson) continue;
    try {
      const parsed = JSON.parse(rawJson) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name === 'string' && parsed.name.trim()) {
        toolCalls.push({
          name: parsed.name.trim(),
          arguments:
            parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
              ? (parsed.arguments as Record<string, unknown>)
              : {}
        });
      }
    } catch {
      // Ignore malformed tool call JSON
    }
  }

  // Also parse DeepSeek DSML tool-call markup (e.g. <｜DSML｜calls><｜DSML｜invoke name="...">...)
  toolCalls.push(...parseDsmlInvokeBlocks(text));

  const cleanText = text
    .replace(TOOL_CALL_REGEX, '')
    .replace(DSML_CALLS_WRAPPER_REGEX, '')
    .replace(DSML_INVOKE_REGEX, '')
    .replace(STRAY_TOOL_TAG_REGEX, '')
    .trim();
  return { toolCalls, cleanText };
}

function paginateTextSlice(
  text: string,
  offsetRaw?: unknown,
  maxCharsRaw?: unknown,
  defaultMaxChars = 6000
): { slice: string; footer: string } {
  const offset =
    typeof offsetRaw === 'number' && Number.isFinite(offsetRaw) && offsetRaw > 0
      ? Math.floor(offsetRaw)
      : 0;
  const maxChars =
    typeof maxCharsRaw === 'number' && Number.isFinite(maxCharsRaw) && maxCharsRaw > 0
      ? Math.min(15_000, Math.max(500, Math.floor(maxCharsRaw)))
      : defaultMaxChars;

  if (offset >= text.length) {
    return {
      slice: '',
      footer: `\n[End of text: total ${text.length} chars, requested offset ${offset}]`
    };
  }

  const end = Math.min(text.length, offset + maxChars);
  const slice = text.slice(offset, end);
  const footer =
    end < text.length
      ? `\n[Truncated: showing chars ${offset}-${end} of ${text.length}. Pass {"offset": ${end}} to read the next section.]`
      : offset > 0
      ? `\n[Showing chars ${offset}-${end} of ${text.length} (end of page).]`
      : '';
  return { slice, footer };
}

function formatSnapshotObservation(
  snap: BrowserPageSnapshot | null,
  options?: { offset?: unknown; maxChars?: unknown }
): string {
  if (!snap) return 'Browser snapshot unavailable.';
  const lines: string[] = [
    `URL: ${snap.url}`,
    `Title: ${snap.title}`
  ];
  if (snap.ogDescription) {
    lines.push(`Description: ${snap.ogDescription}`);
  }
  if (snap.mediaUrls && snap.mediaUrls.length > 0) {
    lines.push(`Media URLs on page:\n${snap.mediaUrls.map((u, i) => `  [${i + 1}] ${u}`).join('\n')}`);
  }
  if (snap.interactiveElements && snap.interactiveElements.length > 0) {
    const elems = snap.interactiveElements
      .slice(0, 40)
      .map((el) => `  [${el.index}] <${el.tag}> "${el.text}" (${el.x}, ${el.y})${el.href ? ` -> ${el.href}` : ''}`)
      .join('\n');
    lines.push(`Interactive elements:\n${elems}`);
  }
  if (snap.text) {
    const { slice, footer } = paginateTextSlice(snap.text, options?.offset, options?.maxChars, 6000);
    lines.push(`Visible page text:\n${slice}${footer}`);
  }
  return lines.join('\n');
}

function guessExtensionFromMime(mimeType: string, sourceUrl: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('png')) return '.png';
  if (lower.includes('webp')) return '.webp';
  if (lower.includes('gif')) return '.gif';
  if (lower.includes('mp4')) return '.mp4';
  if (lower.includes('pdf')) return '.pdf';
  if (lower.includes('jpeg') || lower.includes('jpg')) return '.jpg';
  try {
    const urlExt = extname(new URL(sourceUrl).pathname).toLowerCase();
    if (urlExt && urlExt.length <= 5) return urlExt;
  } catch {
    // Ignore
  }
  return '.jpg';
}

export function resolveBrowserAttachmentDir(conversationId: string, dataRoot?: string): string {
  const safeConv = (conversationId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return resolve(getDataLayoutPaths(dataRoot).attachmentsDir, safeConv);
}

async function downloadMediaWithBrowserSession(options: {
  manager: HeadlessChromeRemoteManager;
  targetUrl?: string;
  filename?: string;
  conversationId: string;
  dataRoot?: string;
}): Promise<{ ok: boolean; message: string; attachment?: SavedMediaAttachment }> {
  let candidateUrl = options.targetUrl?.trim();
  const status = options.manager.getStatus();

  if (!candidateUrl) {
    const snap = await options.manager.snapshot();
    candidateUrl = snap?.mediaUrls?.[0] || snap?.ogImage;
  }

  if (!candidateUrl || !/^https?:\/\//i.test(candidateUrl)) {
    return {
      ok: false,
      message:
        'No downloadable media URL found on the current browser page. Open the target post/page first or provide a direct media URL.'
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(candidateUrl);
  } catch {
    return { ok: false, message: `Invalid media URL: ${candidateUrl}` };
  }

  if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    return { ok: false, message: `Blocked private/loopback host: ${parsedUrl.hostname}` };
  }

  try {
    const cookies = await options.manager.getCookies([candidateUrl, status.currentUrl].filter(Boolean));
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    const headers: Record<string, string> = {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8'
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }
    if (status.currentUrl && /^https?:\/\//i.test(status.currentUrl)) {
      headers.Referer = status.currentUrl;
    }

    const res = await fetch(candidateUrl, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000)
    });

    if (!res.ok) {
      return {
        ok: false,
        message: `Download failed with HTTP ${res.status} (${res.statusText}) for ${candidateUrl}.`
      };
    }

    const contentType = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    if (buffer.byteLength === 0 || buffer.byteLength > 20 * 1024 * 1024) {
      return {
        ok: false,
        message: `Downloaded file size (${buffer.byteLength} bytes) is empty or exceeds 20MB limit.`
      };
    }

    const safeConv = options.conversationId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const targetDir = resolveBrowserAttachmentDir(options.conversationId, options.dataRoot);
    mkdirSync(targetDir, { recursive: true });

    const ext = guessExtensionFromMime(contentType, candidateUrl);
    const rawName = options.filename?.trim().replace(/[^a-zA-Z0-9._-]/g, '_') || `media_${Date.now()}${ext}`;
    const fileName = extname(rawName) ? rawName : `${rawName}${ext}`;
    const filePath = resolve(targetDir, fileName);
    writeFileSync(filePath, buffer);

    const relativePath = `attachments/${safeConv}/${fileName}`;
    const attachment: SavedMediaAttachment = {
      relativePath,
      apiUrl: `/api/attachments/${safeConv}/${fileName}`,
      fileName,
      mimeType: contentType,
      size: buffer.byteLength
    };

    return {
      ok: true,
      message: `Downloaded and saved ${fileName} (${contentType}, ${buffer.byteLength} bytes) to ${relativePath}.`,
      attachment
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Failed to download media.'
    };
  }
}

async function fetchDocumentationUrl(options: {
  url: string;
  offset?: unknown;
  maxChars?: unknown;
}): Promise<string> {
  let safeUrl: string;
  try {
    safeUrl = validateScrapeUrl(options.url);
  } catch (err) {
    return `[web_fetch_doc] Invalid URL: ${err instanceof Error ? err.message : String(err)}`;
  }

  const parsed = new URL(safeUrl);
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    return `[web_fetch_doc] Blocked private/loopback host: ${parsed.hostname}`;
  }

  try {
    const res = await fetch(safeUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Accept: 'text/markdown, text/plain, application/json, application/yaml, text/html;q=0.9, */*;q=0.5'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000)
    });

    if (!res.ok) {
      return `[web_fetch_doc] HTTP ${res.status} (${res.statusText}) for ${safeUrl}`;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const rawBody = await res.text();

    let title = safeUrl;
    let bodyText = rawBody;

    if (contentType.includes('application/json') || safeUrl.toLowerCase().endsWith('.json')) {
      try {
        bodyText = JSON.stringify(JSON.parse(rawBody), null, 2);
      } catch {
        bodyText = rawBody;
      }
    } else if (contentType.includes('text/html') || /^\s*<!doctype\s+html|^\s*<html/i.test(rawBody)) {
      const extracted = extractReadableTextFromHtml(rawBody);
      title = extracted.title || safeUrl;
      bodyText = extracted.text;
    }

    const { slice, footer } = paginateTextSlice(bodyText, options.offset, options.maxChars, 8000);
    const jsHint =
      bodyText.trim().length < 150
        ? '\n[Note: Static HTTP fetch returned very little readable text (likely JS-rendered/SPA or auth-gated). Use browser_open + browser_snapshot instead.]'
        : '';

    return `[web_fetch_doc]\nURL: ${res.url || safeUrl}\nTitle: ${title}\nContent-Type: ${contentType || 'unknown'}\n\n${slice}${footer}${jsHint}`;
  } catch (err) {
    return `[web_fetch_doc] Fetch failed for ${safeUrl}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function runAgentToolLoop(params: {
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  conversationId: string;
  conversationType: 'agent' | 'channel';
  runCompletion: RunCompletionFn;
  vault?: VaultManager;
  onBrowserEvent?: (event: BrowserSyncEvent) => void;
  maxSteps?: number;
  dataRoot?: string;
}): Promise<AgentToolLoopResult> {
  const manager = HeadlessChromeRemoteManager.getInstance();
  const profileDir = resolveBrowserProfileDir(
    params.conversationId,
    params.conversationType,
    params.dataRoot
  );
  const scopeKey = `${params.conversationType}:${params.conversationId}`;
  const maxSteps = params.maxSteps ?? 15;
  const savedAttachments: SavedMediaAttachment[] = [];
  const allowAutoOpenUi = shouldAutoOpenBrowserForRequest(params.messages);

  const handleSnapshotChallenge = (snap: BrowserPageSnapshot | null): string => {
    const challenge = snap?.text ? detectCaptchaOr2FA(snap.text) : null;
    if (!challenge || !snap) return '';
    params.onBrowserEvent?.({
      action: 'open',
      url: snap.url,
      title: snap.title,
      conversationId: params.conversationId
    });
    return `\n[HANDOFF REQUIRED — ${challenge}]: STOP calling tools now. The Live Browser has been opened on this page so the user can complete the CAPTCHA/2FA manually. Ask the user to complete it in the Live Browser panel and reply "lanjut".`;
  };

  const workingMessages: ChatMessage[] = [...params.messages];
  const totalUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };

  const accumulateUsage = (u?: AgentToolLoopResult['usage']) => {
    if (!u) return;
    if (typeof u.inputTokens === 'number') totalUsage.inputTokens += u.inputTokens;
    if (typeof u.outputTokens === 'number') totalUsage.outputTokens += u.outputTokens;
    if (typeof u.totalTokens === 'number') totalUsage.totalTokens += u.totalTokens;
    if (typeof u.costUsd === 'number') totalUsage.costUsd += u.costUsd;
  };

  for (let step = 0; step < maxSteps; step++) {
    const vaultEntries = params.vault?.listCredentials?.() ?? [];
    const toolInstructions = buildBrowserToolsSystemPrompt(manager.getStatus(scopeKey), vaultEntries);
    const composedSystemPrompt = [params.systemPrompt, toolInstructions].filter(Boolean).join('\n\n');

    const completion = await params.runCompletion(
      params.model,
      composedSystemPrompt,
      workingMessages,
      BROWSER_OPENAI_TOOLS
    );
    accumulateUsage(completion.usage);

    const nativeCalls: ParsedToolCall[] = Array.isArray(completion.toolCalls)
      ? completion.toolCalls.map((tc) => ({
          name: tc.name,
          arguments: tc.arguments || {}
        }))
      : [];

    if (!completion.success || (!completion.content && nativeCalls.length === 0)) {
      return {
        success: false,
        error: completion.error || 'Model completion failed.',
        usage: totalUsage,
        savedAttachments
      };
    }

    const { toolCalls: textCalls, cleanText } = parseToolCalls(completion.content || '');
    const toolCalls = nativeCalls.length > 0 ? nativeCalls : textCalls;
    if (toolCalls.length === 0) {
      return {
        success: true,
        content: cleanText || completion.content || '',
        usage: totalUsage,
        savedAttachments
      };
    }

    const observationParts: string[] = [];
    let latestScreenshotDataUrl: string | undefined;

    for (const call of toolCalls) {
      const args = call.arguments || {};
      switch (call.name) {
        case 'browser_open':
        case 'browser_navigate': {
          const url = typeof args.url === 'string' ? args.url.trim() : '';
          if (!url || !/^https?:\/\//i.test(url)) {
            observationParts.push(`[${call.name}] Error: invalid or missing http(s) URL.`);
            break;
          }
          let parsed: URL;
          try {
            parsed = new URL(url);
          } catch {
            observationParts.push(`[${call.name}] Error: malformed URL "${url}".`);
            break;
          }
          if (isPrivateOrLoopbackHost(parsed.hostname)) {
            observationParts.push(`[${call.name}] Error: blocked private/loopback host "${parsed.hostname}".`);
            break;
          }

          const snap = await manager.navigateAndCapture(url, profileDir, scopeKey);
          if (allowAutoOpenUi || args.show_ui === true) {
            params.onBrowserEvent?.({
              action: 'open',
              url: snap?.url || url,
              title: snap?.title,
              conversationId: params.conversationId
            });
          }
          if (snap?.screenshotDataUrl) latestScreenshotDataUrl = snap.screenshotDataUrl;
          const challengeNote = handleSnapshotChallenge(snap);
          observationParts.push(`[${call.name}] Opened live browser.\n${formatSnapshotObservation(snap)}${challengeNote}`);
          break;
        }
        case 'browser_snapshot': {
          const snap = await manager.snapshot(profileDir, scopeKey);
          if (snap?.screenshotDataUrl) latestScreenshotDataUrl = snap.screenshotDataUrl;
          const challengeNote = handleSnapshotChallenge(snap);
          observationParts.push(
            `[browser_snapshot]\n${formatSnapshotObservation(snap, {
              offset: args.offset,
              maxChars: args.maxChars
            })}${challengeNote}`
          );
          break;
        }
        case 'browser_click': {
          const res = await manager.clickElement({
            selector: typeof args.selector === 'string' ? args.selector : undefined,
            text: typeof args.text === 'string' ? args.text : undefined,
            x: typeof args.x === 'number' ? args.x : undefined,
            y: typeof args.y === 'number' ? args.y : undefined
          });
          if (res.snapshot?.screenshotDataUrl) latestScreenshotDataUrl = res.snapshot.screenshotDataUrl;
          const challengeNote = handleSnapshotChallenge(res.snapshot);
          observationParts.push(
            `[browser_click] ${res.ok ? 'OK' : 'FAILED'}: ${res.message}\n${formatSnapshotObservation(res.snapshot)}${challengeNote}`
          );
          break;
        }
        case 'browser_type': {
          const res = await manager.typeText({
            selector: typeof args.selector === 'string' ? args.selector : undefined,
            text: typeof args.text === 'string' ? args.text : '',
            submit: Boolean(args.submit)
          });
          if (res.snapshot?.screenshotDataUrl) latestScreenshotDataUrl = res.snapshot.screenshotDataUrl;
          const challengeNote = handleSnapshotChallenge(res.snapshot);
          observationParts.push(
            `[browser_type] ${res.ok ? 'OK' : 'FAILED'}: ${res.message}\n${formatSnapshotObservation(res.snapshot)}${challengeNote}`
          );
          break;
        }
        case 'browser_scroll': {
          const dir = args.direction === 'up' ? 'up' : 'down';
          const res = await manager.scrollPage({
            direction: dir,
            amount: typeof args.amount === 'number' ? args.amount : undefined
          });
          if (res.snapshot?.screenshotDataUrl) latestScreenshotDataUrl = res.snapshot.screenshotDataUrl;
          observationParts.push(
            `[browser_scroll] ${res.ok ? 'OK' : 'FAILED'}: ${res.message}\n${formatSnapshotObservation(res.snapshot)}`
          );
          break;
        }
        case 'browser_download_media': {
          const dl = await downloadMediaWithBrowserSession({
            manager,
            targetUrl: typeof args.url === 'string' ? args.url : undefined,
            filename: typeof args.filename === 'string' ? args.filename : undefined,
            conversationId: params.conversationId,
            dataRoot: params.dataRoot
          });
          if (dl.attachment) {
            savedAttachments.push(dl.attachment);
          }
          observationParts.push(`[browser_download_media] ${dl.ok ? 'OK' : 'FAILED'}: ${dl.message}`);
          break;
        }
        case 'browser_vault_login': {
          const currentUrl = manager.getStatus().currentUrl;
          const requestedLabel =
            (typeof args.label === 'string' && args.label.trim()) ||
            (typeof args.vault_label === 'string' && args.vault_label.trim()) ||
            (typeof args.key === 'string' && args.key.trim()) ||
            '';
          const targetDomain = (typeof args.domain === 'string' && args.domain.trim()) || currentUrl;

          let cred =
            (requestedLabel ? params.vault?.findSiteLoginCredential(requestedLabel) : null) ||
            params.vault?.findSiteLoginCredential(targetDomain) ||
            null;

          // Fallback: if the user explicitly mentioned a saved Vault label in their message, match it
          if (!cred && params.vault) {
            const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
            const userText =
              typeof lastUser?.content === 'string'
                ? lastUser.content.toLowerCase()
                : '';
            if (userText) {
              const allEntries = params.vault.listCredentials?.() ?? [];
              const mentioned = allEntries.find((c) => userText.includes(c.name.toLowerCase()));
              if (mentioned) {
                cred = params.vault.findSiteLoginCredential(mentioned.name);
              }
            }
          }

          if (!cred) {
            observationParts.push(
              `[browser_vault_login] NO_CREDENTIAL: No login credential found in Vault for "${requestedLabel || targetDomain}". Tell the user to add username and password in Settings -> Vault, then reply "lanjut".`
            );
            break;
          }
          const fillRes = await manager.fillVisibleLoginForm({
            username: cred.username,
            password: cred.password
          });
          if (fillRes.snapshot?.screenshotDataUrl) latestScreenshotDataUrl = fillRes.snapshot.screenshotDataUrl;
          const challengeNote = handleSnapshotChallenge(fillRes.snapshot);
          observationParts.push(
            `[browser_vault_login] ${fillRes.ok ? 'SUBMITTED' : 'FAILED'} using Vault credential "${cred.name}": ${fillRes.message}\n${formatSnapshotObservation(fillRes.snapshot)}${challengeNote}`
          );
          break;
        }
        case 'web_fetch_doc': {
          const docUrl = typeof args.url === 'string' ? args.url : '';
          const docObs = await fetchDocumentationUrl({
            url: docUrl,
            offset: args.offset,
            maxChars: args.maxChars
          });
          observationParts.push(docObs);
          break;
        }
        default: {
          observationParts.push(`[${call.name}] Error: unknown tool "${call.name}".`);
        }
      }
    }

    workingMessages.push({
      role: 'assistant',
      content:
        completion.content?.trim() ||
        `Calling ${toolCalls.map((c) => c.name).join(', ')}...`
    });

    const obsText = `[Tool Observation]\n${observationParts.join('\n\n')}\n\nNow respond directly to the user in natural language based on the [Tool Observation] above (or call the next tool if needed). Never output "[Executed tools: ...]" or "Calling ...".`;
    if (latestScreenshotDataUrl) {
      workingMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: obsText },
          { type: 'image_url', image_url: { url: latestScreenshotDataUrl } }
        ] as any
      });
    } else {
      workingMessages.push({
        role: 'user',
        content: obsText
      });
    }

    // On final allowed step, if we already have cleanText, avoid looping endlessly
    if (step === maxSteps - 1 && cleanText) {
      return {
        success: true,
        content: cleanText,
        usage: totalUsage,
        savedAttachments
      };
    }
  }

  return {
    success: true,
    content: 'Selesai menjalankan aksi browser. Silakan cek hasilnya di Live Browser.',
    usage: totalUsage,
    savedAttachments
  };
}
