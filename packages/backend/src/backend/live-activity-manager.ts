import { randomUUID } from 'crypto';

export interface LiveActivityAttributes {
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  conversationId: string;
}

export interface LiveActivityState {
  taskTitle: string;
  agentName: string;
  progress: number; // 0..100
  status: 'running' | 'completed' | 'failed';
  currentStep?: string;
  error?: string;
}

export interface LiveActivitySession extends LiveActivityAttributes, LiveActivityState {
  id: string;
  startedAt: number;
  endedAt?: number;
}

export interface ApnsNotificationInput {
  title: string;
  body: string;
  conversationId: string;
  agentId?: string;
  serverName?: string;
  sound?: string;
}

export interface DevicePushToken {
  deviceId: string;
  token: string;
  platform: 'ios' | 'android';
  updatedAt: number;
}

/**
 * Builds Apple ActivityKit ContentState structure for iOS Dynamic Island & Lockscreen.
 */
export function buildActivityKitContentState(state: LiveActivityState): {
  state: LiveActivityState;
  staleDate: number;
} {
  return {
    state: {
      taskTitle: state.taskTitle,
      agentName: state.agentName,
      progress: Math.min(100, Math.max(0, state.progress)),
      status: state.status,
      currentStep: state.currentStep,
      error: state.error
    },
    // Activity expires in 4 hours if no updates occur
    staleDate: Date.now() + 4 * 60 * 60 * 1000
  };
}

/**
 * Formats a payload for Apple Push Notification Service (APNs).
 */
export function buildApnsPayload(input: ApnsNotificationInput): {
  aps: {
    alert: {
      title: string;
      body: string;
    };
    sound: string;
    'thread-id': string;
    'content-available'?: number;
  };
  data: {
    conversationId: string;
    agentId?: string;
    serverName?: string;
  };
} {
  return {
    aps: {
      alert: {
        title: input.title,
        body: input.body
      },
      sound: input.sound || 'default',
      'thread-id': input.conversationId,
      'content-available': 1
    },
    data: {
      conversationId: input.conversationId,
      agentId: input.agentId,
      serverName: input.serverName
    }
  };
}

export class LiveActivityManager {
  private sessions: Map<string, LiveActivitySession> = new Map();
  private pushTokens: Map<string, DevicePushToken> = new Map();

  public createActivity(input: {
    taskId: string;
    taskTitle: string;
    agentId: string;
    agentName: string;
    conversationId: string;
  }): LiveActivitySession {
    const id = `activity_${randomUUID().slice(0, 12)}`;
    const now = Date.now();

    const session: LiveActivitySession = {
      id,
      taskId: input.taskId,
      taskTitle: input.taskTitle,
      agentId: input.agentId,
      agentName: input.agentName,
      conversationId: input.conversationId,
      progress: 0,
      status: 'running',
      startedAt: now
    };

    this.sessions.set(id, session);
    return session;
  }

  public getActivity(id: string): LiveActivitySession | undefined {
    return this.sessions.get(id);
  }

  public updateProgress(id: string, progress: number, currentStep?: string): LiveActivitySession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    session.progress = Math.min(100, Math.max(0, progress));
    if (currentStep !== undefined) {
      session.currentStep = currentStep;
    }

    return session;
  }

  public completeActivity(id: string, currentStep?: string): LiveActivitySession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    session.status = 'completed';
    session.progress = 100;
    if (currentStep) session.currentStep = currentStep;
    session.endedAt = Date.now();

    return session;
  }

  public failActivity(id: string, error: string): LiveActivitySession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    session.status = 'failed';
    session.error = error;
    session.endedAt = Date.now();

    return session;
  }

  public listActivities(status?: 'running' | 'completed' | 'failed'): LiveActivitySession[] {
    const all = Array.from(this.sessions.values());
    if (!status) return all;
    return all.filter((s) => s.status === status);
  }

  // --- Push Token Registry ---

  public registerPushToken(deviceId: string, token: string, platform: 'ios' | 'android' = 'ios'): void {
    this.pushTokens.set(deviceId, {
      deviceId,
      token,
      platform,
      updatedAt: Date.now()
    });
  }

  public unregisterPushToken(deviceId: string): boolean {
    return this.pushTokens.delete(deviceId);
  }

  public listPushTokens(): DevicePushToken[] {
    return Array.from(this.pushTokens.values());
  }
}

// Global Singleton
export const globalLiveActivityManager = new LiveActivityManager();

