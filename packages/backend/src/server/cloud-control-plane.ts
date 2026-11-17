import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type http from 'http';
import Database from 'better-sqlite3';
import type {
  CloudAuthResponse,
  CloudUserProfile,
  ControlPlaneClaimResponse,
  DeploymentChoice,
  SelfHostLinkCodeResponse,
  SelfHostLinkStatusResponse,
  WorkspaceMemberInfo,
  WorkspaceRole,
  WorkspaceSummary
} from '../../../contracts/src/auth';
import { extractBearerToken } from '../service/api/auth';
import {
  resolveOwnerConfigDir,
  resolveOwnerSecretsDir,
  resolveWorkspaceRoot
} from './tenant-paths';
import { sendWorkspaceInviteEmail } from './mail-helper';

interface StoredCloudUser extends CloudUserProfile {
  passwordHash: string;
  createdAt: number;
}

interface CloudWorkspaceRecord {
  workspaceId: string;
  name: string;
  ownerUserId: string;
  mode: DeploymentChoice | null;
  backendUrl?: string;
  members: WorkspaceMemberInfo[];
  createdAt: number;
}

interface LinkCodeEntry {
  userId: string;
  expiresAt: number;
}

interface EnterpriseKeyBundle {
  privateKeyPem: string;
  publicKeyPem: string;
  masterKeyHex: string;
}

interface UserRow {
  user_id: string;
  email_encrypted: string;
  email_hash: string;
  password_hash: string;
  mode: DeploymentChoice | null;
  backend_url: string | null;
  active_workspace_id: string;
  created_at: number;
}

interface WorkspaceRow {
  workspace_id: string;
  owner_user_id: string;
  name: string;
  mode: DeploymentChoice | null;
  backend_url: string | null;
  created_at: number;
}

interface MemberRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  joined_at: number;
  email_encrypted: string;
}

export interface CloudAccountManagerOptions {
  dataDir: string;
  issuer?: string;
  audience?: string;
}

export class CloudAccountManager {
  private readonly dataDir: string;
  private readonly dbPath: string;
  private readonly keysFilePath: string;
  private readonly legacyKeysFilePath: string;
  private readonly legacyUsersFilePath: string;
  private readonly legacyWorkspacesFilePath: string;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly privateKeyPem: string;
  private readonly publicKeyPem: string;
  private readonly masterKey: Buffer;
  private readonly db: Database.Database;
  private linkCodes = new Map<string, LinkCodeEntry>();

  constructor(options: CloudAccountManagerOptions) {
    this.dataDir = options.dataDir;
    this.dbPath = path.join(this.dataDir, 'db', 'enterprise.db');
    this.keysFilePath = path.join(this.dataDir, 'secrets', '.enterprise-keys.json');
    this.legacyKeysFilePath = path.join(this.dataDir, 'enterprise-cp.keys.json');
    this.legacyUsersFilePath = path.join(this.dataDir, 'enterprise-users.json');
    this.legacyWorkspacesFilePath = path.join(this.dataDir, 'enterprise-workspaces.json');
    this.issuer = options.issuer || 'https://employee-agents.control-plane';
    this.audience = options.audience || 'open-employee-backend';

    const keys = this.loadOrCreateKeys();
    this.privateKeyPem = keys.privateKeyPem;
    this.publicKeyPem = keys.publicKeyPem;
    this.masterKey = Buffer.from(keys.masterKeyHex, 'hex');

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
    this.migrateLegacyJsonIfNeeded();
  }

  private loadOrCreateKeys(): EnterpriseKeyBundle {
    const envPrivate = process.env.ENTERPRISE_JWT_PRIVATE_KEY?.trim();
    const envPublic = process.env.ENTERPRISE_JWT_PUBLIC_KEY?.trim();
    const envMaster = process.env.ENTERPRISE_MASTER_KEY?.trim();

    if (envPrivate && envPublic && envMaster && /^[0-9a-fA-F]{64}$/.test(envMaster)) {
      console.info(
        '[enterprise-cp] Key source: environment variables (ENTERPRISE_MASTER_KEY, ENTERPRISE_JWT_PRIVATE_KEY, ENTERPRISE_JWT_PUBLIC_KEY)'
      );
      return {
        privateKeyPem: envPrivate.replace(/\\n/g, '\n'),
        publicKeyPem: envPublic.replace(/\\n/g, '\n'),
        masterKeyHex: envMaster.toLowerCase()
      };
    }

    for (const candidatePath of [this.keysFilePath, this.legacyKeysFilePath]) {
      try {
        if (fs.existsSync(candidatePath)) {
          const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8')) as Partial<EnterpriseKeyBundle>;
          if (parsed.privateKeyPem && parsed.publicKeyPem) {
            const masterKeyHex =
              parsed.masterKeyHex && /^[0-9a-fA-F]{64}$/.test(parsed.masterKeyHex)
                ? parsed.masterKeyHex
                : crypto.randomBytes(32).toString('hex');
            const bundle: EnterpriseKeyBundle = {
              privateKeyPem: parsed.privateKeyPem,
              publicKeyPem: parsed.publicKeyPem,
              masterKeyHex
            };
            if (candidatePath !== this.keysFilePath || !parsed.masterKeyHex) {
              this.persistKeys(bundle);
            }
            console.info(
              `[enterprise-cp] Key source: local dev file (${this.keysFilePath}). Set ENTERPRISE_MASTER_KEY, ENTERPRISE_JWT_PRIVATE_KEY, ENTERPRISE_JWT_PUBLIC_KEY for production.`
            );
            return bundle;
          }
        }
      } catch {
        // Continue to key generation
      }
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const bundle: EnterpriseKeyBundle = {
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      masterKeyHex: crypto.randomBytes(32).toString('hex')
    };
    this.persistKeys(bundle);
    console.info(
      `[enterprise-cp] Key source: generated local dev file (${this.keysFilePath}). Set ENTERPRISE_MASTER_KEY, ENTERPRISE_JWT_PRIVATE_KEY, ENTERPRISE_JWT_PUBLIC_KEY for production.`
    );
    return bundle;
  }

  private persistKeys(bundle: EnterpriseKeyBundle): void {
    fs.mkdirSync(path.dirname(this.keysFilePath), { recursive: true });
    fs.writeFileSync(this.keysFilePath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email_encrypted TEXT NOT NULL,
        email_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        mode TEXT,
        backend_url TEXT,
        active_workspace_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mode TEXT,
        backend_url TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_invites (
        token TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        email_encrypted TEXT NOT NULL,
        email_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        invited_by_user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER
      );
    `);
  }

  private migrateLegacyJsonIfNeeded(): void {
    const existingCount = (
      this.db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }
    ).cnt;
    if (existingCount > 0) return;

    try {
      if (fs.existsSync(this.legacyUsersFilePath)) {
        const legacyUsers = JSON.parse(
          fs.readFileSync(this.legacyUsersFilePath, 'utf8')
        ) as StoredCloudUser[];
        if (Array.isArray(legacyUsers)) {
          const insertUser = this.db.prepare(`
            INSERT OR IGNORE INTO users
              (user_id, email_encrypted, email_hash, password_hash, mode, backend_url, active_workspace_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const u of legacyUsers) {
            const norm = (u.email || '').trim().toLowerCase();
            if (!norm || !u.userId) continue;
            insertUser.run(
              u.userId,
              this.encryptEmail(norm),
              this.hashEmail(norm),
              u.passwordHash,
              u.mode ?? null,
              u.backendUrl ?? null,
              u.workspaceId,
              u.createdAt || Date.now()
            );
          }
        }
      }

      if (fs.existsSync(this.legacyWorkspacesFilePath)) {
        const legacyWorkspaces = JSON.parse(
          fs.readFileSync(this.legacyWorkspacesFilePath, 'utf8')
        ) as CloudWorkspaceRecord[];
        if (Array.isArray(legacyWorkspaces)) {
          const insertWs = this.db.prepare(`
            INSERT OR IGNORE INTO workspaces
              (workspace_id, owner_user_id, name, mode, backend_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `);
          const insertMember = this.db.prepare(`
            INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
            VALUES (?, ?, ?, ?)
          `);
          for (const ws of legacyWorkspaces) {
            insertWs.run(
              ws.workspaceId,
              ws.ownerUserId,
              ws.name || 'My Workspace',
              ws.mode ?? null,
              ws.backendUrl ?? null,
              ws.createdAt || Date.now()
            );
            for (const m of ws.members || []) {
              insertMember.run(ws.workspaceId, m.userId, m.role || 'member', m.joinedAt || Date.now());
            }
          }
        }
      }
    } catch {
      // Ignore corrupted legacy JSON during migration
    }
  }

  private encryptEmail(normalizedEmail: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(normalizedEmail, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decryptEmail(payload: string): string {
    const [ivHex, tagHex, dataHex] = payload.split(':');
    if (!ivHex || !tagHex || !dataHex) return '';
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.masterKey,
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  private hashEmail(normalizedEmail: string): string {
    return crypto.createHmac('sha256', this.masterKey).update(normalizedEmail).digest('hex');
  }

  private hashPassword(password: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derived}`;
  }

  private verifyPassword(password: string, storedHash: string): boolean {
    const [salt, expectedHex] = storedHash.split(':');
    if (!salt || !expectedHex) return false;
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  }

  private getUserRowById(userId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as
      | UserRow
      | undefined;
  }

  private getUserRowByEmail(normalizedEmail: string): UserRow | undefined {
    const emailHash = this.hashEmail(normalizedEmail);
    return this.db.prepare('SELECT * FROM users WHERE email_hash = ?').get(emailHash) as
      | UserRow
      | undefined;
  }

  private getWorkspaceRow(workspaceId: string): WorkspaceRow | undefined {
    return this.db
      .prepare('SELECT * FROM workspaces WHERE workspace_id = ?')
      .get(workspaceId) as WorkspaceRow | undefined;
  }

  private getMemberRole(workspaceId: string, ownerUserId: string, userId: string): WorkspaceRole {
    const row = this.db
      .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId) as { role: WorkspaceRole } | undefined;
    if (row) return row.role;
    return ownerUserId === userId ? 'owner' : 'member';
  }

  private toPublicProfile(user: UserRow): CloudUserProfile {
    const ws = this.getWorkspaceRow(user.active_workspace_id);
    return {
      userId: user.user_id,
      email: this.decryptEmail(user.email_encrypted),
      mode: ws ? ws.mode : user.mode,
      backendUrl: ws?.backend_url ?? user.backend_url ?? undefined,
      workspaceId: user.active_workspace_id,
      workspaceName: ws?.name || 'My Workspace'
    };
  }

  private issueToken(user: UserRow): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const ws = this.getWorkspaceRow(user.active_workspace_id);
    const role: WorkspaceRole = ws
      ? this.getMemberRole(ws.workspace_id, ws.owner_user_id, user.user_id)
      : 'owner';
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: user.user_id,
        email: this.decryptEmail(user.email_encrypted),
        role,
        workspaceId: user.active_workspace_id,
        iss: this.issuer,
        aud: this.audience,
        iat: nowSec,
        exp: nowSec + 24 * 60 * 60
      })
    ).toString('base64url');
    const data = `${header}.${payload}`;
    const signature = crypto
      .sign(null, Buffer.from(data, 'utf8'), this.privateKeyPem)
      .toString('base64url');
    return `${data}.${signature}`;
  }

  public verifyCloudToken(token: string): CloudUserProfile | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
      const data = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
      const sig = Buffer.from(parts[2], 'base64url');
      if (!crypto.verify(null, data, this.publicKeyPem, sig)) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
        sub?: string;
        workspaceId?: string;
        exp?: number;
      };
      if (!payload.sub || !payload.exp || Date.now() / 1000 >= payload.exp) return null;
      const user = this.getUserRowById(payload.sub);
      if (!user) return null;
      if (payload.workspaceId) {
        const ws = this.getWorkspaceRow(payload.workspaceId);
        const stillMember =
          ws &&
          (ws.owner_user_id === user.user_id ||
            Boolean(
              this.db
                .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
                .get(payload.workspaceId, user.user_id)
            ));
        if (!stillMember) return null;
      }
      return this.toPublicProfile(user);
    } catch {
      return null;
    }
  }

  public register(email: string, password: string, workspaceName?: string): CloudAuthResponse {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Valid email is required.');
    }
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    if (this.getUserRowByEmail(normalizedEmail)) {
      throw new Error('Email is already registered.');
    }

    const cleanWorkspaceName = (workspaceName || '').trim() || 'My Workspace';
    const userId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const now = Date.now();
    const emailEncrypted = this.encryptEmail(normalizedEmail);
    const emailHash = this.hashEmail(normalizedEmail);
    const passwordHash = this.hashPassword(password);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO users
            (user_id, email_encrypted, email_hash, password_hash, mode, backend_url, active_workspace_id, created_at)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
        )
        .run(userId, emailEncrypted, emailHash, passwordHash, workspaceId, now);

      this.db
        .prepare(
          `INSERT INTO workspaces
            (workspace_id, owner_user_id, name, mode, backend_url, created_at)
           VALUES (?, ?, ?, NULL, NULL, ?)`
        )
        .run(workspaceId, userId, cleanWorkspaceName, now);

      this.db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
           VALUES (?, ?, 'owner', ?)`
        )
        .run(workspaceId, userId, now);
    });
    tx();

    const user = this.getUserRowById(userId)!;
    return {
      accessToken: this.issueToken(user),
      user: this.toPublicProfile(user)
    };
  }

  public login(email: string, password: string): CloudAuthResponse {
    const normalizedEmail = email.trim().toLowerCase();
    const user = this.getUserRowByEmail(normalizedEmail);
    if (!user || !this.verifyPassword(password, user.password_hash)) {
      throw new Error('Invalid email or password.');
    }
    return {
      accessToken: this.issueToken(user),
      user: this.toPublicProfile(user)
    };
  }

  public selectCloudMode(userId: string): CloudUserProfile {
    const user = this.getUserRowById(userId);
    if (!user) throw new Error('User not found.');
    const ws = this.getWorkspaceRow(user.active_workspace_id);
    const ownerId = ws?.owner_user_id || user.user_id;

    this.db
      .prepare('UPDATE users SET mode = ?, backend_url = NULL WHERE user_id = ?')
      .run('cloud', userId);
    if (ws) {
      this.db
        .prepare('UPDATE workspaces SET mode = ?, backend_url = NULL WHERE workspace_id = ?')
        .run('cloud', ws.workspace_id);
    }

    fs.mkdirSync(resolveOwnerSecretsDir(this.dataDir, ownerId), { recursive: true });
    fs.mkdirSync(resolveOwnerConfigDir(this.dataDir, ownerId), { recursive: true });
    fs.mkdirSync(resolveWorkspaceRoot(this.dataDir, ownerId, user.active_workspace_id), {
      recursive: true
    });

    return this.toPublicProfile(this.getUserRowById(userId)!);
  }

  public generateSelfHostLinkCode(userId: string): SelfHostLinkCodeResponse {
    const user = this.getUserRowById(userId);
    if (!user) throw new Error('User not found.');
    this.db.prepare('UPDATE users SET mode = ? WHERE user_id = ?').run('selfhost', userId);

    const now = Date.now();
    for (const [code, entry] of this.linkCodes.entries()) {
      if (now > entry.expiresAt) this.linkCodes.delete(code);
    }

    const partA = crypto.randomBytes(2).toString('hex').toUpperCase();
    const partB = crypto.randomBytes(2).toString('hex').toUpperCase();
    const linkCode = `EA-LINK-${partA}-${partB}`;
    const expiresAt = now + 15 * 60 * 1000;
    this.linkCodes.set(linkCode, { userId, expiresAt });
    return { linkCode, expiresAt };
  }

  public claimSelfHostLinkCode(linkCode: string, backendUrl: string): ControlPlaneClaimResponse {
    const normalizedCode = linkCode.trim().toUpperCase();
    const entry = this.linkCodes.get(normalizedCode);
    if (!entry) {
      throw new Error('Invalid or already used link code.');
    }
    this.linkCodes.delete(normalizedCode);
    if (Date.now() > entry.expiresAt) {
      throw new Error('Link code has expired.');
    }

    const cleanUrl = backendUrl.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleanUrl)) {
      throw new Error('Valid http(s) backendUrl is required.');
    }

    const user = this.getUserRowById(entry.userId);
    if (!user) {
      throw new Error('User not found.');
    }

    this.db
      .prepare('UPDATE users SET mode = ?, backend_url = ? WHERE user_id = ?')
      .run('selfhost', cleanUrl, user.user_id);
    this.db
      .prepare('UPDATE workspaces SET mode = ?, backend_url = ? WHERE workspace_id = ?')
      .run('selfhost', cleanUrl, user.active_workspace_id);

    return {
      publicKeyPem: this.publicKeyPem,
      issuer: this.issuer,
      audience: this.audience,
      workspaceId: user.active_workspace_id,
      ownerUserId: user.user_id
    };
  }

  public getWorkspaceOwnerId(workspaceId: string): string | null {
    const ws = this.getWorkspaceRow(workspaceId);
    return ws ? ws.owner_user_id : null;
  }

  public getUserWorkspaceRole(userId: string, workspaceId: string): WorkspaceRole | null {
    const ws = this.getWorkspaceRow(workspaceId);
    if (!ws) return null;
    if (ws.owner_user_id === userId) return 'owner';
    const row = this.db
      .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId) as { role: WorkspaceRole } | undefined;
    return row ? row.role : null;
  }

  public getLinkStatus(userId: string): SelfHostLinkStatusResponse {
    const user = this.getUserRowById(userId);
    if (!user) {
      return { linked: false };
    }
    return {
      linked: Boolean(user.mode === 'selfhost' && user.backend_url),
      backendUrl: user.backend_url ?? undefined
    };
  }

  public listWorkspaces(userId: string): WorkspaceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT w.workspace_id, w.name, w.mode, w.backend_url, w.created_at, m.role,
                (SELECT COUNT(*) FROM workspace_members wm WHERE wm.workspace_id = w.workspace_id) AS member_count
         FROM workspaces w
         INNER JOIN workspace_members m ON m.workspace_id = w.workspace_id
         WHERE m.user_id = ?
         ORDER BY w.created_at ASC`
      )
      .all(userId) as Array<{
      workspace_id: string;
      name: string;
      mode: DeploymentChoice | null;
      backend_url: string | null;
      created_at: number;
      role: WorkspaceRole;
      member_count: number;
    }>;

    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      name: r.name,
      role: r.role,
      mode: r.mode,
      backendUrl: r.backend_url ?? undefined,
      memberCount: r.member_count,
      createdAt: r.created_at
    }));
  }

  public createWorkspace(userId: string, name?: string): WorkspaceSummary {
    const user = this.getUserRowById(userId);
    if (!user) throw new Error('User not found.');
    const cleanName = (name || '').trim() || 'New Workspace';
    const workspaceId = crypto.randomUUID();
    const now = Date.now();

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workspaces
            (workspace_id, owner_user_id, name, mode, backend_url, created_at)
           VALUES (?, ?, ?, 'cloud', NULL, ?)`
        )
        .run(workspaceId, userId, cleanName, now);

      this.db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
           VALUES (?, ?, 'owner', ?)`
        )
        .run(workspaceId, userId, now);
    });
    tx();

    fs.mkdirSync(resolveOwnerSecretsDir(this.dataDir, userId), { recursive: true });
    fs.mkdirSync(resolveOwnerConfigDir(this.dataDir, userId), { recursive: true });
    fs.mkdirSync(resolveWorkspaceRoot(this.dataDir, userId, workspaceId), {
      recursive: true
    });

    return {
      workspaceId,
      name: cleanName,
      role: 'owner',
      mode: 'cloud',
      memberCount: 1,
      createdAt: now
    };
  }

  public switchWorkspace(userId: string, workspaceId: string): CloudAuthResponse {
    const user = this.getUserRowById(userId);
    if (!user) throw new Error('User not found.');
    const ws = this.getWorkspaceRow(workspaceId);
    if (!ws) throw new Error('Workspace not found.');

    const member = this.db
      .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, userId);
    if (!member && ws.owner_user_id !== userId) {
      throw new Error('You do not have access to this workspace.');
    }

    this.db
      .prepare('UPDATE users SET active_workspace_id = ?, mode = ?, backend_url = ? WHERE user_id = ?')
      .run(ws.workspace_id, ws.mode, ws.backend_url, userId);

    const updatedUser = this.getUserRowById(userId)!;
    return {
      accessToken: this.issueToken(updatedUser),
      user: this.toPublicProfile(updatedUser)
    };
  }

  public listWorkspaceMembers(actorUserId: string, workspaceId: string): WorkspaceMemberInfo[] {
    const ws = this.getWorkspaceRow(workspaceId);
    if (!ws) throw new Error('Workspace not found.');

    const isMember =
      ws.owner_user_id === actorUserId ||
      Boolean(
        this.db
          .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
          .get(workspaceId, actorUserId)
      );
    if (!isMember) {
      throw new Error('You do not have access to this workspace.');
    }

    const actorRole = this.getMemberRole(workspaceId, ws.owner_user_id, actorUserId);
    if (actorRole !== 'owner' && actorRole !== 'admin') {
      throw new Error('Only workspace owners or admins can view members.');
    }

    const rows = this.db
      .prepare(
        `SELECT wm.workspace_id, wm.user_id, wm.role, wm.joined_at, u.email_encrypted
         FROM workspace_members wm
         INNER JOIN users u ON u.user_id = wm.user_id
         WHERE wm.workspace_id = ?
         ORDER BY wm.joined_at ASC`
      )
      .all(workspaceId) as MemberRow[];

    return rows.map((r) => ({
      userId: r.user_id,
      email: this.decryptEmail(r.email_encrypted),
      role: r.role,
      joinedAt: r.joined_at
    }));
  }

  public inviteMember(
    actorUserId: string,
    workspaceId: string,
    email: string,
    role: WorkspaceRole = 'member'
  ): WorkspaceMemberInfo[] {
    const ws = this.getWorkspaceRow(workspaceId);
    if (!ws) throw new Error('Workspace not found.');

    const actorRole = this.getMemberRole(workspaceId, ws.owner_user_id, actorUserId);
    if (actorRole !== 'owner' && actorRole !== 'admin') {
      throw new Error('Only workspace owners or admins can invite members.');
    }
    if (role === 'admin' && actorRole !== 'owner') {
      throw new Error('Only workspace owners can assign the admin role.');
    }

    const normalizedEmail = email.trim().toLowerCase();
    const targetUser = this.getUserRowByEmail(normalizedEmail);
    if (!targetUser) {
      throw new Error('No registered user found with that email.');
    }

    const safeRole: WorkspaceRole = role === 'admin' ? 'admin' : 'member';
    const existing = this.db
      .prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, targetUser.user_id);

    if (existing) {
      this.db
        .prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
        .run(safeRole, workspaceId, targetUser.user_id);
    } else {
      this.db
        .prepare(
          'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
        )
        .run(workspaceId, targetUser.user_id, safeRole, Date.now());
    }

    return this.listWorkspaceMembers(actorUserId, workspaceId);
  }

  public createWorkspaceInvite(
    actorUserId: string,
    workspaceId: string,
    email: string,
    role: WorkspaceRole = 'member'
  ): {
    token: string;
    email: string;
    workspaceName: string;
    role: WorkspaceRole;
    alreadyMember: boolean;
    members?: WorkspaceMemberInfo[];
  } {
    const ws = this.getWorkspaceRow(workspaceId);
    if (!ws) throw new Error('Workspace not found.');

    const actorRole = this.getMemberRole(workspaceId, ws.owner_user_id, actorUserId);
    if (actorRole !== 'owner' && actorRole !== 'admin') {
      throw new Error('Only workspace owners or admins can invite members.');
    }
    if (role === 'admin' && actorRole !== 'owner') {
      throw new Error('Only workspace owners can assign the admin role.');
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      throw new Error('Valid email is required.');
    }

    const safeRole: WorkspaceRole = role === 'admin' ? 'admin' : 'member';
    const existingUser = this.getUserRowByEmail(normalizedEmail);
    if (existingUser) {
      const members = this.inviteMember(actorUserId, workspaceId, normalizedEmail, safeRole);
      return {
        token: '',
        email: normalizedEmail,
        workspaceName: ws.name,
        role: safeRole,
        alreadyMember: true,
        members
      };
    }

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    this.db
      .prepare(
        `INSERT INTO workspace_invites
          (token, workspace_id, email_encrypted, email_hash, role, invited_by_user_id, expires_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        token,
        workspaceId,
        this.encryptEmail(normalizedEmail),
        this.hashEmail(normalizedEmail),
        safeRole,
        actorUserId,
        expiresAt
      );

    return {
      token,
      email: normalizedEmail,
      workspaceName: ws.name,
      role: safeRole,
      alreadyMember: false
    };
  }

  public verifyWorkspaceInvite(token: string): {
    workspaceId: string;
    workspaceName: string;
    email: string;
    role: WorkspaceRole;
    accountExists: boolean;
  } {
    const row = this.db
      .prepare('SELECT * FROM workspace_invites WHERE token = ?')
      .get(token.trim()) as
      | {
          token: string;
          workspace_id: string;
          email_encrypted: string;
          role: WorkspaceRole;
          expires_at: number;
          accepted_at: number | null;
        }
      | undefined;

    if (!row || row.accepted_at) {
      throw new Error('Invalid or already used invitation link.');
    }
    if (Date.now() > row.expires_at) {
      throw new Error('Invitation link has expired.');
    }
    const ws = this.getWorkspaceRow(row.workspace_id);
    if (!ws) {
      throw new Error('Workspace no longer exists.');
    }

    const email = this.decryptEmail(row.email_encrypted);
    const existingUser = this.getUserRowByEmail(email);

    return {
      workspaceId: ws.workspace_id,
      workspaceName: ws.name,
      email,
      role: row.role,
      accountExists: Boolean(existingUser)
    };
  }

  public acceptWorkspaceInvite(token: string, password: string): CloudAuthResponse {
    const info = this.verifyWorkspaceInvite(token);
    if (!password || password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }

    const ws = this.getWorkspaceRow(info.workspaceId);
    if (!ws) throw new Error('Workspace not found.');

    let user = this.getUserRowByEmail(info.email);
    const now = Date.now();

    if (user) {
      if (!this.verifyPassword(password, user.password_hash)) {
        throw new Error('Invalid password for existing account.');
      }
      this.db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role`
        )
        .run(ws.workspace_id, user.user_id, info.role, now);
      this.db
        .prepare(
          'UPDATE users SET active_workspace_id = ?, mode = ?, backend_url = ? WHERE user_id = ?'
        )
        .run(ws.workspace_id, ws.mode, ws.backend_url, user.user_id);
    } else {
      const userId = crypto.randomUUID();
      const passwordHash = this.hashPassword(password);
      const tx = this.db.transaction(() => {
        this.db
          .prepare(
            `INSERT INTO users
              (user_id, email_encrypted, email_hash, password_hash, mode, backend_url, active_workspace_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            userId,
            this.encryptEmail(info.email),
            this.hashEmail(info.email),
            passwordHash,
            ws.mode,
            ws.backend_url,
            ws.workspace_id,
            now
          );

        this.db
          .prepare(
            'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)'
          )
          .run(ws.workspace_id, userId, info.role, now);
      });
      tx();
      user = this.getUserRowById(userId)!;
    }

    this.db
      .prepare('UPDATE workspace_invites SET accepted_at = ? WHERE token = ?')
      .run(now, token.trim());

    const updatedUser = this.getUserRowById(user.user_id)!;
    return {
      accessToken: this.issueToken(updatedUser),
      user: this.toPublicProfile(updatedUser)
    };
  }

  public removeWorkspaceMember(
    actorUserId: string,
    workspaceId: string,
    targetUserId: string
  ): WorkspaceMemberInfo[] {
    const ws = this.getWorkspaceRow(workspaceId);
    if (!ws) throw new Error('Workspace not found.');

    const actorRole = this.getMemberRole(workspaceId, ws.owner_user_id, actorUserId);
    if (actorRole !== 'owner' && actorRole !== 'admin') {
      throw new Error('Only workspace owners or admins can remove members.');
    }

    if (targetUserId === ws.owner_user_id) {
      throw new Error('Workspace owner cannot be removed.');
    }

    const targetRow = this.db
      .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, targetUserId) as { role: WorkspaceRole } | undefined;

    if (!targetRow) {
      throw new Error('Member not found in this workspace.');
    }

    if (targetRow.role === 'admin' && actorRole !== 'owner') {
      throw new Error('Only workspace owners can remove an admin.');
    }

    this.db
      .prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .run(workspaceId, targetUserId);

    const targetUser = this.getUserRowById(targetUserId);
    if (targetUser && targetUser.active_workspace_id === workspaceId) {
      const fallbackWs = this.db
        .prepare(
          `SELECT w.workspace_id, w.mode, w.backend_url
           FROM workspaces w
           INNER JOIN workspace_members m ON m.workspace_id = w.workspace_id
           WHERE m.user_id = ?
           ORDER BY w.created_at ASC
           LIMIT 1`
        )
        .get(targetUserId) as
        | { workspace_id: string; mode: DeploymentChoice | null; backend_url: string | null }
        | undefined;

      if (fallbackWs) {
        this.db
          .prepare('UPDATE users SET active_workspace_id = ?, mode = ?, backend_url = ? WHERE user_id = ?')
          .run(fallbackWs.workspace_id, fallbackWs.mode, fallbackWs.backend_url, targetUserId);
      } else {
        const personalWs = this.createWorkspace(targetUserId, 'My Workspace');
        this.db
          .prepare('UPDATE users SET active_workspace_id = ?, mode = ?, backend_url = NULL WHERE user_id = ?')
          .run(personalWs.workspaceId, personalWs.mode, targetUserId);
      }
    }

    return this.listWorkspaceMembers(actorUserId, workspaceId);
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

const AUTH_COOKIE_NAME = 'ea_auth';

function parseCookieToken(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      const val = part.slice(idx + 1).trim();
      return val ? decodeURIComponent(val) : null;
    }
  }
  return null;
}

function setAuthCookie(res: http.ServerResponse, token: string, maxAgeSec = 86400): void {
  const cookie = `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
  res.setHeader('Set-Cookie', cookie);
}

function clearAuthCookie(res: http.ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    `${AUTH_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function resolveRequestOrigin(req: http.IncomingMessage): string {
  const configured = (process.env.PUBLIC_URL || process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto =
    typeof protoHeader === 'string' && protoHeader.trim()
      ? protoHeader.split(',')[0].trim()
      : 'http';
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
  const host = typeof hostHeader === 'string' ? hostHeader.split(',')[0].trim() : 'localhost:3000';
  return `${proto}://${host}`;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function attachEnterpriseControlPlane(manager: CloudAccountManager) {
  return {
    edition: 'enterprise' as const,
    capabilities: {
      multiUser: true
    },
    handleExtensionRequest: async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      pathname: string
    ): Promise<boolean> => {
      if (pathname === '/api/cloud/register' && req.method === 'POST') {
        try {
          const body = await readJson(req);
          const result = manager.register(
            String(body.email || ''),
            String(body.password || ''),
            typeof body.workspaceName === 'string' ? body.workspaceName : undefined
          );
          setAuthCookie(res, result.accessToken);
          sendJson(res, 201, result);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'Registration failed.' });
        }
        return true;
      }

      if (pathname === '/api/cloud/login' && req.method === 'POST') {
        try {
          const body = await readJson(req);
          const result = manager.login(String(body.email || ''), String(body.password || ''));
          setAuthCookie(res, result.accessToken);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 401, { error: err instanceof Error ? err.message : 'Login failed.' });
        }
        return true;
      }

      if (pathname === '/api/cloud/logout' && req.method === 'POST') {
        clearAuthCookie(res);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (pathname === '/api/cloud/invites/verify' && req.method === 'GET') {
        try {
          const reqUrl = new URL(req.url || '', 'http://localhost');
          const token = reqUrl.searchParams.get('token') || '';
          const info = manager.verifyWorkspaceInvite(token);
          sendJson(res, 200, info);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'Invalid invite.' });
        }
        return true;
      }

      if (pathname === '/api/cloud/invites/accept' && req.method === 'POST') {
        try {
          const body = await readJson(req);
          const result = manager.acceptWorkspaceInvite(
            String(body.token || ''),
            String(body.password || '')
          );
          setAuthCookie(res, result.accessToken);
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'Failed to accept invite.' });
        }
        return true;
      }

      if (pathname === '/api/control-plane/claim' && req.method === 'POST') {
        try {
          const body = await readJson(req);
          const result = manager.claimSelfHostLinkCode(
            String(body.linkCode || ''),
            String(body.backendUrl || '')
          );
          sendJson(res, 200, result);
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : 'Claim failed.' });
        }
        return true;
      }

      if (pathname.startsWith('/api/cloud/')) {
        const cookieToken = parseCookieToken(req.headers.cookie, AUTH_COOKIE_NAME);
        const token = cookieToken || extractBearerToken(req.headers.authorization);
        const user = token ? manager.verifyCloudToken(token) : null;
        if (!user) {
          sendJson(res, 401, { error: 'Cloud authentication required.' });
          return true;
        }

        if (pathname === '/api/cloud/me' && req.method === 'GET') {
          sendJson(res, 200, { user });
          return true;
        }

        if (pathname === '/api/cloud/mode' && req.method === 'POST') {
          try {
            const body = await readJson(req);
            if (body.mode === 'cloud') {
              const updated = manager.selectCloudMode(user.userId);
              sendJson(res, 200, { user: updated });
            } else if (body.mode === 'selfhost') {
              const link = manager.generateSelfHostLinkCode(user.userId);
              sendJson(res, 200, link);
            } else {
              sendJson(res, 400, { error: 'Invalid mode. Use "cloud" or "selfhost".' });
            }
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : 'Mode update failed.' });
          }
          return true;
        }

        if (pathname === '/api/cloud/link-code' && req.method === 'POST') {
          const link = manager.generateSelfHostLinkCode(user.userId);
          sendJson(res, 200, link);
          return true;
        }

        if (pathname === '/api/cloud/link-status' && req.method === 'GET') {
          sendJson(res, 200, manager.getLinkStatus(user.userId));
          return true;
        }

        if (pathname === '/api/cloud/workspaces' && req.method === 'GET') {
          sendJson(res, 200, {
            workspaces: manager.listWorkspaces(user.userId),
            activeWorkspaceId: user.workspaceId
          });
          return true;
        }

        if (pathname === '/api/cloud/workspaces' && req.method === 'POST') {
          try {
            const body = await readJson(req);
            const workspace = manager.createWorkspace(
              user.userId,
              typeof body.name === 'string' ? body.name : undefined
            );
            sendJson(res, 201, { workspace });
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : 'Failed to create workspace.'
            });
          }
          return true;
        }

        if (pathname === '/api/cloud/workspaces/switch' && req.method === 'POST') {
          try {
            const body = await readJson(req);
            const switched = manager.switchWorkspace(
              user.userId,
              String(body.workspaceId || '')
            );
            setAuthCookie(res, switched.accessToken);
            sendJson(res, 200, switched);
          } catch (err) {
            sendJson(res, 400, {
              error: err instanceof Error ? err.message : 'Failed to switch workspace.'
            });
          }
          return true;
        }

        if (pathname === '/api/cloud/workspaces/members' && req.method === 'GET') {
          try {
            const reqUrl = new URL(req.url || '', 'http://localhost');
            const targetWsId = reqUrl.searchParams.get('workspaceId') || user.workspaceId;
            const members = manager.listWorkspaceMembers(user.userId, targetWsId);
            sendJson(res, 200, { members });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to list members.';
            sendJson(res, /only workspace/i.test(message) ? 403 : 400, { error: message });
          }
          return true;
        }

        if (pathname === '/api/cloud/workspaces/invite' && req.method === 'POST') {
          try {
            const body = await readJson(req);
            const targetWsId = String(body.workspaceId || user.workspaceId);
            const role: WorkspaceRole = body.role === 'admin' ? 'admin' : 'member';
            const inviteRes = manager.createWorkspaceInvite(
              user.userId,
              targetWsId,
              String(body.email || ''),
              role
            );

            if (inviteRes.alreadyMember) {
              sendJson(res, 200, {
                alreadyMember: true,
                members: inviteRes.members || [],
                emailSent: false
              });
              return true;
            }

            const origin = resolveRequestOrigin(req);
            const inviteUrl = `${origin}/?invite=${encodeURIComponent(inviteRes.token)}`;
            const mailResult = await sendWorkspaceInviteEmail({
              to: inviteRes.email,
              workspaceName: inviteRes.workspaceName,
              role: inviteRes.role,
              inviteUrl,
              invitedByEmail: user.email
            });

            sendJson(res, 200, {
              alreadyMember: false,
              inviteUrl,
              emailSent: mailResult.success,
              members: manager.listWorkspaceMembers(user.userId, targetWsId)
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to invite member.';
            sendJson(res, /only workspace/i.test(message) ? 403 : 400, { error: message });
          }
          return true;
        }

        if (pathname === '/api/cloud/workspaces/remove-member' && req.method === 'POST') {
          try {
            const body = await readJson(req);
            const targetWsId = String(body.workspaceId || user.workspaceId);
            const targetUserId = String(body.userId || '');
            const members = manager.removeWorkspaceMember(user.userId, targetWsId, targetUserId);
            sendJson(res, 200, { members });
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to remove member.';
            sendJson(res, /only workspace/i.test(message) ? 403 : 400, { error: message });
          }
          return true;
        }
      }

      return false;
    }
  };
}
