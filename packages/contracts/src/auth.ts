export type BackendEdition = 'oss' | 'enterprise';

export interface BackendCapabilities {
  multiUser: boolean;
  controlPlaneLinked: boolean;
  pairingEnabled: boolean;
  ownerConfigured?: boolean;
}

export interface BackendMetaResponse {
  edition: BackendEdition;
  apiVersion: string;
  capabilities: BackendCapabilities;
}

export interface AuthIdentity {
  userId: string;
  role: 'owner' | 'admin' | 'member';
  workspaceId: string;
  issuer: string;
  email?: string;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthIdentity;
}

export interface WsTicketResponse {
  ticket: string;
  expiresAt: number;
}

export type DeploymentChoice = 'cloud' | 'selfhost';
export type WorkspaceRole = 'owner' | 'admin' | 'member';

export interface WorkspaceMemberInfo {
  userId: string;
  email: string;
  role: WorkspaceRole;
  joinedAt: number;
}

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  role: WorkspaceRole;
  mode: DeploymentChoice | null;
  backendUrl?: string;
  memberCount: number;
  createdAt: number;
}

export interface CloudUserProfile {
  userId: string;
  email: string;
  mode: DeploymentChoice | null;
  backendUrl?: string;
  workspaceId: string;
  workspaceName?: string;
}

export interface CloudAuthResponse {
  accessToken: string;
  user: CloudUserProfile;
}

export interface SelfHostLinkCodeResponse {
  linkCode: string;
  expiresAt: number;
}

export interface ControlPlaneClaimRequest {
  linkCode: string;
  backendUrl: string;
}

export interface ControlPlaneClaimResponse {
  publicKeyPem: string;
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
}

export interface SelfHostLinkStatusResponse {
  linked: boolean;
  backendUrl?: string;
}
