import { spawn, ChildProcess } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';
import { getDataLayoutPaths } from '../data-root';

/**
 * Headless Chrome remote viewport host (web mode counterpart of OpenBot's WebContentsView).
 * Streams the page via CDP screencast and replays mouse/keyboard input 1:1.
 * The remote viewport always matches the client panel size so pixels map exactly.
 */

interface RemoteBrowserSession {
  chromeProcess: ChildProcess | null;
  cdpWs: WebSocket | null;
  mainFrameId: string | null;
  activeTabId: string | null;
  currentUrl: string;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
}

interface ScopedBrowserContext {
  scopeKey: string;
  profileDir: string;
  browserContextId: string;
  targetId: string;
  pageWs: WebSocket | null;
  currentUrl: string;
  activeTabId: string | null;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  cookiesLoaded: boolean;
}

const CDP_PORT = 9222;
const GLOBAL_INSTANCE_KEY = '__openEmployeeHeadlessChromeManager__';

/**
 * Resolves the partitioned browser profile directory per agent or channel.
 * - Agent:   .data/runtime/browser-sessions/agent-{agentId}/
 * - Channel: .data/runtime/browser-sessions/channel-{channelId}/
 */
export function resolveBrowserProfileDir(
  conversationId?: string,
  conversationType?: 'agent' | 'channel',
  dataRoot?: string
): string {
  const safeId = (conversationId || '').replace(/[^a-zA-Z0-9_-]/g, '_').trim();
  const layout = getDataLayoutPaths(dataRoot);
  let targetDir: string;

  if (conversationType === 'agent' && safeId) {
    targetDir = path.resolve(layout.browserSessionsDir, `agent-${safeId}`);
  } else if (conversationType === 'channel' && safeId) {
    targetDir = path.resolve(layout.browserSessionsDir, `channel-${safeId}`);
  } else if (safeId) {
    targetDir = path.resolve(layout.browserSessionsDir, safeId);
  } else {
    return path.resolve(layout.browserSessionsDir);
  }

  if (!fs.existsSync(targetDir)) {
    try {
      fs.mkdirSync(targetDir, { recursive: true });
    } catch {
      // Ignore if permissions or concurrent call prevents creation
    }
  }

  return targetDir;
}

/**
 * Resolves the Chrome/Chromium executable path across macOS, Linux, and Windows.
 */
export function resolveChromeExecutablePath(): string | null {
  const envOverride = process.env.CHROME_BIN?.trim();
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride;
  }

  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        ]
      : [
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/snap/bin/chromium'
        ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Returns hardened stealth launch flags for headless Chrome to bypass bot & CAPTCHA detection.
 * Includes Linux container flags (`--no-sandbox`, `--disable-dev-shm-usage`) when running on Linux.
 */
export function getChromeLaunchArgs(
  profileDir: string,
  viewportWidth: number,
  viewportHeight: number,
  platform: NodeJS.Platform = process.platform,
  cdpPort = CDP_PORT
): string[] {
  const userAgent =
    platform === 'linux'
      ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

  const args = [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--disable-blink-features=AutomationControlled',
    `--user-agent=${userAgent}`,
    `--window-size=${viewportWidth},${viewportHeight}`
  ];

  if (platform === 'linux') {
    args.push('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  }

  args.push('about:blank');
  return args;
}

/**
 * Returns initialization script injected into every frame to mask navigator.webdriver
 * and emulate a standard desktop Google Chrome environment.
 */
export function getStealthInitScript(): string {
  return `
    try {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
        configurable: true
      });
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          app: {},
          csi: () => {},
          loadTimes: () => {}
        };
      }
      if (!navigator.languages || navigator.languages.length === 0) {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['id-ID', 'id', 'en-US', 'en'],
          configurable: true
        });
      }
    } catch (e) {}
  `;
}

export class HeadlessChromeRemoteManager {
  private static instance: HeadlessChromeRemoteManager;
  private session: RemoteBrowserSession = {
    chromeProcess: null,
    cdpWs: null,
    mainFrameId: null,
    activeTabId: null,
    currentUrl: 'https://www.google.com',
    viewportWidth: 1280,
    viewportHeight: 800,
    deviceScaleFactor: 1
  };

  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private clientScopes = new Map<WebSocket, string>();
  private launchPromise: Promise<void> | null = null;
  private browserCdpWs: WebSocket | null = null;
  private scopedContexts = new Map<string, ScopedBrowserContext>();
  private scopedContextPromises = new Map<string, Promise<ScopedBrowserContext>>();
  private cdpMessageId = 1000;
  private profileDir: string;
  private scopeStates = new Map<string, { isRunning: boolean; currentUrl: string; profileDir?: string }>();
  private activeScopeKey: string | null = null;

  private constructor() {
    this.profileDir = resolveBrowserProfileDir();
  }

  public async switchProfileDir(newProfileDir: string): Promise<void> {
    if (this.profileDir === newProfileDir) return;
    this.profileDir = newProfileDir;

    // Gracefully shut down previous Chrome session so it restarts with the target partitioned profile
    if (this.session.cdpWs && this.session.cdpWs.readyState === WebSocket.OPEN) {
      try {
        this.session.cdpWs.send(JSON.stringify({ id: ++this.cdpMessageId, method: 'Browser.close', params: {} }));
      } catch {}
    }
    this.session.cdpWs?.close();
    this.session.cdpWs = null;
    this.session.mainFrameId = null;

    if (this.session.chromeProcess) {
      try {
        this.session.chromeProcess.kill('SIGTERM');
      } catch {}
      this.session.chromeProcess = null;
    }

    // Wait up to 1.5s for port 9222 to be released
    for (let i = 0; i < 15; i++) {
      if (!(await this.isCdpPortAlive())) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  public static getInstance(): HeadlessChromeRemoteManager {
    if (!HeadlessChromeRemoteManager.instance) {
      // Vite re-evaluates this module on every config restart; retire the previous instance
      // so exactly one CDP session drives the page (stale sessions fight over the viewport size)
      const registry = globalThis as Record<string, unknown>;
      const previous = registry[GLOBAL_INSTANCE_KEY] as { dispose?: () => void } | undefined;
      previous?.dispose?.();
      HeadlessChromeRemoteManager.instance = new HeadlessChromeRemoteManager();
      registry[GLOBAL_INSTANCE_KEY] = HeadlessChromeRemoteManager.instance;
    }
    return HeadlessChromeRemoteManager.instance;
  }

  /** Release sockets without killing Chrome, so the next instance can take over the same browser. */
  public dispose(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
    this.session.cdpWs?.close();
    this.session.cdpWs = null;
  }

  public initWebSocketServer(server: http.Server): void {
    if (this.wss) return;

    // noServer + path filter so Vite's own HMR websocket upgrade is never intercepted
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url || '', 'http://localhost');
      if (pathname === '/api/browser-stream') {
        this.wss?.handleUpgrade(request, socket, head, (ws) => {
          this.wss?.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (ws, request) => {
      this.clients.add(ws);
      try {
        const reqUrl = new URL(request.url || '', 'http://localhost');
        const initialScope = reqUrl.searchParams.get('scope');
        if (initialScope) {
          this.clientScopes.set(ws, initialScope);
        }
      } catch {
        // Ignore URL parse issues
      }

      ws.on('message', async (message) => {
        try {
          const payload = JSON.parse(message.toString());
          await this.handleClientMessage(payload, ws);
        } catch (e) {
          console.error('Invalid client message:', e);
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        this.clientScopes.delete(ws);
      });
    });
  }

  private sendCdp(method: string, params: Record<string, unknown> = {}): void {
    const cdpWs = this.session.cdpWs;
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) return;
    cdpWs.send(JSON.stringify({ id: ++this.cdpMessageId, method, params }));
  }

  private isCdpReady(): boolean {
    return Boolean(this.session.cdpWs && this.session.cdpWs.readyState === WebSocket.OPEN);
  }

  private async ensureChromeRunning(): Promise<void> {
    if (this.isCdpReady()) return;
    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = (async () => {
      try {
        // Reuse an existing Chrome on the CDP port if one is already alive
        const alreadyUp = await this.isCdpPortAlive();
        if (!alreadyUp) {
          const chromePath = resolveChromeExecutablePath();
          if (!chromePath) {
            throw new Error('Chrome/Chromium binary not found. Set CHROME_BIN or install Chromium.');
          }

          const chromeArgs = getChromeLaunchArgs(
            this.profileDir,
            this.session.viewportWidth,
            this.session.viewportHeight
          );
          const chromeProcess = spawn(chromePath, chromeArgs);

          this.session.chromeProcess = chromeProcess;
          chromeProcess.on('exit', () => {
            this.session.chromeProcess = null;
            this.session.cdpWs = null;
          });

          await this.waitForCdpReady();
        }

        await this.connectToCdpPage();
      } finally {
        this.launchPromise = null;
      }
    })();

    return this.launchPromise;
  }

  private isCdpPortAlive(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http
        .get(`http://127.0.0.1:${CDP_PORT}/json/version`, { timeout: 1500 }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        })
        .on('timeout', () => {
          req.destroy();
          resolve(false);
        })
        .on('error', () => resolve(false));
    });
  }

  private async waitForCdpReady(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await this.isCdpPortAlive()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Chrome DevTools Protocol did not become ready');
  }

  private cdpHttp(method: 'GET' | 'PUT', pathname: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: CDP_PORT, path: pathname, method, timeout: 2000 },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              resolve(raw ? JSON.parse(raw) : null);
            } catch {
              resolve(raw);
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`CDP HTTP request to ${pathname} timed out`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async connectToCdpPage(): Promise<void> {
    const targets: any[] = (await this.cdpHttp('GET', '/json/list').catch(() => [])) || [];
    const pages = targets.filter((t) => t.type === 'page');
    const liveUrl = pages.find((p) => p.url && p.url !== 'about:blank')?.url;
    if (liveUrl) this.session.currentUrl = liveUrl;

    let page = pages[0];
    if (!page?.webSocketDebuggerUrl) {
      page = await this.cdpHttp('PUT', `/json/new?${encodeURIComponent(this.session.currentUrl || 'about:blank')}`);
    }

    if (!page?.webSocketDebuggerUrl) {
      throw new Error('Could not create a debuggable page target');
    }

    await new Promise<void>((resolve, reject) => {
      this.session.mainFrameId = page.id;
      const cdpWs = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      this.session.cdpWs = cdpWs;

      cdpWs.on('open', () => {
        this.sendCdp('Page.enable');
        // Headless pages are never "focused" by default, which silently drops keyboard input and carets
        this.sendCdp('Emulation.setFocusEmulationEnabled', { enabled: true });
        this.sendCdp('Page.bringToFront');
        this.sendCdp('Page.addScriptToEvaluateOnNewDocument', {
          source: getStealthInitScript()
        });
        this.applyViewport();
        resolve();
      });

      cdpWs.on('message', (data) => this.handleCdpMessage(data.toString()));
      cdpWs.on('close', () => {
        if (this.session.cdpWs === cdpWs) this.session.cdpWs = null;
      });
      cdpWs.on('error', (err) => reject(err));
    });
  }

  /** Match the remote page size to the client panel and restart the screencast at that size. */
  private applyViewport(): void {
    const { viewportWidth: width, viewportHeight: height, deviceScaleFactor } = this.session;

    // Keep mobile: false so Chrome always runs in desktop mouse mode;
    // mobile: true turns on touch emulation, tap delays, and drops desktop mouse clicks
    // whenever the panel is narrow (e.g. on a laptop screen < 640px)
    this.sendCdp('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false
    });
    this.sendCdp('Page.stopScreencast');
    this.sendCdp('Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: Math.round(width * deviceScaleFactor),
      maxHeight: Math.round(height * deviceScaleFactor),
      everyNthFrame: 1
    });
  }

  private handleCdpMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.method) {
      case 'Page.screencastFrame': {
        this.sendCdp('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
        this.broadcast({ type: 'frame', data: msg.params.data, metadata: msg.params.metadata });
        break;
      }
      case 'Page.frameNavigated': {
        // Ignore iframes (ads, trackers, login widgets) so the address bar shows the real page URL
        const frame = msg.params.frame;
        if (frame && !frame.parentId) {
          this.session.currentUrl = frame.url;
          this.broadcast({ type: 'navigated', url: frame.url, tabId: this.session.activeTabId });
        }
        break;
      }
      case 'Page.navigatedWithinDocument': {
        if (msg.params.frameId === this.session.mainFrameId) {
          this.session.currentUrl = msg.params.url;
          this.broadcast({ type: 'navigated', url: msg.params.url, tabId: this.session.activeTabId });
        }
        break;
      }
      case 'Page.frameStartedLoading': {
        if (msg.params.frameId === this.session.mainFrameId) {
          this.broadcast({ type: 'loading' });
        }
        break;
      }
      case 'Page.loadEventFired': {
        this.broadcast({ type: 'loaded' });
        break;
      }
    }
  }

  private async handleClientMessage(msg: any, ws?: WebSocket): Promise<void> {
    let scopeKey = (ws && this.clientScopes.get(ws)) || 'default';
    let targetProfile = this.profileDir;

    if (
      (msg.type === 'init' || msg.type === 'subscribe') &&
      (msg.conversationId !== undefined || msg.conversationType !== undefined)
    ) {
      const convId = typeof msg.conversationId === 'string' ? msg.conversationId.trim() : '';
      const convType = msg.conversationType === 'channel' ? 'channel' : 'agent';
      if (convId) {
        scopeKey = `${convType}:${convId}`;
        if (ws) this.clientScopes.set(ws, scopeKey);
        const existingCtx = this.scopedContexts.get(scopeKey);
        targetProfile = existingCtx
          ? existingCtx.profileDir
          : resolveBrowserProfileDir(convId, convType);
      }
    }

    if (msg.type === 'subscribe') {
      try {
        const ctx = await this.ensureScopedContext(scopeKey, targetProfile);
        this.applyViewportToScope(ctx);
        this.broadcast(
          { type: 'navigated', url: ctx.currentUrl, tabId: ctx.activeTabId },
          scopeKey
        );
        this.broadcast({ type: 'loaded', tabId: ctx.activeTabId }, scopeKey);
      } catch (e) {
        console.error('Failed to subscribe scoped browser context:', e);
      }
      return;
    }

    let ctx: ScopedBrowserContext;
    try {
      ctx = await this.ensureScopedContext(scopeKey, targetProfile);
    } catch (e) {
      console.error('Failed to start headless Chrome:', e);
      return;
    }

    if (msg.type === 'resize') {
      const width = Math.max(200, Math.round(msg.width || 0));
      const height = Math.max(200, Math.round(msg.height || 0));
      const dpr = Math.min(3, Math.max(1, Number(msg.deviceScaleFactor) || 1));
      ctx.viewportWidth = width;
      ctx.viewportHeight = height;
      ctx.deviceScaleFactor = dpr;
    }

    switch (msg.type) {
      case 'init': {
        this.applyViewportToScope(ctx);
        const hasLiveSession = Boolean(ctx.currentUrl && ctx.currentUrl !== 'about:blank');
        const isSameTabReconnect = Boolean(msg.tabId && ctx.activeTabId && ctx.activeTabId === msg.tabId);
        const isAlreadyOnUrl = Boolean(msg.url && hasLiveSession && ctx.currentUrl === msg.url);
        const isAttachingToAgentSession = Boolean(
          hasLiveSession &&
          !ctx.activeTabId &&
          ctx.currentUrl !== 'https://www.google.com' &&
          (!msg.url || msg.url === 'https://www.google.com' || msg.url === 'https://www.google.com/')
        );

        if ((isSameTabReconnect || isAlreadyOnUrl || isAttachingToAgentSession) && hasLiveSession) {
          if (msg.tabId && !ctx.activeTabId) {
            ctx.activeTabId = msg.tabId;
          }
          this.broadcast({ type: 'navigated', url: ctx.currentUrl, tabId: ctx.activeTabId }, scopeKey);
          this.broadcast({ type: 'loaded', tabId: ctx.activeTabId }, scopeKey);
        } else if (msg.url) {
          ctx.activeTabId = msg.tabId || null;
          ctx.currentUrl = msg.url;
          this.sendCdpToScope(ctx, 'Page.navigate', { url: msg.url });
        }
        break;
      }
      case 'resize': {
        this.applyViewportToScope(ctx);
        break;
      }
      case 'navigate': {
        if (typeof msg.url === 'string' && msg.url) {
          if (msg.tabId) {
            ctx.activeTabId = msg.tabId;
          }
          if (msg.force || ctx.currentUrl !== msg.url) {
            ctx.currentUrl = msg.url;
            this.sendCdpToScope(ctx, 'Page.navigate', { url: msg.url });
          } else {
            this.broadcast({ type: 'navigated', url: ctx.currentUrl, tabId: ctx.activeTabId }, scopeKey);
            this.broadcast({ type: 'loaded', tabId: ctx.activeTabId }, scopeKey);
          }
        }
        break;
      }
      case 'history': {
        const expression = msg.direction === 'back' ? 'history.back()' : 'history.forward()';
        this.sendCdpToScope(ctx, 'Runtime.evaluate', { expression });
        break;
      }
      case 'reload': {
        this.sendCdpToScope(ctx, 'Page.reload', { ignoreCache: false });
        break;
      }
      case 'mouse': {
        this.sendCdpToScope(ctx, 'Input.dispatchMouseEvent', {
          type: msg.action,
          x: msg.x,
          y: msg.y,
          button: msg.button || 'none',
          buttons: msg.buttons ?? 0,
          clickCount: msg.clickCount || 0,
          modifiers: msg.modifiers || 0
        });
        break;
      }
      case 'scroll': {
        this.sendCdpToScope(ctx, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg.x || 0,
          y: msg.y || 0,
          deltaX: msg.deltaX || 0,
          deltaY: msg.deltaY || 0,
          modifiers: msg.modifiers || 0
        });
        break;
      }
      case 'key': {
        const hasText = typeof msg.text === 'string' && msg.text.length > 0;
        const action = msg.action === 'keyDown' && !hasText ? 'rawKeyDown' : msg.action;
        const params: Record<string, unknown> = {
          type: action,
          key: msg.key,
          code: msg.code,
          windowsVirtualKeyCode: msg.keyCode,
          nativeVirtualKeyCode: msg.keyCode,
          modifiers: msg.modifiers || 0
        };
        if (hasText && action === 'keyDown') {
          params.text = msg.text;
          params.unmodifiedText = msg.text;
        }
        const command = action !== 'keyUp' ? this.editingCommandFor(msg) : null;
        if (command) params.commands = [command];
        this.sendCdpToScope(ctx, 'Input.dispatchKeyEvent', params);
        break;
      }
      case 'insertText': {
        if (typeof msg.text === 'string' && msg.text) {
          this.sendCdpToScope(ctx, 'Input.insertText', { text: msg.text });
        }
        break;
      }
    }
  }

  /** Map Cmd/Ctrl editing shortcuts to Chromium editing command names. */
  private editingCommandFor(msg: any): string | null {
    const mods = Number(msg.modifiers) || 0;
    const primary = (mods & 4) !== 0 || (mods & 2) !== 0; // Meta or Ctrl
    if (!primary || typeof msg.key !== 'string') return null;
    const shift = (mods & 8) !== 0;
    switch (msg.key.toLowerCase()) {
      case 'a':
        return 'selectAll';
      case 'z':
        return shift ? 'redo' : 'undo';
      case 'y':
        return 'redo';
      case 'c':
        return 'copy';
      case 'x':
        return 'cut';
      default:
        return null;
    }
  }

  private broadcast(payload: unknown, scopeKey?: string): void {
    const raw = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (scopeKey) {
        const clientScope = this.clientScopes.get(client);
        if (clientScope && clientScope !== scopeKey) continue;
        if (!clientScope && scopeKey !== 'default') continue;
      }
      client.send(raw);
    }
  }

  public cleanup(): void {
    for (const ctx of this.scopedContexts.values()) {
      try {
        ctx.pageWs?.close();
      } catch {}
    }
    this.scopedContexts.clear();
    try {
      this.browserCdpWs?.close();
    } catch {}
    this.browserCdpWs = null;
    if (this.session.chromeProcess) {
      this.session.chromeProcess.kill();
      this.session.chromeProcess = null;
    }
  }

  private callCdpOnWs(
    ws: WebSocket | null | undefined,
    method: string,
    params: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP WebSocket not connected'));
    }
    const id = ++this.cdpMessageId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.off('message', onMsg);
        reject(new Error(`CDP ${method} timeout`));
      }, 6000);
      const onMsg = (raw: WebSocket.RawData) => {
        try {
          const parsed = JSON.parse(raw.toString()) as {
            id?: number;
            result?: Record<string, unknown>;
            error?: { message?: string };
          };
          if (parsed.id !== id) return;
          clearTimeout(timer);
          ws.off('message', onMsg);
          if (parsed.error) reject(new Error(parsed.error.message || 'CDP error'));
          else resolve(parsed.result || {});
        } catch {
          // Ignore non-JSON or event payloads
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private callCdpAsync(
    method: string,
    params: Record<string, unknown> = {},
    scopeKey?: string
  ): Promise<Record<string, unknown>> {
    const scopedWs = scopeKey ? this.scopedContexts.get(scopeKey)?.pageWs : undefined;
    return this.callCdpOnWs(scopedWs || this.session.cdpWs, method, params);
  }

  private sendCdpToScope(
    ctx: ScopedBrowserContext,
    method: string,
    params: Record<string, unknown> = {}
  ): void {
    if (!ctx.pageWs || ctx.pageWs.readyState !== WebSocket.OPEN) return;
    ctx.pageWs.send(JSON.stringify({ id: ++this.cdpMessageId, method, params }));
  }

  private applyViewportToScope(ctx: ScopedBrowserContext): void {
    const { viewportWidth: width, viewportHeight: height, deviceScaleFactor } = ctx;
    this.sendCdpToScope(ctx, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false
    });
    this.sendCdpToScope(ctx, 'Page.stopScreencast');
    this.sendCdpToScope(ctx, 'Page.startScreencast', {
      format: 'jpeg',
      quality: 80,
      maxWidth: Math.round(width * deviceScaleFactor),
      maxHeight: Math.round(height * deviceScaleFactor),
      everyNthFrame: 1
    });
  }

  private async ensureBrowserCdp(): Promise<WebSocket> {
    if (this.browserCdpWs && this.browserCdpWs.readyState === WebSocket.OPEN) {
      return this.browserCdpWs;
    }
    await this.ensureChromeRunning();
    const versionInfo = await this.cdpHttp('GET', '/json/version');
    const wsUrl = versionInfo?.webSocketDebuggerUrl;
    if (!wsUrl || typeof wsUrl !== 'string') {
      throw new Error('Browser CDP webSocketDebuggerUrl unavailable');
    }
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
    });
    ws.on('close', () => {
      if (this.browserCdpWs === ws) this.browserCdpWs = null;
    });
    this.browserCdpWs = ws;
    return ws;
  }

  private async restoreCookiesForScope(ctx: ScopedBrowserContext): Promise<void> {
    if (ctx.cookiesLoaded) return;
    ctx.cookiesLoaded = true;
    try {
      const cookiesPath = path.join(ctx.profileDir, 'cookies.json');
      if (!fs.existsSync(cookiesPath)) return;
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      if (Array.isArray(cookies) && cookies.length > 0) {
        await this.callCdpOnWs(ctx.pageWs, 'Network.setCookies', { cookies });
      }
    } catch {
      // Ignore corrupt cookies file
    }
  }

  private async saveCookiesForScope(ctx: ScopedBrowserContext): Promise<void> {
    try {
      const res = await this.callCdpOnWs(ctx.pageWs, 'Network.getAllCookies', {});
      const cookies = Array.isArray(res.cookies) ? res.cookies : [];
      fs.mkdirSync(ctx.profileDir, { recursive: true });
      fs.writeFileSync(path.join(ctx.profileDir, 'cookies.json'), JSON.stringify(cookies, null, 2), {
        mode: 0o600
      });
    } catch {
      // Best-effort cookie persistence
    }
  }

  private async ensureScopedContext(
    scopeKey: string,
    profileDir?: string
  ): Promise<ScopedBrowserContext> {
    const existing = this.scopedContexts.get(scopeKey);
    if (existing && existing.pageWs && existing.pageWs.readyState === WebSocket.OPEN) {
      return existing;
    }

    const pending = this.scopedContextPromises.get(scopeKey);
    if (pending) return pending;

    const createPromise = (async () => {
      try {
        const resolvedProfile = profileDir || this.profileDir;
        fs.mkdirSync(resolvedProfile, { recursive: true });

        const browserWs = await this.ensureBrowserCdp();
        const createdCtx = await this.callCdpOnWs(browserWs, 'Target.createBrowserContext', {
          disposeOnDetach: false
        });
        const browserContextId = String(createdCtx.browserContextId || '');
        const createdTarget = await this.callCdpOnWs(browserWs, 'Target.createTarget', {
          url: 'about:blank',
          browserContextId: browserContextId || undefined
        });
        const targetId = String(createdTarget.targetId || '');
        const pageWsUrl = `ws://127.0.0.1:${CDP_PORT}/devtools/page/${targetId}`;
        const pageWs = new WebSocket(pageWsUrl, { perMessageDeflate: false });

        await new Promise<void>((resolve, reject) => {
          pageWs.once('open', () => resolve());
          pageWs.once('error', (err) => reject(err));
        });

        const ctx: ScopedBrowserContext = {
          scopeKey,
          profileDir: resolvedProfile,
          browserContextId,
          targetId,
          pageWs,
          currentUrl: 'about:blank',
          activeTabId: null,
          viewportWidth: this.session.viewportWidth,
          viewportHeight: this.session.viewportHeight,
          deviceScaleFactor: this.session.deviceScaleFactor,
          cookiesLoaded: false
        };

        pageWs.on('message', (raw) => {
          let msg: any;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          switch (msg.method) {
            case 'Page.screencastFrame': {
              this.sendCdpToScope(ctx, 'Page.screencastFrameAck', { sessionId: msg.params.sessionId });
              this.broadcast(
                {
                  type: 'frame',
                  data: msg.params.data,
                  metadata: msg.params.metadata
                },
                scopeKey
              );
              break;
            }
            case 'Page.frameNavigated': {
              const frame = msg.params?.frame;
              if (frame && !frame.parentId && frame.url) {
                ctx.currentUrl = frame.url;
                this.updateScopeStatus(scopeKey, {
                  isRunning: true,
                  currentUrl: frame.url,
                  profileDir: ctx.profileDir
                });
                this.broadcast({ type: 'navigated', url: frame.url, tabId: ctx.activeTabId }, scopeKey);
              }
              break;
            }
            case 'Page.frameStartedLoading': {
              if (!msg.params?.frameId || msg.params.frameId === ctx.targetId) {
                this.broadcast({ type: 'loading' }, scopeKey);
              }
              break;
            }
            case 'Page.loadEventFired': {
              this.broadcast({ type: 'loaded', tabId: ctx.activeTabId }, scopeKey);
              void this.saveCookiesForScope(ctx);
              break;
            }
          }
        });

        pageWs.on('close', () => {
          if (ctx.pageWs === pageWs) ctx.pageWs = null;
        });

        this.sendCdpToScope(ctx, 'Page.enable');
        this.sendCdpToScope(ctx, 'Network.enable');
        this.sendCdpToScope(ctx, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        this.sendCdpToScope(ctx, 'Page.addScriptToEvaluateOnNewDocument', {
          source: getStealthInitScript()
        });
        await this.restoreCookiesForScope(ctx);
        this.applyViewportToScope(ctx);

        this.scopedContexts.set(scopeKey, ctx);
        return ctx;
      } finally {
        this.scopedContextPromises.delete(scopeKey);
      }
    })();

    this.scopedContextPromises.set(scopeKey, createPromise);
    return createPromise;
  }

  public updateScopeStatus(
    scopeKey: string,
    state: { isRunning: boolean; currentUrl: string; profileDir?: string }
  ): void {
    const existing = this.scopeStates.get(scopeKey);
    this.scopeStates.set(scopeKey, {
      isRunning: state.isRunning,
      currentUrl: state.currentUrl,
      profileDir: state.profileDir ?? existing?.profileDir
    });
    this.activeScopeKey = scopeKey;
  }

  public getStatus(scopeKey?: string): { isRunning: boolean; currentUrl: string; profileDir: string } {
    if (scopeKey) {
      const scoped = this.scopeStates.get(scopeKey);
      if (!scoped) {
        return {
          isRunning: false,
          currentUrl: 'about:blank',
          profileDir: this.profileDir
        };
      }
      return {
        isRunning: scoped.isRunning,
        currentUrl: scoped.currentUrl,
        profileDir: scoped.profileDir || this.profileDir
      };
    }
    return {
      isRunning: this.isCdpReady(),
      currentUrl: this.session.currentUrl,
      profileDir: this.profileDir
    };
  }

  public async getCookies(urls?: string[]): Promise<Array<{ name: string; value: string; domain?: string }>> {
    try {
      await this.ensureChromeRunning();
      if (!this.isCdpReady()) return [];
      const res = await this.callCdpAsync('Network.getCookies', urls && urls.length > 0 ? { urls } : {});
      const cookies = Array.isArray(res.cookies) ? res.cookies : [];
      return cookies
        .filter((c: any) => c && typeof c.name === 'string' && typeof c.value === 'string')
        .map((c: any) => ({ name: c.name, value: c.value, domain: typeof c.domain === 'string' ? c.domain : undefined }));
    } catch {
      return [];
    }
  }

  public async snapshot(profileDir?: string, scopeKey?: string): Promise<BrowserPageSnapshot | null> {
    try {
      const effectiveScope = scopeKey || this.activeScopeKey || 'default';
      const ctx = await this.ensureScopedContext(effectiveScope, profileDir);

      const evalRes = await this.callCdpAsync(
        'Runtime.evaluate',
        {
          expression: DOM_INTERACTIVE_SNAPSHOT_EXPRESSION,
          returnByValue: true
        },
        effectiveScope
      );
      const rawValue = (evalRes?.result as { value?: string } | undefined)?.value;
      const parsedData = rawValue
        ? (JSON.parse(rawValue) as {
            url?: string;
            title?: string;
            ogTitle?: string;
            ogDescription?: string;
            ogImage?: string;
            mediaUrls?: string[];
            text?: string;
            interactiveElements?: BrowserInteractiveElement[];
          })
        : {};

      const currentUrl = parsedData.url || ctx.currentUrl;
      ctx.currentUrl = currentUrl;
      this.updateScopeStatus(effectiveScope, {
        isRunning: true,
        currentUrl,
        profileDir: ctx.profileDir
      });

      let screenshotDataUrl: string | undefined;
      try {
        const shot = await this.callCdpAsync(
          'Page.captureScreenshot',
          { format: 'jpeg', quality: 75 },
          effectiveScope
        );
        if (typeof shot.data === 'string' && shot.data.length > 0) {
          screenshotDataUrl = `data:image/jpeg;base64,${shot.data}`;
        }
      } catch {
        // Screenshot is best-effort
      }

      return {
        url: currentUrl,
        title: parsedData.ogTitle || parsedData.title || currentUrl,
        text: parsedData.text || '',
        ogTitle: parsedData.ogTitle || undefined,
        ogDescription: parsedData.ogDescription || undefined,
        ogImage: parsedData.ogImage || undefined,
        mediaUrls: Array.isArray(parsedData.mediaUrls) ? parsedData.mediaUrls : undefined,
        interactiveElements: Array.isArray(parsedData.interactiveElements) ? parsedData.interactiveElements : [],
        screenshotDataUrl
      };
    } catch {
      return null;
    }
  }

  /**
   * Navigates the live streamed browser session (visible in the UI remote viewport)
   * to `targetUrl`, waits for JS hydration, and captures DOM + OpenGraph + screenshot.
   */
  public async navigateAndCapture(
    targetUrl: string,
    profileDir?: string,
    scopeKey?: string
  ): Promise<BrowserPageSnapshot | null> {
    try {
      const effectiveScope = scopeKey || this.activeScopeKey || 'default';
      const ctx = await this.ensureScopedContext(effectiveScope, profileDir);

      ctx.currentUrl = targetUrl;
      this.updateScopeStatus(effectiveScope, {
        isRunning: true,
        currentUrl: targetUrl,
        profileDir: ctx.profileDir
      });
      this.broadcast({ type: 'navigated', url: targetUrl, tabId: ctx.activeTabId }, effectiveScope);
      await this.callCdpAsync('Page.navigate', { url: targetUrl }, effectiveScope);
      await new Promise((r) => setTimeout(r, 2800));
      this.broadcast({ type: 'loaded', tabId: ctx.activeTabId }, effectiveScope);
      await this.saveCookiesForScope(ctx);

      return await this.snapshot(profileDir, effectiveScope);
    } catch {
      return null;
    }
  }

  public async clickElement(options: {
    selector?: string;
    text?: string;
    x?: number;
    y?: number;
  }): Promise<{ ok: boolean; message: string; snapshot: BrowserPageSnapshot | null }> {
    try {
      await this.ensureChromeRunning();
      if (!this.isCdpReady()) {
        return { ok: false, message: 'Browser session is not ready.', snapshot: null };
      }

      let targetX = typeof options.x === 'number' ? options.x : undefined;
      let targetY = typeof options.y === 'number' ? options.y : undefined;

      if (targetX === undefined || targetY === undefined) {
        const selectorArg = JSON.stringify(options.selector || '');
        const textArg = JSON.stringify(options.text || '');
        const findRes = await this.callCdpAsync('Runtime.evaluate', {
          expression: `(() => {
            const sel = ${selectorArg};
            const txt = ${textArg}.trim().toLowerCase();
            let el = null;
            if (sel) {
              try { el = document.querySelector(sel); } catch {}
            }
            if (!el && txt) {
              const candidates = Array.from(document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"], [tabindex], img, video'));
              el = candidates.find((c) => ((c.innerText || c.getAttribute('aria-label') || c.getAttribute('alt') || c.value || '').trim().toLowerCase().includes(txt)));
            }
            if (!el) return JSON.stringify({ found: false });
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            return JSON.stringify({ found: true, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
          })()`,
          returnByValue: true
        });
        const raw = (findRes?.result as { value?: string } | undefined)?.value;
        const parsed = raw ? (JSON.parse(raw) as { found?: boolean; x?: number; y?: number }) : {};
        if (!parsed.found || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
          return {
            ok: false,
            message: `Element not found (${options.selector || options.text || 'unknown'}).`,
            snapshot: await this.snapshot()
          };
        }
        targetX = parsed.x;
        targetY = parsed.y;
      }

      await this.callCdpAsync('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: targetX,
        y: targetY,
        button: 'none',
        buttons: 0
      });
      await this.callCdpAsync('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: targetX,
        y: targetY,
        button: 'left',
        buttons: 1,
        clickCount: 1
      });
      await this.callCdpAsync('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: targetX,
        y: targetY,
        button: 'left',
        buttons: 0,
        clickCount: 1
      });

      await new Promise((r) => setTimeout(r, 1100));
      const snap = await this.snapshot();
      return { ok: true, message: `Clicked at (${targetX}, ${targetY}).`, snapshot: snap };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Click failed.',
        snapshot: await this.snapshot()
      };
    }
  }

  public async typeText(options: {
    selector?: string;
    text: string;
    submit?: boolean;
  }): Promise<{ ok: boolean; message: string; snapshot: BrowserPageSnapshot | null }> {
    try {
      await this.ensureChromeRunning();
      if (!this.isCdpReady()) {
        return { ok: false, message: 'Browser session is not ready.', snapshot: null };
      }

      if (options.selector) {
        const clickRes = await this.clickElement({ selector: options.selector });
        if (!clickRes.ok) {
          return { ok: false, message: clickRes.message, snapshot: clickRes.snapshot };
        }
      }

      if (options.text) {
        await this.callCdpAsync('Input.insertText', { text: options.text });
      }

      if (options.submit) {
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
      }

      await new Promise((r) => setTimeout(r, 900));
      const snap = await this.snapshot();
      return { ok: true, message: `Typed text${options.submit ? ' and pressed Enter' : ''}.`, snapshot: snap };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Type failed.',
        snapshot: await this.snapshot()
      };
    }
  }

  public async scrollPage(options: {
    direction: 'up' | 'down';
    amount?: number;
  }): Promise<{ ok: boolean; message: string; snapshot: BrowserPageSnapshot | null }> {
    try {
      await this.ensureChromeRunning();
      if (!this.isCdpReady()) {
        return { ok: false, message: 'Browser session is not ready.', snapshot: null };
      }

      const delta = Math.max(100, Math.min(2400, options.amount ?? 600));
      const deltaY = options.direction === 'up' ? -delta : delta;
      await this.callCdpAsync('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: Math.round(this.session.viewportWidth / 2),
        y: Math.round(this.session.viewportHeight / 2),
        deltaX: 0,
        deltaY
      });
      await new Promise((r) => setTimeout(r, 600));
      const snap = await this.snapshot();
      return { ok: true, message: `Scrolled ${options.direction} by ${delta}px.`, snapshot: snap };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'Scroll failed.',
        snapshot: await this.snapshot()
      };
    }
  }

  /**
   * Generic login form filler supporting:
   * - Standard 1-step forms (visible username + password)
   * - Password-only modals/steps (username prefilled or remembered)
   * - 2-step login flows (username-only step 1 -> Next -> password step 2)
   */
  public async fillVisibleLoginForm(options: {
    username: string;
    password: string;
  }): Promise<{
    ok: boolean;
    filledUsername: boolean;
    filledPassword: boolean;
    message: string;
    snapshot: BrowserPageSnapshot | null;
  }> {
    try {
      await this.ensureChromeRunning();
      if (!this.isCdpReady()) {
        return {
          ok: false,
          filledUsername: false,
          filledPassword: false,
          message: 'Browser session is not ready.',
          snapshot: null
        };
      }

      const inspectRes = await this.callCdpAsync('Runtime.evaluate', {
        expression: `(() => {
          const isVisible = (el) => {
            if (!el || el.disabled || el.readOnly) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
            const r = el.getBoundingClientRect();
            return r.width > 4 && r.height > 4;
          };
          const centerOf = (el) => {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          };
          const inputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
          const passEl =
            inputs.find((el) => (el.type || '').toLowerCase() === 'password') ||
            inputs.find((el) => (el.getAttribute('autocomplete') || '').toLowerCase().includes('password')) ||
            null;
          const userCandidates = inputs.filter((el) => {
            if (el === passEl) return false;
            const t = (el.type || 'text').toLowerCase();
            if (!['text', 'email', 'tel', ''].includes(t)) return false;
            const meta = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete')]
              .filter(Boolean)
              .join(' ')
              .toLowerCase();
            if (meta.includes('search') || el.getAttribute('role') === 'searchbox') return false;
            return true;
          });
          userCandidates.sort((a, b) => {
            const score = (el) => {
              const m = [el.type, el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete')]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();
              let s = 0;
              if (m.includes('username') || m.includes('email')) s += 4;
              if (m.includes('user') || m.includes('login') || m.includes('phone') || m.includes('account')) s += 2;
              return s;
            };
            return score(b) - score(a);
          });
          const userEl = userCandidates[0] || null;
          const anchorEl = passEl || userEl;
          const formContainer =
            anchorEl?.closest('form') ||
            anchorEl?.closest('[role="dialog"]') ||
            anchorEl?.parentElement?.parentElement ||
            null;
          const findSubmitIn = (root) => {
            if (!root) return null;
            const btns = Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]')).filter(isVisible);
            return (
              btns.find((el) => (el.getAttribute('type') || '').toLowerCase() === 'submit') ||
              btns.find((el) => {
                const txt = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
                return /^(log ?in|sign ?in|masuk|next|continue|lanjut|submit)$/.test(txt);
              }) ||
              null
            );
          };
          const submitBtn = findSubmitIn(formContainer);
          return JSON.stringify({
            user: userEl ? centerOf(userEl) : null,
            pass: passEl ? centerOf(passEl) : null,
            submit: submitBtn ? centerOf(submitBtn) : null
          });
        })()`,
        returnByValue: true
      });

      const raw = (inspectRes?.result as { value?: string } | undefined)?.value;
      const targets = raw
        ? (JSON.parse(raw) as {
            user?: { x: number; y: number } | null;
            pass?: { x: number; y: number } | null;
            submit?: { x: number; y: number } | null;
          })
        : {};

      if (!targets.user && !targets.pass) {
        return {
          ok: false,
          filledUsername: false,
          filledPassword: false,
          message:
            'No visible username or password input found on the current page. If there is a "Log in" button, click it first.',
          snapshot: await this.snapshot()
        };
      }

      const clickAndReplace = async (coords: { x: number; y: number }, text: string) => {
        await this.callCdpAsync('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: coords.x,
          y: coords.y,
          button: 'left',
          buttons: 1,
          clickCount: 1
        });
        await this.callCdpAsync('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: coords.x,
          y: coords.y,
          button: 'left',
          buttons: 0,
          clickCount: 1
        });
        // Clear any existing/autofilled value before inserting
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'a',
          code: 'KeyA',
          modifiers: process.platform === 'darwin' ? 4 : 2,
          commands: ['selectAll']
        });
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'a',
          code: 'KeyA',
          modifiers: process.platform === 'darwin' ? 4 : 2
        });
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'rawKeyDown',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
          nativeVirtualKeyCode: 8
        });
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Backspace',
          code: 'Backspace',
          windowsVirtualKeyCode: 8,
          nativeVirtualKeyCode: 8
        });
        await this.callCdpAsync('Input.insertText', { text });
        // Ensure active element actually received input (fallback for strict controlled inputs)
        await this.callCdpAsync('Runtime.evaluate', {
          expression: `(() => {
            const el = document.activeElement;
            if (!el || !('value' in el)) return false;
            if (!el.value || el.value.length === 0) {
              const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
              if (proto && proto.set) {
                proto.set.call(el, ${JSON.stringify(text)});
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
            return el.value.length > 0;
          })()`,
          returnByValue: true
        });
      };

      let filledUsername = false;
      let filledPassword = false;

      if (targets.user && options.username) {
        await clickAndReplace(targets.user, options.username);
        filledUsername = true;
      }

      if (targets.pass && options.password) {
        await clickAndReplace(targets.pass, options.password);
        filledPassword = true;
      }

      // Submit via visible submit button when present, otherwise press Enter
      if (targets.submit) {
        await new Promise((r) => setTimeout(r, 150));
        await this.callCdpAsync('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: targets.submit.x,
          y: targets.submit.y,
          button: 'left',
          buttons: 1,
          clickCount: 1
        });
        await this.callCdpAsync('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: targets.submit.x,
          y: targets.submit.y,
          button: 'left',
          buttons: 0,
          clickCount: 1
        });
      } else {
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
        await this.callCdpAsync('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13
        });
      }

      await new Promise((r) => setTimeout(r, 2500));
      const snap = await this.snapshot();
      return {
        ok: filledUsername || filledPassword,
        filledUsername,
        filledPassword,
        message: `Filled${filledUsername ? ' username' : ''}${filledPassword ? ' password' : ''} and submitted.`,
        snapshot: snap
      };
    } catch (err) {
      return {
        ok: false,
        filledUsername: false,
        filledPassword: false,
        message: err instanceof Error ? err.message : 'Login form fill failed.',
        snapshot: await this.snapshot()
      };
    }
  }
}

export interface BrowserInteractiveElement {
  index: number;
  tag: string;
  text: string;
  href?: string;
  x: number;
  y: number;
}

const DOM_SNAPSHOT_EXPRESSION = `(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"], meta[name="' + p + '"]')?.getAttribute('content') || '';
  const imgs = Array.from(document.querySelectorAll('article img, main img'))
    .filter((img) => (img.naturalWidth || img.width || 0) >= 200 && img.src && img.src.startsWith('http'))
    .map((img) => img.src);
  const ogImage = meta('og:image') || meta('twitter:image') || '';
  const mediaUrls = Array.from(new Set([...imgs, ...(ogImage ? [ogImage] : [])])).slice(0, 4);
  return JSON.stringify({
    title: document.title || '',
    ogTitle: meta('og:title'),
    ogDescription: meta('og:description') || meta('description'),
    ogImage,
    mediaUrls,
    text: (document.body?.innerText || '').slice(0, 4000)
  });
})()`;

const DOM_INTERACTIVE_SNAPSHOT_EXPRESSION = `(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"], meta[name="' + p + '"]')?.getAttribute('content') || '';
  const imgs = Array.from(document.querySelectorAll('article img, main img, img'))
    .filter((img) => (img.naturalWidth || img.width || 0) >= 200 && img.src && img.src.startsWith('http'))
    .map((img) => img.src);
  const ogImage = meta('og:image') || meta('twitter:image') || '';
  const mediaUrls = Array.from(new Set([...imgs, ...(ogImage ? [ogImage] : [])])).slice(0, 6);
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const interactiveElements = Array.from(document.querySelectorAll('a, button, input, textarea, select, [role="button"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) return null;
      const label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      if (!label && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return null;
      return {
        tag: el.tagName.toLowerCase(),
        text: label || el.getAttribute('type') || el.tagName.toLowerCase(),
        href: el.getAttribute('href') || undefined,
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2)
      };
    })
    .filter(Boolean)
    .slice(0, 25)
    .map((item, idx) => ({ index: idx + 1, ...item }));
  return JSON.stringify({
    url: location.href,
    title: document.title || '',
    ogTitle: meta('og:title'),
    ogDescription: meta('og:description') || meta('description'),
    ogImage,
    mediaUrls,
    interactiveElements,
    text: (document.body?.innerText || '').slice(0, 4000)
  });
})()`;

export interface BrowserUrlSnapshot {
  url: string;
  title: string;
  text: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  mediaUrls?: string[];
  screenshotDataUrl?: string;
}

export interface BrowserPageSnapshot extends BrowserUrlSnapshot {
  interactiveElements?: BrowserInteractiveElement[];
}

/**
 * Opens a URL in an isolated headless Chrome CDP session using the agent/channel profile,
 * waits for JS rendering, extracts DOM text + OpenGraph metadata, and captures a viewport screenshot.
 */
export async function captureUrlSnapshotWithChrome(
  targetUrl: string,
  profileDir: string,
  timeoutMs = 12_000
): Promise<BrowserUrlSnapshot | null> {
  const chromePath = resolveChromeExecutablePath();
  if (!chromePath) return null;

  const port = 9300 + Math.floor(Math.random() * 500);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const args = getChromeLaunchArgs(profileDir, 1280, 900, process.platform, port);
  const chromeProc = spawn(chromePath, args, { stdio: 'ignore' });
  let cdpWs: WebSocket | null = null;

  try {
    const deadline = Date.now() + timeoutMs;
    let wsUrl: string | null = null;

    while (Date.now() < deadline && !wsUrl) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/list`);
        if (res.ok) {
          const targets = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
          const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || targets[0];
          if (page?.webSocketDebuggerUrl) {
            wsUrl = page.webSocketDebuggerUrl;
          }
        }
      } catch {
        // Chrome still starting
      }
    }

    if (!wsUrl) return null;

    const ws = new WebSocket(wsUrl);
    cdpWs = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 4000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    let msgId = 1;
    const callCdp = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = msgId++;
        const timer = setTimeout(() => {
          ws.off('message', onMsg);
          reject(new Error(`CDP ${method} timeout`));
        }, 6000);
        const onMsg = (raw: WebSocket.RawData) => {
          try {
            const parsed = JSON.parse(raw.toString()) as {
              id?: number;
              result?: Record<string, unknown>;
              error?: { message?: string };
            };
            if (parsed.id !== id) return;
            clearTimeout(timer);
            ws.off('message', onMsg);
            if (parsed.error) reject(new Error(parsed.error.message || 'CDP error'));
            else resolve(parsed.result || {});
          } catch {
            // Ignore non-JSON or event messages
          }
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await callCdp('Page.enable');
    await callCdp('Runtime.enable');
    await callCdp('Page.navigate', { url: targetUrl });

    // Allow client-side JS frameworks (e.g. Instagram/X) to hydrate
    await new Promise((r) => setTimeout(r, 2800));

    const evalRes = await callCdp('Runtime.evaluate', {
      expression: DOM_SNAPSHOT_EXPRESSION,
      returnByValue: true
    });

    const rawValue = (evalRes?.result as { value?: string } | undefined)?.value;
    const parsedData = rawValue
      ? (JSON.parse(rawValue) as {
          title?: string;
          ogTitle?: string;
          ogDescription?: string;
          ogImage?: string;
          mediaUrls?: string[];
          text?: string;
        })
      : {};

    let screenshotDataUrl: string | undefined;
    try {
      const shot = await callCdp('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
      if (typeof shot.data === 'string' && shot.data.length > 0) {
        screenshotDataUrl = `data:image/jpeg;base64,${shot.data}`;
      }
    } catch {
      // Screenshot is best-effort
    }

    return {
      url: targetUrl,
      title: parsedData.ogTitle || parsedData.title || targetUrl,
      text: parsedData.text || '',
      ogTitle: parsedData.ogTitle || undefined,
      ogDescription: parsedData.ogDescription || undefined,
      ogImage: parsedData.ogImage || undefined,
      mediaUrls: Array.isArray(parsedData.mediaUrls) ? parsedData.mediaUrls : undefined,
      screenshotDataUrl
    };
  } catch {
    return null;
  } finally {
    try {
      cdpWs?.close();
    } catch {}
    try {
      chromeProc.kill('SIGKILL');
    } catch {}
  }
}
