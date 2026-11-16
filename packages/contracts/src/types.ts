export interface Channel {
  id: string; // UUID v4
  name: string;
  description?: string;
  isDefault: boolean;
  agentIds?: string[];
  leaderAgentId?: string;
  orchestrationMode?: 'leader_delegation' | 'broadcast';
  createdAt: number;
}

export interface Agent {
  id: string; // UUID v4
  name: string;
  model: string;
  systemPrompt?: string;
  createdAt: number;
}

export interface QuotedMessage {
  id: string;
  senderName: string;
  content: string;
  attachmentPath?: string;
  attachmentName?: string;
  attachmentMimeType?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  originalName: string;
  size: number;
  mimeType: string;
  relativePath?: string;
  absolutePath?: string;
  dataUrl?: string;
  createdAt: number;
}

export interface SlideItem {
  title: string;
  subtitle?: string;
  bullets?: string[];
  notes?: string;
  theme?: 'dark' | 'light' | 'accent';
}

export interface PresentationDeck {
  id: string;
  title: string;
  author?: string;
  slides: SlideItem[];
  createdAt: number;
}

export type MediaExportFormat = 'pptx' | 'mp4' | 'both';

export interface Message {
  id: string; // UUID v4
  channelId: string; // UUID v4
  senderId: string; // UUID v4
  senderName: string;
  senderType: 'user' | 'agent';
  content: string;
  replyTo?: QuotedMessage;
  attachmentPath?: string;
  attachments?: FileAttachment[];
  deck?: PresentationDeck;
  isStarred?: boolean;
  createdAt: number;
}

export interface CreateChannelResult {
  success: boolean;
  channel?: Channel;
  error?: string;
}

export interface CreateAgentResult {
  success: boolean;
  agent?: Agent;
  error?: string;
}

export type AIGatewayProvider = 'openrouter' | 'gemini' | 'anthropic' | 'openai' | 'chatgpt' | 'custom';

export interface CodexAuthStatus {
  available: boolean;
  connected: boolean;
  email: string | null;
  planType: string | null;
  error?: string;
}

export interface CodexDeviceLoginChallenge {
  success: boolean;
  verificationUrl?: string;
  userCode?: string;
  error?: string;
}
export type VaultCredentialCategory = 'api_token' | 'login' | 'payment_card' | 'contact_info';
export type CredentialValidationStatus =
  | 'unverified'
  | 'valid'
  | 'invalid'
  | 'revoked'
  | 'migration_required'
  | 'error';

export interface OpenRouterCredentialStatus {
  provider: 'openrouter';
  baseUrl: string;
  model: string;
  hasKey: boolean;
  maskedKey: string;
  updatedAt: number | null;
  validationStatus: CredentialValidationStatus;
  migrationError?: string;
}

export interface AIGatewayConfig {
  provider: AIGatewayProvider;
  baseUrl: string;
  model: string;
  apiKeyEncrypted: string;
  updatedAt?: number | null;
  validationStatus?: CredentialValidationStatus;
}

export interface AIGatewayStatus {
  provider: AIGatewayProvider;
  baseUrl: string;
  model: string;
  maskedKey: string;
  hasKey: boolean;
  updatedAt?: number | null;
  validationStatus?: CredentialValidationStatus;
  migrationError?: string;
}

export interface VaultCredentialEntry {
  id: string;
  name: string;
  category: VaultCredentialCategory;
  serviceDomain?: string;
  encryptedValue: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface VaultCredentialPublic {
  id: string;
  name: string;
  category: VaultCredentialCategory;
  serviceDomain?: string;
  username?: string;
  maskedValue: string;
  notes?: string;
  createdAt: number;
}

export interface AIGatewayEntry {
  id: string;
  name: string;
  provider: AIGatewayProvider;
  baseUrl: string;
  model: string;
  apiKeyEncrypted: string;
  isDefault: boolean;
  validationStatus?: CredentialValidationStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AIGatewayPublic {
  id: string;
  name: string;
  provider: AIGatewayProvider;
  baseUrl: string;
  model: string;
  maskedKey: string;
  hasKey: boolean;
  isDefault: boolean;
  updatedAt?: number | null;
  validationStatus?: CredentialValidationStatus;
  createdAt: number;
}

export interface EncryptedVaultFile {
  version: number;
  updatedAt: number;
  aiGateway: AIGatewayConfig;
  aiGateways?: AIGatewayEntry[];
  vault: {
    credentials: VaultCredentialEntry[];
  };
}

export interface CodexModelInfo {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface VaultAPI {
  getAIGateway: () => Promise<AIGatewayStatus>;
  getOpenRouterStatus?: () => Promise<OpenRouterCredentialStatus>;
  setOpenRouterKey?: (config: {
    rawApiKey: string;
    model?: string;
    baseUrl?: string;
    name?: string;
  }) => Promise<{ success: boolean; id?: string; status?: OpenRouterCredentialStatus; error?: string }>;
  updateOpenRouterKey?: (config: {
    id?: string;
    rawApiKey?: string;
    model?: string;
    baseUrl?: string;
    name?: string;
  }) => Promise<{ success: boolean; id?: string; status?: OpenRouterCredentialStatus; error?: string }>;
  validateOpenRouterKey?: (config?: {
    id?: string;
    rawApiKey?: string;
    baseUrl?: string;
    model?: string;
  }) => Promise<{
    success: boolean;
    latencyMs?: number;
    validationStatus: CredentialValidationStatus;
    status?: OpenRouterCredentialStatus;
    error?: string;
  }>;
  revokeOpenRouterKey?: (id?: string) => Promise<{
    success: boolean;
    status?: OpenRouterCredentialStatus;
    error?: string;
  }>;
  saveAIGateway: (config: {
    id?: string;
    name?: string;
    provider: AIGatewayProvider;
    baseUrl: string;
    model: string;
    rawApiKey?: string;
    isDefault?: boolean;
  }) => Promise<{ success: boolean; id?: string; error?: string }>;
  listAIGateways: () => Promise<AIGatewayPublic[]>;
  deleteAIGateway: (id: string) => Promise<{ success: boolean; error?: string }>;
  setDefaultAIGateway: (id: string) => Promise<{ success: boolean; error?: string }>;
  testAIGateway: (config?: {
    provider?: AIGatewayProvider;
    baseUrl?: string;
    model?: string;
    rawApiKey?: string;
  }) => Promise<{ success: boolean; latencyMs?: number; error?: string }>;
  listCredentials: () => Promise<VaultCredentialPublic[]>;
  saveCredential: (data: {
    name: string;
    category: VaultCredentialCategory;
    serviceDomain?: string;
    rawValue: string;
    notes?: string;
  }) => Promise<{ success: boolean; id?: string; error?: string }>;
  deleteCredential: (id: string) => Promise<{ success: boolean; error?: string }>;
  codexStatus?: () => Promise<CodexAuthStatus>;
  codexLoginStart?: () => Promise<CodexDeviceLoginChallenge>;
  codexLogout?: () => Promise<{ success: boolean; error?: string }>;
  codexModels?: () => Promise<{ success: boolean; models: CodexModelInfo[]; error?: string }>;
}

export interface FileAPI {
  uploadDialog: (options?: {
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  saveAttachment: (
    conversationId: string,
    source:
      | string
      | {
          name: string;
          buffer: Uint8Array | string;
          mimeType?: string;
        }
  ) => Promise<FileAttachment>;
  saveTextAttachment: (
    conversationId: string,
    content: string,
    suggestedName?: string,
    mimeType?: string
  ) => Promise<FileAttachment>;
  readAttachment: (relativePath: string) => Promise<{ data: string; mimeType: string }>;
  openExternal: (path: string) => Promise<boolean>;
  showItemInFolder: (path: string) => Promise<boolean>;
}

export interface MediaAPI {
  compilePptx: (deck: PresentationDeck, conversationId?: string) => Promise<FileAttachment>;
  compileVideo: (deck: PresentationDeck, conversationId?: string) => Promise<FileAttachment>;
  generateDeck: (
    deck: PresentationDeck,
    format: MediaExportFormat,
    conversationId?: string
  ) => Promise<FileAttachment[]>;
  previewDeck: (
    deck: PresentationDeck,
    conversationId?: string
  ) => Promise<{ absolutePath: string; fileUrl: string }>;
}

export interface BrowserTab {
  id: string;
  title: string;
  url: string;
  isLoading?: boolean;
  history?: string[];
  historyIndex?: number;
}

export interface BrowserScrapeResult {
  url: string;
  title: string;
  text: string;
  timestamp: number;
}

export interface BrowserBoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserAPI {
  scrapeUrl: (url: string) => Promise<{ success: boolean; data?: BrowserScrapeResult; error?: string }>;
  isElectron?: boolean;
  attachTab?: (params: {
    tabId: string;
    url: string;
    conversationId?: string;
    conversationType?: 'agent' | 'channel';
    bounds?: Partial<BrowserBoundsRect>;
  }) => Promise<{ success: boolean; url: string }>;
  setBounds?: (bounds: Partial<BrowserBoundsRect>) => Promise<{ success: boolean }>;
  showTab?: (tabId: string) => Promise<{ success: boolean }>;
  hideActiveTab?: () => Promise<{ success: boolean }>;
  navigate?: (tabId: string, url: string) => Promise<{ success: boolean }>;
  goBack?: (tabId: string) => Promise<{ success: boolean }>;
  goForward?: (tabId: string) => Promise<{ success: boolean }>;
  reload?: (tabId: string) => Promise<{ success: boolean }>;
  closeTab?: (tabId: string) => Promise<{ success: boolean }>;
  onNavigated?: (callback: (data: { tabId: string; url: string }) => void) => () => void;
  onLoading?: (callback: (data: { tabId: string; loading: boolean }) => void) => () => void;
}

export interface ServiceClientStatus {
  ready: boolean;
  port: number | null;
  restarting: boolean;
  failed: boolean;
}

export interface ServiceClientAPI {
  status: () => Promise<ServiceClientStatus>;
  createRun: (goal: string) => Promise<unknown>;
  bootstrapRun: (runId: string) => Promise<unknown>;
  getRun: (runId: string) => Promise<unknown>;
  getEvents: (runId: string, afterSeq: number) => Promise<unknown>;
  pauseRun: (runId: string, expectedVersion?: number) => Promise<unknown>;
  resumeRun: (runId: string, expectedVersion?: number) => Promise<unknown>;
  cancelRun: (runId: string, expectedVersion?: number) => Promise<unknown>;
}

export type PrivateChatLifecycleState =
  | 'idle'
  | 'sending'
  | 'responding'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PrivateChatSendIntent {
  conversationId: string;
  agentId: string;
  content: string;
  replyToMessageId?: string;
  requestId?: string;
}

export interface PrivateChatSendResult {
  success: boolean;
  conversationId: string;
  agentId: string;
  turnId?: string;
  lifecycleState: PrivateChatLifecycleState;
  userMessage?: Message;
  agentMessage?: Message;
  error?: string;
  errorCode?: string;
}

export interface PrivateChatAPI {
  sendPrivate: (intent: PrivateChatSendIntent) => Promise<PrivateChatSendResult>;
  cancelPrivate: (conversationId: string) => Promise<{ success: boolean; lifecycleState: PrivateChatLifecycleState }>;
  getHistory: (conversationId: string, agentId: string) => Promise<{ success: boolean; messages: Message[]; error?: string }>;
  getState: (conversationId: string) => Promise<{ conversationId: string; lifecycleState: PrivateChatLifecycleState }>;
}

export interface ElectronAPI {
  getChannels: () => Promise<Channel[]>;
  createChannel: (name: string, description?: string, agentIds?: string[], leaderAgentId?: string, id?: string) => Promise<CreateChannelResult>;
  getAgents: () => Promise<Agent[]>;
  createAgent: (agent: Omit<Agent, 'id' | 'createdAt'> & { id?: string }) => Promise<CreateAgentResult>;
  updateAgentModel?: (agentId: string, model: string) => Promise<boolean>;
  getMessages: (channelId: string) => Promise<Message[]>;
  sendMessage: (
    channelId: string,
    content: string,
    senderType?: 'user' | 'agent',
    senderName?: string,
    senderId?: string
  ) => Promise<Message>;
  aiChat?: (params: {
    messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
    model?: string;
    systemPrompt?: string;
    channelId?: string;
  }) => Promise<{ success: boolean; content?: string; error?: string }>;
  chat?: PrivateChatAPI;
  vault?: VaultAPI;
  file?: FileAPI;
  media?: MediaAPI;
  browser?: BrowserAPI;
  service?: ServiceClientAPI;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
