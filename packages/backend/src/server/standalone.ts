import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AddressInfo } from 'net';
import { AsyncLocalStorage } from 'async_hooks';
import {
  attachEnterpriseControlPlane,
  CloudAccountManager
} from './cloud-control-plane';
import {
  EnterpriseTenantPool,
  type WorkspaceRuntimeContext
} from './tenant-runtime-pool';
import { getDataLayoutPaths, migrateLegacyDataLayout } from '../core/data-root';
import { WorkspaceDatabase } from '../core/db';
import {
  VaultManager,
  OPENROUTER_DEFAULT_BASE_URL,
  OPENROUTER_DEFAULT_MODEL
} from '../core/vault/vault-manager';
import { AIGatewayClient } from '../core/agents/ai-gateway-client';
import { CodexClient } from '../core/agents/codex-client';
import { BackgroundTurnRunner } from './background-turn-runner';
import { enrichMessagesWithUrlContext } from './url-context-enrichment';
import { WorkspaceWsHub } from './workspace-ws-hub';
import { NodeSafeStorageAdapter } from './node-safe-storage';
import { redactSecrets } from '../service/providers/redaction';
import { LOCAL_USER_SENDER_UUID } from '@open-employee/contracts/uuid';
import { HeadlessChromeRemoteManager } from '../core/browser/headless-chrome-remote';
import { detectLocalNetworkHost, createPairingPayload, generatePairingPin, createSignedPairingToken, normalizePairingPin, isValidPairingPinShape } from '../utils/pairing-helper';
import { isPairingEndpoint, UNKNOWN_DEVICE_ERROR, registerPairingChallenge, consumePairingChallenge, type PairingChallengeStore } from '../utils/device-session-policy';
import {
  isApiTokenValid,
  isLanAccessEnabled,
  isLoopbackAddress,
  isProxyEnabled
} from '../utils/dev-api-policy';
import { globalVirtualScreenManager } from '../backend/virtual-screen-manager';
import { AgentMemoryStore, compactMessages } from '../backend/agent-memory-store';
import { globalLiveActivityManager } from '../backend/live-activity-manager';
import { FileManager } from '../core/file/file-manager';
import { usageRangeToSince } from '@open-employee/contracts/usage';
import type {
  AuthIdentity,
  BackendCapabilities,
  BackendEdition,
  BackendMetaResponse,
  ControlPlaneClaimResponse
} from '@open-employee/contracts/auth';
import { extractBearerToken } from '../service/api/auth';
import {
  parseAllowedOrigins,
  resolveCorsHeaders,
  SingleOwnerAuthManager,
  verifyExternalControlPlaneToken
} from './cross-origin-auth';

export function buildVisionChatMessages<
  T extends { role: string; content: unknown }
>(messages: T[], imageUrl?: string): T[] {
  if (!imageUrl || messages.length === 0) {
    return messages;
  }

  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  if (lastUserIndex < 0) {
    return messages;
  }

  const next = [...messages];
  const userMessage = next[lastUserIndex];
  const textContent = typeof userMessage.content === 'string' ? userMessage.content : '';

  next[lastUserIndex] = {
    ...userMessage,
    content: [
      { type: 'text', text: textContent },
      { type: 'image_url', image_url: { url: imageUrl } }
    ]
  } as unknown as T;

  return next;
}

export interface StandaloneServerOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  staticDir?: string;
  vaultKey?: string;
  apiToken?: string;
  enableHeadlessBrowser?: boolean;
  edition?: BackendEdition;
  capabilities?: Partial<BackendCapabilities>;
  handleExtensionRequest?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ) => Promise<boolean> | boolean;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp'
};

export class StandaloneServer {
  private server: http.Server | null = null;
  private database: WorkspaceDatabase | null = null;
  private vault: VaultManager | null = null;
  private turnRunner: BackgroundTurnRunner | null = null;
  private fileManager: FileManager | null = null;
  private memoryStore: AgentMemoryStore | null = null;
  private activePairingChallenges: PairingChallengeStore = new Map();
  private aiClient: AIGatewayClient;
  private codexClient = new CodexClient();
  private workspaceWsHub = new WorkspaceWsHub();
  private readonly port: number;
  private readonly host: string;
  private readonly dataDir: string;
  private readonly staticDir: string;
  private readonly apiToken: string | undefined;
  private readonly enableHeadlessBrowser: boolean;
  private readonly authManager: SingleOwnerAuthManager;
  private readonly edition: BackendEdition;
  private readonly extensionCapabilities: Partial<BackendCapabilities>;
  private readonly handleExtensionRequest?: StandaloneServerOptions['handleExtensionRequest'];
  private readonly controlPlaneConfigPath: string;
  private controlPlaneConfig: (ControlPlaneClaimResponse & { controlPlaneUrl?: string }) | null = null;
  private readonly tenantPool: EnterpriseTenantPool;
  private readonly tenantStorage = new AsyncLocalStorage<WorkspaceRuntimeContext | null>();
  private readonly tenantTurnRunners = new Map<string, BackgroundTurnRunner>();
  private cloudControlPlane: {
    manager: CloudAccountManager;
    handleRequest: (req: http.IncomingMessage, res: http.ServerResponse, pathname: string) => Promise<boolean>;
  } | null = null;

  constructor(options: StandaloneServerOptions = {}) {
    this.port = options.port !== undefined ? options.port : parseInt(process.env.PORT || '3050', 10);
    this.host = options.host || process.env.HOST || '0.0.0.0';
    this.dataDir = options.dataDir || process.env.OPEN_EMPLOYEE_DATA_DIR || path.resolve(process.cwd(), '.data');
    this.staticDir = options.staticDir || path.resolve(process.cwd(), 'dist');
    this.apiToken = options.apiToken || process.env.OPEN_EMPLOYEE_API_TOKEN;
    this.enableHeadlessBrowser =
      options.enableHeadlessBrowser ?? process.env.ENABLE_HEADLESS_BROWSER === '1';
    this.edition = options.edition || 'oss';
    this.extensionCapabilities = options.capabilities || {};
    this.handleExtensionRequest = options.handleExtensionRequest;
    this.controlPlaneConfigPath = path.join(this.dataDir, 'secrets', '.control-plane.json');
    this.controlPlaneConfig = this.loadControlPlaneConfig();
    this.authManager = new SingleOwnerAuthManager({
      secretPath: path.join(this.dataDir, 'secrets', '.auth.secret')
    });
    this.tenantPool = new EnterpriseTenantPool({ dataDir: this.dataDir });

    this.aiClient = new AIGatewayClient({
      allowLoopbackTestHost: true
    });
  }

  private initDatabaseAndVault(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    migrateLegacyDataLayout(this.dataDir);
    const layout = getDataLayoutPaths(this.dataDir);

    const vaultPath = layout.vaultPath;
    const safeStorage = new NodeSafeStorageAdapter({
      keyFilePath: layout.vaultKeyPath
    });

    this.vault = new VaultManager(vaultPath, { safeStorage });

    const dbPath = layout.dbPath;
    this.database = new WorkspaceDatabase(dbPath, {
      secretRedactor: (text) => (this.vault ? this.vault.redactSecrets(text) : redactSecrets(text))
    });

    this.memoryStore = new AgentMemoryStore(this.database);

    this.fileManager = new FileManager(this.dataDir, {
      secretRedactor: (text) => (this.vault ? this.vault.redactSecrets(text) : redactSecrets(text))
    });

    this.turnRunner = new BackgroundTurnRunner(
      () => this.database!,
      () => this.vault!,
      () => this.aiClient,
      this.dataDir,
      () => this.getFileManager(),
      (reason) => this.workspaceWsHub.broadcastUpdate(reason),
      (browserEvent) => this.workspaceWsHub.broadcastBrowserEvent(browserEvent)
    );
  }

  private getFileManager(): FileManager {
    const scoped = this.tenantStorage.getStore();
    if (scoped) return scoped.fileManager;
    if (!this.fileManager) {
      this.fileManager = new FileManager(this.dataDir, {
        secretRedactor: (text) => (this.vault ? this.vault.redactSecrets(text) : redactSecrets(text))
      });
    }
    return this.fileManager;
  }

  private getActiveDb(): WorkspaceDatabase {
    return this.tenantStorage.getStore()?.db || this.database!;
  }

  private getActiveVault(): VaultManager {
    return this.tenantStorage.getStore()?.vault || this.vault!;
  }

  private getActiveTurnRunner(): BackgroundTurnRunner | null {
    const scoped = this.tenantStorage.getStore();
    if (scoped) {
      let runner = this.tenantTurnRunners.get(scoped.workspaceId);
      if (!runner) {
        runner = new BackgroundTurnRunner(
          () => scoped.db,
          () => scoped.vault,
          () => this.aiClient,
          scoped.workspaceRoot,
          () => scoped.fileManager,
          (reason) => this.workspaceWsHub.broadcastUpdate(reason),
          (browserEvent) => this.workspaceWsHub.broadcastBrowserEvent(browserEvent)
        );
        this.tenantTurnRunners.set(scoped.workspaceId, runner);
      }
      return runner;
    }
    return this.turnRunner;
  }

  private getCloudControlPlane() {
    if (!this.cloudControlPlane) {
      const manager = new CloudAccountManager({ dataDir: this.dataDir });
      const ext = attachEnterpriseControlPlane(manager);
      this.cloudControlPlane = {
        manager,
        handleRequest: ext.handleExtensionRequest
      };
    }
    return this.cloudControlPlane;
  }

  private resolveTenantContext(req: http.IncomingMessage): WorkspaceRuntimeContext | null {
    const cookieHeader = req.headers.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)ea_auth=([^;]+)/);
    const cookieToken = match ? decodeURIComponent(match[1]) : null;
    const bearerToken = extractBearerToken(req.headers.authorization);
    const token = cookieToken || bearerToken;
    if (!token) return null;

    const { manager } = this.getCloudControlPlane();
    const activeUser = manager.verifyCloudToken(token);
    if (!activeUser) return null;

    const ownerId = manager.getWorkspaceOwnerId(activeUser.workspaceId);
    if (!ownerId) return null;
    return this.tenantPool.getWorkspaceRuntime(ownerId, activeUser.workspaceId);
  }

  private async resolveVisionImage(
    dataUrl: unknown,
    attachmentPath: unknown
  ): Promise<string | undefined> {
    if (typeof dataUrl === 'string' && dataUrl.trim()) {
      return dataUrl.trim();
    }

    if (typeof attachmentPath !== 'string' || !attachmentPath.trim()) {
      return undefined;
    }

    try {
      const cleanPath = attachmentPath.trim().replace(/^\.data\//, '');
      const read = await this.getFileManager().readAttachment(cleanPath);
      if (read?.data && read.data.startsWith('data:image/')) {
        return read.data;
      }
    } catch {
      // Attachment is unreadable; fall back to text-only context.
    }

    return undefined;
  }

  public async start(): Promise<AddressInfo> {
    this.initDatabaseAndVault();

    return new Promise((resolvePromise, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: String(err) }));
        });
      });

      this.workspaceWsHub.attachToServer(this.server);

      if (this.enableHeadlessBrowser) {
        try {
          HeadlessChromeRemoteManager.getInstance().initWebSocketServer(this.server);
        } catch (e) {
          console.warn('[server] Headless Chrome Remote streamer initialization skipped:', e);
        }
      }

      this.server.listen(this.port, this.host, () => {
        const addr = this.server?.address() as AddressInfo;
        console.log(`[server] Employee Agents production server running on http://${this.host}:${addr.port}`);
        resolvePromise(addr);
      });

      this.server.on('error', reject);
    });
  }

  public getAddress(): AddressInfo {
    if (!this.server) {
      throw new Error('Server is not running');
    }
    return this.server.address() as AddressInfo;
  }

  public async stop(): Promise<void> {
    this.workspaceWsHub.close();
    return new Promise((resolvePromise) => {
      if (this.database) {
        try {
          this.database.close();
        } catch {
          // Ignore close errors
        }
        this.database = null;
      }

      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolvePromise();
        });
      } else {
        resolvePromise();
      }
    });
  }

  private loadControlPlaneConfig(): (ControlPlaneClaimResponse & { controlPlaneUrl?: string }) | null {
    try {
      if (!fs.existsSync(this.controlPlaneConfigPath)) return null;
      return JSON.parse(fs.readFileSync(this.controlPlaneConfigPath, 'utf8'));
    } catch {
      return null;
    }
  }

  private saveControlPlaneConfig(config: ControlPlaneClaimResponse & { controlPlaneUrl?: string }): void {
    fs.mkdirSync(path.dirname(this.controlPlaneConfigPath), { recursive: true });
    fs.writeFileSync(this.controlPlaneConfigPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    this.controlPlaneConfig = config;
  }

  private detectSelfBackendUrl(req: http.IncomingMessage): string {
    const publicUrl = process.env.PUBLIC_URL?.trim();
    if (publicUrl) {
      return publicUrl.replace(/\/+$/, '');
    }
    const rawProto = req.headers['x-forwarded-proto'];
    const proto = (Array.isArray(rawProto) ? rawProto[0] : rawProto || 'http').split(',')[0].trim();
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
    const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost || `127.0.0.1:${this.port}`)
      .split(',')[0]
      .trim();
    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  private resolveBearerIdentity(req: http.IncomingMessage): AuthIdentity | null {
    const bearer = extractBearerToken(req.headers.authorization);
    if (!bearer) return null;

    const localIdentity = this.authManager.verifyAccessToken(bearer);
    if (localIdentity) return localIdentity;

    const cpPublicKey =
      this.controlPlaneConfig?.publicKeyPem || process.env.CONTROL_PLANE_PUBLIC_KEY?.trim();
    if (cpPublicKey) {
      return verifyExternalControlPlaneToken(bearer, {
        publicKeyPem: cpPublicKey,
        expectedIssuer:
          this.controlPlaneConfig?.issuer || process.env.CONTROL_PLANE_ISSUER?.trim() || undefined,
        expectedAudience:
          this.controlPlaneConfig?.audience || process.env.CONTROL_PLANE_AUDIENCE?.trim() || undefined
      });
    }

    return null;
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    if (this.resolveBearerIdentity(req)) {
      return true;
    }

    const remote = req.socket.remoteAddress;
    const isLoopback = isLoopbackAddress(remote);
    const lanEnabled = isLanAccessEnabled(process.env);

    // If loopback and LAN not required, allow
    if (isLoopback && !this.apiToken) {
      return true;
    }

    if (this.apiToken) {
      const tokenHeader = req.headers['x-api-token'];
      if (isApiTokenValid(tokenHeader, this.apiToken)) {
        return true;
      }
      // If deployed behind Cloudflare Tunnel with CF-Access or loopback, allow if token not set
      if (isLoopback && !process.env.OPEN_EMPLOYEE_REQUIRE_AUTH) {
        return true;
      }
      return false;
    }

    // Default: allow loopback or if LAN access enabled
    return isLoopback || lanEnabled || process.env.NODE_ENV === 'production';
  }

  private applyCorsHeaders(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawOrigins = process.env.CORS_ALLOWED_ORIGINS?.trim();
    if (rawOrigins) {
      const allowed = parseAllowedOrigins(rawOrigins);
      const headers = resolveCorsHeaders(req.headers.origin, allowed);
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
      }
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.applyCorsHeaders(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = req.url || '/';
    const parsedUrl = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Public metadata & auth bootstrap routes
    if (pathname === '/api/meta' && req.method === 'GET') {
      const meta: BackendMetaResponse = {
        edition: this.edition,
        apiVersion: '1.0',
        capabilities: {
          multiUser: Boolean(this.extensionCapabilities.multiUser),
          controlPlaneLinked: Boolean(
            this.controlPlaneConfig?.publicKeyPem || process.env.CONTROL_PLANE_PUBLIC_KEY?.trim()
          ),
          pairingEnabled: true,
          ownerConfigured: this.authManager.isOwnerConfigured(),
          ...this.extensionCapabilities
        }
      };
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(meta));
      return;
    }

    if (this.handleExtensionRequest) {
      const handled = await this.handleExtensionRequest(req, res, pathname);
      if (handled) return;
    }

    if (pathname.startsWith('/api/cloud/')) {
      const handled = await this.getCloudControlPlane().handleRequest(req, res, pathname);
      if (handled) return;
    }

    if (pathname === '/api/pairing/claim-control-plane' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody<{ linkCode?: string; controlPlaneUrl?: string }>(req);
        const linkCode = (body.linkCode || '').trim();
        const controlPlaneUrl = (
          body.controlPlaneUrl ||
          process.env.CONTROL_PLANE_URL ||
          ''
        )
          .trim()
          .replace(/\/+$/, '');

        if (!linkCode) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'linkCode is required.' }));
          return;
        }
        if (!controlPlaneUrl) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'controlPlaneUrl (or CONTROL_PLANE_URL env) is required.' }));
          return;
        }

        const backendUrl = this.detectSelfBackendUrl(req);
        const claimRes = await fetch(`${controlPlaneUrl}/api/control-plane/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ linkCode, backendUrl })
        });
        const claimData = (await claimRes.json().catch(() => ({}))) as Partial<ControlPlaneClaimResponse> & {
          error?: string;
        };
        if (!claimRes.ok || !claimData.publicKeyPem) {
          res.statusCode = claimRes.status || 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: claimData.error || 'Failed to claim link code.' }));
          return;
        }

        this.saveControlPlaneConfig({
          publicKeyPem: claimData.publicKeyPem,
          issuer: claimData.issuer || '',
          audience: claimData.audience || '',
          workspaceId: claimData.workspaceId || 'default',
          ownerUserId: claimData.ownerUserId || '',
          controlPlaneUrl
        });

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, backendUrl, controlPlaneUrl }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message || 'Control plane claim error.' }));
      }
      return;
    }

    if (pathname === '/api/auth/setup' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody<{ password?: string }>(req);
        const tokens = this.authManager.setupOwner(body.password || '');
        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(tokens));
      } catch (err: any) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message || 'Setup failed.' }));
      }
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody<{ password?: string }>(req);
        const tokens = this.authManager.loginWithPassword(body.password || '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(tokens));
      } catch (err: any) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message || 'Login failed.' }));
      }
      return;
    }

    if (pathname === '/api/auth/refresh' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody<{ refreshToken?: string }>(req);
        const tokens = this.authManager.refreshAccessToken(body.refreshToken || '');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(tokens));
      } catch (err: any) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err?.message || 'Refresh failed.' }));
      }
      return;
    }

    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      const body = await this.readJsonBody<{ refreshToken?: string }>(req).catch(() => ({} as { refreshToken?: string }));
      if (body.refreshToken) {
        this.authManager.logout(body.refreshToken);
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // API Routing
    if (pathname.startsWith('/api')) {
      const tenantCtx = this.resolveTenantContext(req);
      if (!tenantCtx && !this.isAuthorized(req)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Unauthorized: valid API token required.' }));
        return;
      }

      if (pathname === '/api/auth/ws-ticket' && req.method === 'POST') {
        const identity = this.resolveBearerIdentity(req) || {
          userId: 'owner-local',
          role: 'owner' as const,
          workspaceId: tenantCtx?.workspaceId || 'default',
          issuer: 'local-api-token'
        };
        const ticket = this.authManager.issueWsTicket(identity);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(ticket));
        return;
      }

      await this.tenantStorage.run(tenantCtx, () =>
        this.handleApiRequest(req, res, pathname, parsedUrl)
      );
      return;
    }

    // Static Asset Delivery & SPA Fallback
    this.serveStatic(req, res, pathname);
  }

  private async readJsonBody<T = any>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolvePromise, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        try {
          resolvePromise(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  private getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      return forwarded.split(',')[0].trim();
    }
    return req.socket?.remoteAddress || '127.0.0.1';
  }

  private async handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    parsedUrl: URL
  ): Promise<void> {
    const db = this.getActiveDb();
    const vault = this.getActiveVault();

    // Device revocation and heartbeat guard
    const deviceIdHeader = req.headers['x-device-id'];
    if (typeof deviceIdHeader === 'string' && deviceIdHeader.trim()) {
      const deviceId = deviceIdHeader.trim();
      const device = db.getPairedDevice(deviceId);
      if (!device && !isPairingEndpoint(pathname)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(UNKNOWN_DEVICE_ERROR));
        return;
      }
      if (device && device.isRevoked === 1) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            error: 'device_revoked',
            message: 'This device has been disconnected by the server administrator.'
          })
        );
        return;
      }
      if (device) {
        const clientIp = this.getClientIp(req);
        db.updateDeviceHeartbeat(deviceId, clientIp);
      }
    }

    // 0-session. /api/mobile/session (GET) - mobile client credential check.
    // Reaching this point means the guard above accepted the device id.
    if (pathname === '/api/mobile/session' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      if (typeof deviceIdHeader !== 'string' || !deviceIdHeader.trim()) {
        res.statusCode = 401;
        res.end(JSON.stringify(UNKNOWN_DEVICE_ERROR));
        return;
      }
      res.end(JSON.stringify({ status: 'active', deviceId: deviceIdHeader.trim() }));
      return;
    }

    // 0. /api/device/pairing-info (GET)
    if (pathname === '/api/device/pairing-info' && req.method === 'GET') {
      try {
        const publicEnvUrl =
          process.env.PUBLIC_URL ||
          process.env.SERVER_URL ||
          process.env.OPEN_EMPLOYEE_PUBLIC_URL;

        let serverUrl = '';
        if (publicEnvUrl && publicEnvUrl.trim()) {
          serverUrl = publicEnvUrl.trim().replace(/\/$/, '');
        } else {
          const reqHost = req.headers['x-forwarded-host'] || req.headers.host;
          const reqProto = req.headers['x-forwarded-proto'] || ((req.socket as any)?.encrypted ? 'https' : 'http');
          if (
            typeof reqHost === 'string' &&
            reqHost.trim() &&
            !reqHost.includes('127.0.0.1') &&
            !reqHost.includes('localhost')
          ) {
            serverUrl = `${reqProto}://${reqHost.trim()}`;
          } else {
            const hostIp = detectLocalNetworkHost(
              os.networkInterfaces() as Record<
                string,
                Array<{ address: string; family: string; internal: boolean }>
              >
            );
            let boundPort = this.port;
            try {
              boundPort = this.getAddress().port;
            } catch {
              boundPort = this.port;
            }
            serverUrl = `http://${hostIp}:${boundPort}`;
          }
        }

        const pinCode = generatePairingPin();
        const token = createSignedPairingToken(Date.now() + 600000);
        const payload = createPairingPayload(serverUrl, token, 'Employee Agents Workspace', 600, pinCode);
        registerPairingChallenge(this.activePairingChallenges, {
          token,
          pinCode,
          expiresAt: payload.expiresAt
        });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // 0a-2. /api/mobile/pair (POST - Inverted WhatsApp Pairing)
    if (pathname === '/api/mobile/pair' && req.method === 'POST') {
      try {
        const data = await this.readJsonBody(req);
        const challengeToken = typeof data.challengeToken === 'string' ? data.challengeToken.trim() : '';
        const pinCode = normalizePairingPin(typeof data.pinCode === 'string' ? data.pinCode : '');
        const deviceName = typeof data.deviceName === 'string' && data.deviceName.trim() ? data.deviceName.trim() : 'Mobile Companion';
        const platform = typeof data.platform === 'string' ? data.platform : 'android';
        const clientIp = this.getClientIp(req);

        const isValid = consumePairingChallenge(this.activePairingChallenges, {
          pinCode,
          challengeToken,
          clientIp
        });

        if (!isValid) {
          console.warn('[pairing] rejected pairing attempt', {
            clientIp,
            pinProvided: Boolean(pinCode),
            pinShape: pinCode ? (isValidPairingPinShape(pinCode) ? 'canonical' : 'nonstandard') : 'none',
            tokenProvided: Boolean(challengeToken),
            activeChallenges: this.activePairingChallenges.size
          });
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: 'invalid_or_expired_pairing_code',
              message: 'The pairing code or QR code has expired. Generate a new one from Settings > Linked Devices on the web.'
            })
          );
          return;
        }

        const deviceId =
          typeof data.deviceId === 'string' && data.deviceId.trim()
            ? data.deviceId.trim()
            : `dev_mobile_${Date.now()}`;
        const deviceToken = `oe_tok_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

        db.registerPairedDevice({
          id: deviceId,
          deviceName,
          platform,
          clientType: 'mobile_app',
          ipAddress: clientIp
        });

        if (typeof data.pushToken === 'string' && data.pushToken.trim()) {
          globalLiveActivityManager.registerPushToken(deviceId, data.pushToken.trim(), platform as any);
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: true,
            deviceId,
            deviceToken,
            serverName: 'Employee Agents Server',
            pairedAt: Date.now()
          })
        );
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // 0b. /api/device/register (POST)
    if (pathname === '/api/device/register' && req.method === 'POST') {
      try {
        const data = await this.readJsonBody(req);
        const deviceId = typeof data.deviceId === 'string' && data.deviceId.trim() ? data.deviceId.trim() : '';
        if (!deviceId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'deviceId is required' }));
          return;
        }
        const deviceName = typeof data.deviceName === 'string' && data.deviceName.trim() ? data.deviceName.trim() : 'Unknown Device';
        const platform = typeof data.platform === 'string' ? data.platform : 'mobile';
        const clientType = typeof data.clientType === 'string' ? data.clientType : 'mobile_app';
        const clientIp = this.getClientIp(req);

        db.registerPairedDevice({
          id: deviceId,
          deviceName,
          platform,
          clientType,
          ipAddress: clientIp
        });

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, deviceId }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // 0c. /api/device/list (GET)
    if (pathname === '/api/device/list' && req.method === 'GET') {
      try {
        const devices = db.getPairedDevices().map((d) => ({
          ...d,
          isOnline: d.isRevoked === 0 && Date.now() - d.lastActiveAt < 45000
        }));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ devices }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // 0d. /api/device/rename (POST)
    if (pathname === '/api/device/rename' && req.method === 'POST') {
      try {
        const data = await this.readJsonBody(req);
        const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!deviceId || !name) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'deviceId and name are required' }));
          return;
        }
        const updated = db.renamePairedDevice(deviceId, name);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: updated, deviceName: name }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // 0e. /api/device/revoke (POST)
    if (pathname === '/api/device/revoke' && req.method === 'POST') {
      try {
        const data = await this.readJsonBody(req);
        const deviceId = typeof data.deviceId === 'string' ? data.deviceId.trim() : '';
        if (!deviceId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'deviceId is required' }));
          return;
        }
        const revoked = db.revokePairedDevice(deviceId);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: revoked }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e) }));
      }
      return;
    }

    // 1. /api/workspace (GET)
    if (pathname === '/api/workspace' && req.method === 'GET') {
      const channels = db.getAllChannels();
      const agents = db.getAllAgents();
      const messagesByConversation: Record<string, unknown[]> = {};
      for (const c of channels) {
        messagesByConversation[c.id] = db.getMessages(c.id);
      }
      for (const a of agents) {
        messagesByConversation[a.id] = db.getMessages(a.id);
      }
      const activeState = db.getActiveConversation();
      const activeRunner = this.getActiveTurnRunner();
      const generatingConversations = activeRunner ? activeRunner.getGeneratingMap() : {};

      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          channels,
          agents,
          messagesByConversation,
          activeConversationId: activeState.activeConversationId,
          activeConversationType: activeState.activeConversationType,
          generatingConversations
        })
      );
      return;
    }

    // 1a. /api/agents (POST) - fast single-agent persistence
    if (pathname === '/api/agents' && req.method === 'POST') {
      try {
        const a = await this.readJsonBody(req);
        if (!a?.id || !a?.name) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Missing agent id or name.' }));
          return;
        }
        const existing = db.getAgentById(a.id);
        if (existing) {
          (db as any).db
            .prepare('UPDATE agents SET name = ?, model = ?, system_prompt = ? WHERE id = ?')
            .run(a.name, a.model || 'gpt-6.1-sol', a.systemPrompt || null, a.id);
        } else {
          db.createAgent({
            id: a.id,
            name: a.name,
            model: a.model || 'gpt-6.1-sol',
            systemPrompt: a.systemPrompt || ''
          });
        }
        this.workspaceWsHub.broadcastUpdate('agent:created');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, id: a.id }));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: String(err) }));
      }
      return;
    }

    // 1b. /api/workspace/active (POST)
    if (pathname === '/api/workspace/active' && req.method === 'POST') {
      try {
        const data = await this.readJsonBody(req);
        const convId =
          typeof data.activeConversationId === 'string'
            ? data.activeConversationId
            : typeof data.conversationId === 'string'
            ? data.conversationId
            : '';
        const convType = data.activeConversationType || data.conversationType || 'channel';
        db.setActiveConversation(convId, convType);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // 1c. /api/chat/send (POST - Decoupled Background Turn Runner)
    if (pathname === '/api/chat/send' && req.method === 'POST') {
      try {
        const intent = await this.readJsonBody(req);
        const activeRunner = this.getActiveTurnRunner();
        if (!activeRunner) {
          throw new Error('Background turn runner is not initialized');
        }
        const result = await activeRunner.executeTurn(intent);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: String(err) }));
      }
      return;
    }

    // 2. /api/workspace/sync (POST)
    if (pathname === '/api/workspace/sync' && req.method === 'POST') {
      try {
        const data = await this.readJsonBody(req);

        // Sync channels
        if (Array.isArray(data.channels)) {
          for (const c of data.channels) {
            const existing = (db as any).db
              .prepare('SELECT id FROM channels WHERE id = ?')
              .get(c.id);
            if (existing) {
              (db as any).db
                .prepare(
                  'UPDATE channels SET name = ?, description = ?, leader_agent_id = ?, agent_ids = ? WHERE id = ?'
                )
                .run(
                  c.name,
                  c.description || null,
                  c.leaderAgentId || null,
                  c.agentIds ? JSON.stringify(c.agentIds) : null,
                  c.id
                );
            } else {
              (db as any).db
                .prepare(
                  'INSERT INTO channels (id, name, description, is_default, leader_agent_id, agent_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
                )
                .run(
                  c.id,
                  c.name,
                  c.description || null,
                  c.isDefault ? 1 : 0,
                  c.leaderAgentId || null,
                  c.agentIds ? JSON.stringify(c.agentIds) : null,
                  c.createdAt || Date.now()
                );
            }
          }
        }

        // Sync agents
        if (Array.isArray(data.agents)) {
          for (const a of data.agents) {
            const existing = (db as any).db
              .prepare('SELECT id FROM agents WHERE id = ?')
              .get(a.id);
            if (existing) {
              (db as any).db
                .prepare(
                  'UPDATE agents SET name = ?, model = ?, system_prompt = ? WHERE id = ?'
                )
                .run(a.name, a.model, a.systemPrompt || null, a.id);
            } else {
              (db as any).db
                .prepare(
                  'INSERT INTO agents (id, name, model, system_prompt, created_at) VALUES (?, ?, ?, ?, ?)'
                )
                .run(a.id, a.name, a.model, a.systemPrompt || null, a.createdAt || Date.now());
            }
          }
        }

        // Sync messages with secret redaction
        const conversations = data.messagesByConversation || {};
        for (const [convId, msgs] of Object.entries(conversations)) {
          if (!Array.isArray(msgs)) continue;
          for (const rawMsg of msgs) {
            const m = rawMsg as any;
            const safeContent = vault.redactSecrets(String(m.content || ''));
            const safeSenderName = vault.redactSecrets(
              String(m.senderName || (m.senderType === 'agent' ? 'Agent' : 'You'))
            );

            const rawAttachmentPath =
              m.attachmentPath ||
              (Array.isArray(m.attachments) && m.attachments[0]?.relativePath) ||
              null;
            const safeAttachmentPath =
              rawAttachmentPath && typeof rawAttachmentPath === 'string'
                ? rawAttachmentPath.trim()
                : null;

            const rawReplyTo = m.replyTo ? JSON.stringify(m.replyTo) : null;

            const existing = (db as any).db
              .prepare('SELECT id FROM messages WHERE id = ?')
              .get(m.id);
            if (!existing) {
              (db as any).db
                .prepare(
                  'INSERT INTO messages (id, channel_id, sender_id, sender_name, sender_type, content, attachment_path, reply_to_json, is_starred, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )
                .run(
                  m.id,
                  m.channelId || convId,
                  m.senderId || (m.senderType === 'agent' ? convId : LOCAL_USER_SENDER_UUID),
                  safeSenderName,
                  m.senderType || 'user',
                  safeContent,
                  safeAttachmentPath,
                  rawReplyTo,
                  m.isStarred ? 1 : 0,
                  m.createdAt || Date.now()
                );
            } else {
              (db as any).db
                .prepare(
                  'UPDATE messages SET is_starred = ?, reply_to_json = COALESCE(?, reply_to_json), attachment_path = COALESCE(?, attachment_path) WHERE id = ?'
                )
                .run(m.isStarred ? 1 : 0, rawReplyTo, safeAttachmentPath, m.id);
            }
          }
        }

        // Save human-readable snapshot to memory.json
        const memoryPath = getDataLayoutPaths(this.dataDir).memoryPath;
        fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
        fs.writeFileSync(
          memoryPath,
          JSON.stringify(
            {
              updatedAt: Date.now(),
              channels: data.channels || [],
              agents: data.agents || [],
              conversations
            },
            null,
            2
          ),
          'utf-8'
        );

        if (data.activeConversationId) {
          db.setActiveConversation(
            data.activeConversationId,
            data.activeConversationType || 'channel'
          );
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: vault.redactSecrets(String(err)) }));
      }
      return;
    }

    // 2b. /api/attachments (upload, serve) - Image & file attachments
    if (pathname === '/api/attachments/upload' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody(req);
        const convId =
          typeof body?.conversationId === 'string' && body.conversationId.trim()
            ? body.conversationId.trim()
            : 'default';
        const name =
          typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : 'attachment';
        const mimeType =
          typeof body?.mimeType === 'string' && body.mimeType.trim()
            ? body.mimeType.trim()
            : 'application/octet-stream';

        let buffer: Buffer | null = null;
        if (typeof body?.dataUrl === 'string' && body.dataUrl.includes(',')) {
          buffer = Buffer.from(body.dataUrl.split(',')[1], 'base64');
        } else if (typeof body?.buffer === 'string' && body.buffer.trim()) {
          buffer = Buffer.from(body.buffer, 'base64');
        }

        if (!buffer || buffer.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Attachment payload is empty.' }));
          return;
        }

        const saved = await this.getFileManager().saveAttachment(convId, {
          name,
          buffer,
          mimeType
        });

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, attachment: saved }));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (
      req.method === 'GET' &&
      (pathname === '/api/attachments' ||
        pathname === '/api/attachments/file' ||
        pathname.startsWith('/api/attachments/'))
    ) {
      try {
        let relativePath = parsedUrl.searchParams.get('path');
        if (!relativePath) {
          const rest = pathname.replace(/^\/api\/attachments\/?/, '');
          if (rest && rest !== 'file') {
            relativePath = rest.startsWith('attachments/') ? rest : `attachments/${rest}`;
          }
        }

        if (!relativePath) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Missing attachment path.' }));
          return;
        }

        const { data, mimeType } = await this.getFileManager().readAttachment(relativePath);
        const payload = data.startsWith('data:')
          ? Buffer.from(data.split(',')[1] || '', 'base64')
          : Buffer.from(data, 'utf-8');

        res.statusCode = 200;
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', payload.length);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.end(payload);
      } catch {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Attachment not found.' }));
      }
      return;
    }

    // 3. /api/vault/gateways (GET & POST)
    if (pathname === '/api/vault/gateways') {
      if (req.method === 'GET') {
        const gateways = vault.listAIGateways();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(gateways));
        return;
      }

      if (req.method === 'POST') {
        try {
          const config = await this.readJsonBody(req);
          const saveResult = vault.saveAIGateway({
            id: config.id,
            name: config.name || config.model,
            provider: config.provider || 'openrouter',
            baseUrl: config.baseUrl || OPENROUTER_DEFAULT_BASE_URL,
            model: config.model,
            rawApiKey: config.rawApiKey,
            isDefault: config.isDefault ?? true
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(saveResult));
        } catch (err: unknown) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: vault.redactSecrets(String(err)) }));
        }
        return;
      }
    }

    // 3b. /api/vault/credentials (GET, POST, DELETE)
    if (pathname === '/api/vault/credentials' || pathname.startsWith('/api/vault/credentials/')) {
      if (req.method === 'GET' && pathname === '/api/vault/credentials') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(vault.listCredentials()));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/vault/credentials') {
        try {
          const data = await this.readJsonBody(req);
          if (!data?.name || !data?.rawValue) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: 'Vault label and secret are required.' }));
            return;
          }
          const result = vault.saveCredential({
            name: String(data.name),
            category: data.category || 'login',
            serviceDomain: typeof data.serviceDomain === 'string' ? data.serviceDomain : undefined,
            rawValue: String(data.rawValue),
            notes: typeof data.notes === 'string' ? data.notes : undefined
          });
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(result));
        } catch (err: unknown) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: vault.redactSecrets(String(err)) }));
        }
        return;
      }

      if (req.method === 'DELETE' && pathname.startsWith('/api/vault/credentials/')) {
        const id = decodeURIComponent(pathname.replace('/api/vault/credentials/', '')).trim();
        if (!id) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Credential ID is required.' }));
          return;
        }
        const result = vault.deleteCredential(id);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
        return;
      }
    }

    // 4. /api/vault/test (POST)
    if (pathname === '/api/vault/test' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody(req);
        const provider = body.provider || vault.getAIGateway().provider || 'openrouter';
        const baseUrl =
          body.baseUrl ||
          (provider === 'openai' ? 'https://api.openai.com/v1' : OPENROUTER_DEFAULT_BASE_URL);
        const model = body.model || OPENROUTER_DEFAULT_MODEL;
        if (provider === 'chatgpt') {
          const start = Date.now();
          const status = await this.codexClient.getAccountStatus();
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              success: status.connected,
              latencyMs: Date.now() - start,
              error: status.connected
                ? undefined
                : status.error || 'OpenAI is not connected. Sign in via link first.'
            })
          );
          return;
        }

        const rawApiKey =
          body.rawApiKey ||
          (body.id ? vault.getDecryptedGatewayKey(body.id) : null) ||
          vault.getDecryptedAIGatewayKey();

        if (!rawApiKey) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'No API key provided or configured.' }));
          return;
        }

        const probe = await this.aiClient.probeConnection(baseUrl, rawApiKey, model, provider);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: probe.success,
            latencyMs: probe.latencyMs,
            error: probe.error ? vault.redactSecrets(probe.error) : undefined
          })
        );
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: vault.redactSecrets(String(err)) }));
      }
      return;
    }

    // 5. /api/usage (GET) - Token usage aggregated per model
    if (pathname === '/api/usage' && req.method === 'GET') {
      try {
        const range = parsedUrl.searchParams.get('range') || '30d';
        const summary = db.getUsageSummary(usageRangeToSince(range));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ range, ...summary }));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // 4b. /api/codex/* (ChatGPT via Codex CLI device link auth)
    if (pathname === '/api/codex/status' && req.method === 'GET') {
      const status = await this.codexClient.getAccountStatus();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(status));
      return;
    }

    if (pathname === '/api/codex/login-start' && req.method === 'POST') {
      const challenge = await this.codexClient.startDeviceLogin();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(challenge));
      return;
    }

    if (pathname === '/api/codex/logout' && req.method === 'POST') {
      const logoutRes = await this.codexClient.logout();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(logoutRes));
      return;
    }

    if (pathname === '/api/codex/models' && req.method === 'GET') {
      try {
        const models = await this.codexClient.listModels();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, models }));
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: false,
            models: [],
            error: err instanceof Error ? err.message : String(err)
          })
        );
      }
      return;
    }

    // 5. /api/ai/chat (POST)
    if (pathname === '/api/ai/chat' && req.method === 'POST') {
      try {
        const params = await this.readJsonBody(req);
        const gateways = vault.listAIGateways();
        const activeGateway =
          gateways.find((g) => g.model === params.model) ||
          gateways.find((g) => g.isDefault) ||
          gateways[0];

        const defaultStatus = vault.getOpenRouterCredentialStatus();
        const baseUrl = activeGateway?.baseUrl || defaultStatus.baseUrl || OPENROUTER_DEFAULT_BASE_URL;
        const model = activeGateway?.model || params.model || defaultStatus.model || OPENROUTER_DEFAULT_MODEL;
        const provider = activeGateway?.provider || defaultStatus.provider || 'openrouter';

        const resolvedImage = await this.resolveVisionImage(params.dataUrl, params.attachmentPath);
        const rawMessages = Array.isArray(params.messages) ? params.messages : [];
        const urlEnriched = await enrichMessagesWithUrlContext({
          messages: rawMessages,
          imageUrl: resolvedImage,
          conversationId:
            typeof params.conversationId === 'string'
              ? params.conversationId
              : typeof params.channelId === 'string'
                ? params.channelId
                : undefined,
          conversationType: typeof params.channelId === 'string' ? 'channel' : 'agent'
        });

        let result;
        if (provider === 'chatgpt') {
          result = await this.codexClient.chatCompletion({
            model,
            systemPrompt: params.systemPrompt,
            messages: urlEnriched.messages
          });
        } else {
          const rawKey =
            (activeGateway && vault.getDecryptedGatewayKey(activeGateway.id)) ||
            vault.getDecryptedAIGatewayKey();

          if (!rawKey) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: false, error: 'NO_API_KEY' }));
            return;
          }

          result = await this.aiClient.chatCompletion({
            baseUrl,
            apiKey: rawKey,
            model,
            provider,
            systemPrompt: params.systemPrompt,
            messages: buildVisionChatMessages(urlEnriched.messages, urlEnriched.imageUrl)
          });
        }

        db.recordUsage({
          conversationId:
            typeof params.conversationId === 'string'
              ? params.conversationId
              : typeof params.channelId === 'string'
                ? params.channelId
                : null,
          agentId: typeof params.agentId === 'string' ? params.agentId : null,
          model,
          provider,
          gatewayId: activeGateway?.id,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
          costUsd: result.usage?.costUsd
        });

        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: result.success,
            content: result.content ? vault.redactSecrets(result.content) : undefined,
            error: result.error ? vault.redactSecrets(result.error) : undefined
          })
        );
      } catch (err: unknown) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: vault.redactSecrets(String(err)) }));
      }
      return;
    }

    // 6. /api/proxy (GET) - Web Proxy Middleware for Embedded Browser
    if (pathname.startsWith('/api/proxy') && req.method === 'GET') {
      if (!isProxyEnabled(process.env)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Proxy is disabled. Set OPEN_EMPLOYEE_ENABLE_PROXY=1.' }));
        return;
      }

      const targetUrl = parsedUrl.searchParams.get('url');
      if (!targetUrl) {
        res.statusCode = 400;
        res.end('Missing url parameter');
        return;
      }

      this.proxyExternalUrl(targetUrl, res);
      return;
    }

    // 7. /api/sandbox/status (GET) - Virtual Screen & VNC Sandbox Status
    if (pathname === '/api/sandbox/status' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(globalVirtualScreenManager.getStatus()));
      return;
    }

    // 8. /api/sandbox/restart (POST) - Restart Virtual Screen Sandbox
    if (pathname === '/api/sandbox/restart' && req.method === 'POST') {
      try {
        await globalVirtualScreenManager.restart();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, ...globalVirtualScreenManager.getStatus() }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    // 9. /api/sandbox/resolution (POST) - Switch Sandbox Display Resolution
    if (pathname === '/api/sandbox/resolution' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody(req);
        if (body?.resolution && typeof body.resolution === 'string') {
          globalVirtualScreenManager.setResolution(body.resolution);
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, ...globalVirtualScreenManager.getStatus() }));
      } catch (err: any) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    // 10. /api/memories (GET, POST, DELETE) - Persistent Agent & Channel Memory
    if (pathname === '/api/memories') {
      if (req.method === 'GET') {
        const ownerId = parsedUrl.searchParams.get('ownerId') || '';
        const ownerType = (parsedUrl.searchParams.get('ownerType') as any) || undefined;
        const query = parsedUrl.searchParams.get('q') || '';
        if (query) {
          const results = this.memoryStore?.searchMemories(ownerId, query) || [];
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ memories: results }));
          return;
        }
        const memories = this.memoryStore?.listMemories(ownerId, ownerType) || [];
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ memories }));
        return;
      }

      if (req.method === 'POST') {
        try {
          const body = await this.readJsonBody(req);
          if (!body?.ownerId || !body?.text) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'ownerId and text are required' }));
            return;
          }
          const saved = this.memoryStore?.saveMemory({
            ownerId: body.ownerId,
            ownerType: body.ownerType || 'agent',
            category: body.category || 'fact',
            text: body.text
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(saved));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
        return;
      }

      if (req.method === 'DELETE') {
        const id = parsedUrl.searchParams.get('id') || '';
        if (!id) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'id query param is required' }));
          return;
        }
        const success = this.memoryStore?.deleteMemory(id) ?? false;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success }));
        return;
      }
    }

    // 11. /api/conversations/compact (POST) - Context Auto-Compaction
    if (pathname === '/api/conversations/compact' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody(req);
        const conversationId = body?.conversationId;
        if (!conversationId) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'conversationId is required' }));
          return;
        }

        const messages = db.getMessages(conversationId) || [];
        const result = compactMessages(messages, {
          preserveRecentCount: body?.preserveRecentCount || 6
        });

        if (result.summary) {
          const lastCompactedMsg = messages[result.compactedCount - 1];
          db.saveConversationSummary(
            conversationId,
            result.summary,
            lastCompactedMsg?.id || 'unknown',
            result.compactedCount
          );
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    // 12. /api/mobile/push-token (POST) - APNs / FCM Push Token Registration
    if (pathname === '/api/mobile/push-token' && req.method === 'POST') {
      try {
        const body = await this.readJsonBody(req);
        if (!body?.deviceId || !body?.token) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'deviceId and token are required' }));
          return;
        }
        globalLiveActivityManager.registerPushToken(body.deviceId, body.token, body.platform || 'ios');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
      return;
    }

    // 13. /api/mobile/live-activity (GET, POST) - Apple Dynamic Island / ActivityKit Sync
    if (pathname === '/api/mobile/live-activity') {
      if (req.method === 'GET') {
        const activities = globalLiveActivityManager.listActivities();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ activities }));
        return;
      }

      if (req.method === 'POST') {
        try {
          const body = await this.readJsonBody(req);
          if (!body?.taskId || !body?.agentName) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'taskId and agentName are required' }));
            return;
          }
          const activity = globalLiveActivityManager.createActivity({
            taskId: body.taskId,
            taskTitle: body.taskTitle || 'Autonomous AI Task',
            agentId: body.agentId || 'agent-default',
            agentName: body.agentName,
            conversationId: body.conversationId || 'default'
          });
          res.statusCode = 201;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(activity));
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err?.message || err) }));
        }
        return;
      }
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: `Not found: ${pathname}` }));
  }

  private proxyExternalUrl(targetUrl: string, clientRes: http.ServerResponse): void {
    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;

      const req = client.get(
        targetUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          }
        },
        (upstreamRes) => {
          const headers = { ...upstreamRes.headers };
          delete headers['x-frame-options'];
          delete headers['content-security-policy'];
          delete headers['content-security-policy-report-only'];

          if (
            upstreamRes.statusCode &&
            upstreamRes.statusCode >= 300 &&
            upstreamRes.statusCode < 400 &&
            headers.location
          ) {
            let fullRedirect = headers.location;
            try {
              fullRedirect = new URL(headers.location, targetUrl).href;
            } catch {}
            headers.location = `/api/proxy?url=${encodeURIComponent(fullRedirect)}`;
            clientRes.writeHead(upstreamRes.statusCode, headers);
            clientRes.end();
            return;
          }

          clientRes.writeHead(upstreamRes.statusCode || 200, headers);
          upstreamRes.pipe(clientRes);
        }
      );

      req.on('error', (err) => {
        clientRes.statusCode = 502;
        clientRes.end(`Proxy error: ${err.message}`);
      });
    } catch (e: any) {
      clientRes.statusCode = 500;
      clientRes.end(`Proxy exception: ${e.message}`);
    }
  }

  private serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
    if (!fs.existsSync(this.staticDir)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!DOCTYPE html><html><body><h1>Employee Agents Backend Ready</h1><p>Frontend assets not found in <code>dist/</code>. Run <code>npm run build</code> first.</p></body></html>`);
      return;
    }

    let filePath = path.join(this.staticDir, pathname === '/' ? 'index.html' : pathname);

    // Prevent directory traversal
    if (!filePath.startsWith(this.staticDir)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback: return index.html for GET navigation
    const indexPath = path.join(this.staticDir, 'index.html');
    if (req.method === 'GET' && fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/') {
      const defaultCpUrl = (process.env.CONTROL_PLANE_URL || '').replace(/"/g, '&quot;');
      const isLinked = Boolean(this.controlPlaneConfig?.publicKeyPem);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Employee Agents Self-Hosted Backend</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0c1317; color: #e9edef; display: flex; min-height: 100vh; align-items: center; justify-content: center; padding: 16px; }
    .card { width: 100%; max-width: 440px; background: #111b21; border: 1px solid #2a3942; border-radius: 12px; padding: 24px; }
    h1 { margin: 0 0 8px; font-size: 18px; }
    p { margin: 0 0 16px; font-size: 13px; color: #8696a0; line-height: 1.5; }
    label { display: block; font-size: 12px; color: #aebac1; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a3942; background: #202c33; color: #e9edef; font-size: 14px; margin-bottom: 12px; }
    button { width: 100%; padding: 10px 14px; border: 0; border-radius: 8px; background: #00a884; color: #111b21; font-weight: 600; font-size: 14px; cursor: pointer; }
    .status { margin-top: 12px; font-size: 12px; color: #00a884; }
    .err { color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Employee Agents Backend</h1>
    <p>${isLinked ? 'Linked to Cloud Control Plane. Your remote workspace can connect automatically.' : 'Paste the Link Code from your Cloud registration page to connect this self-hosted backend.'}</p>
    <form id="link-form">
      <label for="linkCode">Link Code</label>
      <input id="linkCode" type="text" placeholder="EA-LINK-XXXX-XXXX" required />
      <label for="cpUrl">Cloud Control Plane URL</label>
      <input id="cpUrl" type="url" value="${defaultCpUrl}" placeholder="https://employee-agents2.ruangapp.com" required />
      <button type="submit">Link to Cloud</button>
      <div id="msg" class="status"></div>
    </form>
  </div>
  <script>
    document.getElementById('link-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('msg');
      msg.className = 'status';
      msg.textContent = 'Connecting...';
      try {
        const res = await fetch('/api/pairing/claim-control-plane', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            linkCode: document.getElementById('linkCode').value,
            controlPlaneUrl: document.getElementById('cpUrl').value
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to link');
        msg.textContent = 'Linked! Detected URL: ' + data.backendUrl + '. Return to your Cloud tab.';
      } catch (err) {
        msg.className = 'status err';
        msg.textContent = err.message || 'Error linking backend';
      }
    });
  </script>
</body>
</html>`);
      return;
    }

    res.statusCode = 404;
    res.end('Not found');
  }
}

// Direct Execution Entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new StandaloneServer();
  server.start().catch((err) => {
    console.error('[server] Fatal start error:', err);
    process.exit(1);
  });

  const shutdown = async () => {
    console.log('[server] Shutting down gracefully...');
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

