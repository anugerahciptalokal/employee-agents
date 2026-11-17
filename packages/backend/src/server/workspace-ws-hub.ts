import type http from 'http';
import { WebSocket, WebSocketServer } from 'ws';

export interface WorkspaceWsEvent {
  type: 'workspace:connected' | 'workspace:updated' | 'browser:sync';
  reason?: string;
  action?: 'open' | 'navigate';
  url?: string;
  title?: string;
  conversationId?: string;
  ts: number;
}

/**
 * Lightweight WebSocket hub that notifies web clients whenever workspace state
 * (messages, channels, agents, or background turn status) changes on the server,
 * eliminating periodic /api/workspace polling.
 */
export class WorkspaceWsHub {
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private readonly attachedServers = new WeakSet<http.Server>();

  public attachToServer(server: http.Server): void {
    if (this.attachedServers.has(server)) return;
    this.attachedServers.add(server);

    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        this.sendEvent(ws, { type: 'workspace:connected', ts: Date.now() });

        ws.on('close', () => {
          this.clients.delete(ws);
        });
        ws.on('error', () => {
          this.clients.delete(ws);
        });
      });
    }

    server.on('upgrade', (request, socket, head) => {
      try {
        const { pathname } = new URL(request.url || '', 'http://localhost');
        if (pathname === '/api/workspace/ws' && this.wss) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss?.emit('connection', ws, request);
          });
        }
      } catch {
        // Ignore malformed upgrade URLs
      }
    });
  }

  public broadcastUpdate(reason?: string): void {
    this.broadcastPayload({
      type: 'workspace:updated',
      reason,
      ts: Date.now()
    });
  }

  public broadcastBrowserEvent(event: {
    action: 'open' | 'navigate';
    url: string;
    title?: string;
    conversationId?: string;
  }): void {
    this.broadcastPayload({
      type: 'browser:sync',
      action: event.action,
      url: event.url,
      title: event.title,
      conversationId: event.conversationId,
      ts: Date.now()
    });
  }

  public broadcastExtensionEvent(payload: Record<string, unknown> & { type: string }): void {
    this.broadcastPayload({
      ...payload,
      ts: Date.now()
    } as WorkspaceWsEvent);
  }

  private broadcastPayload(payload: WorkspaceWsEvent): void {
    if (this.clients.size === 0) return;
    const encoded = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(encoded);
        } catch {
          this.clients.delete(client);
        }
      }
    }
  }

  public close(): void {
    for (const client of this.clients) {
      try {
        client.close();
      } catch {
        // Ignore
      }
    }
    this.clients.clear();
    try {
      this.wss?.close();
    } catch {
      // Ignore
    }
    this.wss = null;
  }

  private sendEvent(ws: WebSocket, event: WorkspaceWsEvent): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(event));
    } catch {
      // Ignore
    }
  }
}

