import {
  createServer,
  STATUS_CODES,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServiceEvent } from '@open-employee/contracts/contracts/service';
import type { RunEngine, RunEngineError } from '../runtime/run-engine';
import { isAuthorized, isLoopbackRequest } from './auth';
import { mergeEventStreams } from './event-merge';

const DEFAULT_PORT = 0;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_BUFFERED_AMOUNT = 1024 * 1024;
const DEFAULT_MAX_PENDING_EVENTS = 1024;
const LOOPBACK_HOST = '127.0.0.1';

export interface ServiceApiServerOptions {
  runEngine: RunEngine;
  token: string;
  port?: number;
  heartbeatIntervalMs?: number;
  maxBodyBytes?: number;
  maxBufferedAmount?: number;
  maxPendingEvents?: number;
}

export interface ServiceApiAddress {
  host: '127.0.0.1';
  port: number;
}

interface ClientMeta {
  isAlive: boolean;
  replaying: boolean;
  lastSentSeq: number;
  pending: ServiceEvent[];
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  if (response.writableEnded) return;

  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', Buffer.byteLength(payload));
  response.end(payload);
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  code: string,
  message: string
): void {
  const payload = JSON.stringify({ error: { code, message } });
  socket.write(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      'Connection: close\r\n\r\n' +
      payload
  );
  socket.destroy();
}

function parseAfterSeq(url: URL): number {
  const raw = url.searchParams.get('after_seq');
  if (raw === null || raw === '') return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'after_seq must be a non-negative integer.');
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'after_seq is out of range.');
  }

  return value;
}

function decodeRunId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Run id is not valid URL encoding.');
  }
}

function readJsonBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
      request.resume();
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;

      if (total > maxBytes) {
        settled = true;
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
        request.resume();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) return;
      settled = true;

      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }

      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new HttpError(400, 'VALIDATION_ERROR', 'Request body is not valid JSON.'));
      }
    });

    request.on('error', () => {
      if (settled) return;
      settled = true;
      reject(new HttpError(400, 'VALIDATION_ERROR', 'Request body could not be read.'));
    });
  });
}

export class ServiceApiServer {
  private readonly runEngine: RunEngine;
  private readonly token: string;
  private readonly portOption: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxBufferedAmount: number;
  private readonly maxPendingEvents: number;
  private httpServer: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly clientMeta = new WeakMap<WebSocket, ClientMeta>();
  private currentPort = 0;

  constructor(options: ServiceApiServerOptions) {
    if (!options.token || !options.token.trim()) {
      throw new Error('Service API token is required.');
    }

    this.runEngine = options.runEngine;
    this.token = options.token;
    this.portOption = options.port ?? DEFAULT_PORT;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxBufferedAmount =
      options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT;
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
  }

  public get address(): ServiceApiAddress | null {
    if (!this.httpServer || !this.httpServer.listening) return null;
    return { host: LOOPBACK_HOST, port: this.currentPort };
  }

  public get connectionCount(): number {
    let count = 0;
    for (const clients of this.clients.values()) {
      count += clients.size;
    }
    return count;
  }

  public async start(): Promise<ServiceApiAddress> {
    if (this.httpServer) {
      throw new Error('Service API server is already running.');
    }

    const httpServer = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (response.writableEnded) return;
        if (error instanceof HttpError) {
          sendJson(response, error.status, {
            error: { code: error.code, message: error.message }
          });
          return;
        }

        sendJson(response, 500, {
          error: { code: 'INTERNAL_ERROR', message: 'Internal service error.' }
        });
      });
    });

    const webSocketServer = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          httpServer.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          resolve();
        };

        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(this.portOption, LOOPBACK_HOST);
      });
    } catch (error) {
      webSocketServer.close();
      httpServer.close();
      throw error;
    }

    this.httpServer = httpServer;
    this.webSocketServer = webSocketServer;
    this.currentPort = (httpServer.address() as AddressInfo).port;
    this.startHeartbeat();

    return this.address!;
  }

  public async stop(): Promise<void> {
    this.stopHeartbeat();

    for (const clients of this.clients.values()) {
      for (const client of clients) {
        try {
          client.terminate();
        } catch {
          // ignore shutdown errors
        }
      }
    }
    this.clients.clear();

    const webSocketServer = this.webSocketServer;
    const httpServer = this.httpServer;
    this.webSocketServer = null;
    this.httpServer = null;

    if (webSocketServer) {
      await new Promise<void>((resolve) => {
        webSocketServer.close(() => resolve());
      });
    }

    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }

    this.currentPort = 0;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, {
        error: { code: 'LOOPBACK_ONLY', message: 'The service API is loopback-only.' }
      });
      return;
    }

    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);

    if (url.pathname === '/v1/health' && request.method === 'GET') {
      sendJson(response, 200, { status: 'ready' });
      return;
    }

    if (!isAuthorized(request, this.token)) {
      sendJson(response, 401, {
        error: {
          code: 'UNAUTHORIZED',
          message: 'A valid bearer token is required.'
        }
      });
      return;
    }

    if (url.pathname === '/v1/runs' && request.method === 'POST') {
      const body = await readJsonBody(request, this.maxBodyBytes);
      if (typeof body.goal !== 'string') {
        throw new HttpError(400, 'VALIDATION_ERROR', 'goal must be a string.');
      }

      const result = this.runEngine.createRun(body.goal);
      if (!result.ok) {
        this.sendEngineError(response, result.error);
        return;
      }

      this.broadcast(result.events);
      sendJson(response, 201, { run: result.value });
      return;
    }

    const eventsMatch = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (eventsMatch && request.method === 'GET') {
      const runId = decodeRunId(eventsMatch[1]);
      const afterSeq = parseAfterSeq(url);

      if (!this.runEngine.getRun(runId)) {
        throw new HttpError(404, 'RUN_NOT_FOUND', `Run ${runId} was not found.`);
      }

      sendJson(response, 200, {
        events: this.runEngine.getEvents(runId, afterSeq)
      });
      return;
    }

    const actionMatch = /^\/v1\/runs\/([^/]+)\/(bootstrap|pause|resume|cancel)$/.exec(
      url.pathname
    );
    if (actionMatch && request.method === 'POST') {
      const runId = decodeRunId(actionMatch[1]);
      const action = actionMatch[2];

      if (action === 'bootstrap') {
        const result = this.runEngine.bootstrapRun(runId);
        if (!result.ok) {
          this.sendEngineError(response, result.error);
          return;
        }

        this.broadcast(result.events);
        sendJson(response, 200, {
          run: result.value.run,
          plan: result.value.plan
        });
        return;
      }

      const body = await readJsonBody(request, this.maxBodyBytes);
      const expectedVersion = body.expected_version;
      if (
        expectedVersion !== undefined &&
        (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 0)
      ) {
        throw new HttpError(
          400,
          'VALIDATION_ERROR',
          'expected_version must be a non-negative integer.'
        );
      }

      const result =
        action === 'pause'
          ? this.runEngine.pauseRun(runId, expectedVersion as number | undefined)
          : action === 'resume'
            ? this.runEngine.resumeRun(runId, expectedVersion as number | undefined)
            : this.runEngine.cancelRun(runId, expectedVersion as number | undefined);

      if (!result.ok) {
        this.sendEngineError(response, result.error);
        return;
      }

      this.broadcast(result.events);
      sendJson(response, 200, { run: result.value });
      return;
    }

    const runMatch = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (runMatch && request.method === 'GET') {
      const runId = decodeRunId(runMatch[1]);
      const run = this.runEngine.getRun(runId);
      if (!run) {
        throw new HttpError(404, 'RUN_NOT_FOUND', `Run ${runId} was not found.`);
      }

      sendJson(response, 200, { run });
      return;
    }

    throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
  }

  private handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    if (!isLoopbackRequest(request)) {
      rejectUpgrade(socket, 403, 'LOOPBACK_ONLY', 'The service API is loopback-only.');
      return;
    }

    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`);
    const match = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (!match) {
      rejectUpgrade(socket, 404, 'NOT_FOUND', 'Route not found.');
      return;
    }

    if (!isAuthorized(request, this.token)) {
      rejectUpgrade(socket, 401, 'UNAUTHORIZED', 'A valid bearer token is required.');
      return;
    }

    let afterSeq: number;
    try {
      afterSeq = parseAfterSeq(url);
    } catch (error) {
      const httpError = error as HttpError;
      rejectUpgrade(socket, httpError.status, httpError.code, httpError.message);
      return;
    }

    const runId = decodeRunId(match[1]);
    if (!this.runEngine.getRun(runId)) {
      rejectUpgrade(socket, 404, 'RUN_NOT_FOUND', `Run ${runId} was not found.`);
      return;
    }

    if (!this.webSocketServer) {
      rejectUpgrade(socket, 503, 'UNAVAILABLE', 'WebSocket server is not ready.');
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.attachClient(webSocket, runId, afterSeq);
    });
  }

  private attachClient(
    webSocket: WebSocket,
    runId: string,
    afterSeq: number
  ): void {
    const meta: ClientMeta = {
      isAlive: true,
      replaying: true,
      lastSentSeq: afterSeq,
      pending: []
    };
    this.clientMeta.set(webSocket, meta);

    let clients = this.clients.get(runId);
    if (!clients) {
      clients = new Set();
      this.clients.set(runId, clients);
    }
    clients.add(webSocket);

    webSocket.on('pong', () => {
      meta.isAlive = true;
    });
    webSocket.on('close', () => this.removeClient(webSocket, runId));
    webSocket.on('error', () => this.removeClient(webSocket, runId));

    try {
      const replay = this.runEngine.getEvents(runId, afterSeq);
      meta.replaying = false;
      const pending = meta.pending.splice(0);
      const events = mergeEventStreams(afterSeq, replay, pending);

      for (const event of events) {
        if (!this.sendEvent(webSocket, meta, runId, event)) break;
      }
    } catch {
      this.dropClient(webSocket, runId);
    }
  }

  private removeClient(webSocket: WebSocket, runId: string): void {
    const clients = this.clients.get(runId);
    if (!clients) return;

    clients.delete(webSocket);
    if (clients.size === 0) {
      this.clients.delete(runId);
    }
    this.clientMeta.delete(webSocket);
  }

  private dropClient(webSocket: WebSocket, runId: string): void {
    try {
      webSocket.terminate();
    } catch {
      // ignore termination failure
    }
    this.removeClient(webSocket, runId);
  }

  private enqueueEvent(
    webSocket: WebSocket,
    meta: ClientMeta,
    runId: string,
    event: ServiceEvent
  ): void {
    if (event.seq <= meta.lastSentSeq) return;

    if (meta.replaying) {
      if (meta.pending.some((pending) => pending.seq === event.seq)) return;
      if (meta.pending.length >= this.maxPendingEvents) {
        this.dropClient(webSocket, runId);
        return;
      }
      meta.pending.push(event);
      return;
    }

    this.sendEvent(webSocket, meta, runId, event);
  }

  private sendEvent(
    webSocket: WebSocket,
    meta: ClientMeta,
    runId: string,
    event: ServiceEvent
  ): boolean {
    if (event.seq <= meta.lastSentSeq) {
      return webSocket.readyState === WebSocket.OPEN;
    }
    if (webSocket.readyState !== WebSocket.OPEN) return false;

    const message = JSON.stringify({ type: 'event', event });
    if (
      webSocket.bufferedAmount + Buffer.byteLength(message) >
      this.maxBufferedAmount
    ) {
      this.dropClient(webSocket, runId);
      return false;
    }

    try {
      webSocket.send(message);
      meta.lastSentSeq = event.seq;
      return true;
    } catch {
      this.dropClient(webSocket, runId);
      return false;
    }
  }

  private broadcast(events: ServiceEvent[]): void {
    for (const event of events) {
      const clients = this.clients.get(event.runId);
      if (!clients) continue;

      for (const client of [...clients]) {
        const meta = this.clientMeta.get(client);
        if (!meta) continue;
        this.enqueueEvent(client, meta, event.runId, event);
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      for (const [runId, clients] of this.clients) {
        for (const client of [...clients]) {
          const meta = this.clientMeta.get(client);
          if (!meta) continue;

          if (!meta.isAlive) {
            client.terminate();
            this.removeClient(client, runId);
            continue;
          }

          meta.isAlive = false;
          try {
            client.ping();
          } catch {
            client.terminate();
            this.removeClient(client, runId);
          }
        }
      }
    }, this.heartbeatIntervalMs);

    if (typeof this.heartbeatTimer.unref === 'function') {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendEngineError(response: ServerResponse, error: RunEngineError): void {
    const status =
      error.code === 'RUN_NOT_FOUND'
        ? 404
        : error.code === 'VALIDATION_ERROR'
          ? 400
          : error.code === 'CONFLICT' || error.code === 'INVALID_TRANSITION'
            ? 409
            : 500;

    sendJson(response, status, {
      error: { code: error.code, message: error.message }
    });
  }
}
