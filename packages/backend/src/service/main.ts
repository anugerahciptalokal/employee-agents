import { startService, type ServiceRuntime } from './runtime/service-runtime';
import { ParentPortCredentialBroker } from './credentials/broker-client';
import { createProviderTurnServiceFromEnv } from './providers/provider-turn-service';
import { ToolRegistry } from './tools/registry';

interface InitMessage {
  type: 'init';
  token: string;
  dataDir: string;
  nonce: string;
}

interface ShutdownMessage {
  type: 'shutdown';
}

type ParentMessage = InitMessage | ShutdownMessage;

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (
  process as NodeJS.Process & { parentPort?: ParentPortLike }
).parentPort;

if (!parentPort) {
  console.error('[service] Parent port is unavailable.');
  process.exit(1);
}

const port = parentPort;

let runtime: ServiceRuntime | null = null;
let starting = false;
let shuttingDown = false;

function send(message: unknown): void {
  try {
    parentPort?.postMessage(message);
  } catch {
    // The parent may already be gone.
  }
}

async function initialize(message: InitMessage): Promise<void> {
  if (runtime || starting || shuttingDown) return;
  starting = true;

  try {
    if (
      typeof message.token !== 'string' ||
      !message.token ||
      typeof message.dataDir !== 'string' ||
      !message.dataDir ||
      typeof message.nonce !== 'string' ||
      message.nonce !== process.env.OPEN_EMPLOYEE_SERVICE_NONCE
    ) {
      throw new Error('Invalid service initialization message.');
    }

    const credentialBroker = new ParentPortCredentialBroker({
      port,
      nonce: message.nonce
    });

    const toolRegistry = new ToolRegistry();
    const toolCatalog = toolRegistry.toCatalog();
    const providerTurnService = createProviderTurnServiceFromEnv(
      process.env,
      credentialBroker,
      { toolCatalog }
    );

    runtime = await startService({
      dataDir: message.dataDir,
      token: message.token,
      credentialBroker,
      ...(providerTurnService ? { providerTurnService } : {})
    });

    send({
      type: 'ready',
      host: runtime.address.host,
      port: runtime.address.port,
      nonce: message.nonce,
      pid: process.pid
    });
  } catch {
    send({
      type: 'error',
      code: 'START_FAILED',
      message: 'Local agent service failed to start.'
    });
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 0);
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    await runtime?.stop();
  } catch {
    // Shutdown must continue so the parent can reap the process.
  }

  send({ type: 'stopped' });
  process.exit(0);
}

port.on('message', (event) => {
  const message = event.data as ParentMessage;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'init') {
    void initialize(message);
  } else if (message.type === 'shutdown') {
    void shutdown();
  }
});

process.on('SIGTERM', () => {
  void shutdown();
});

process.on('SIGINT', () => {
  void shutdown();
});

process.on('disconnect', () => {
  void shutdown();
});

process.on('uncaughtException', () => {
  send({
    type: 'error',
    code: 'UNCAUGHT_EXCEPTION',
    message: 'Local agent service encountered an unexpected error.'
  });
  void shutdown();
});

process.on('unhandledRejection', () => {
  send({
    type: 'error',
    code: 'UNHANDLED_REJECTION',
    message: 'Local agent service encountered an unexpected rejection.'
  });
  void shutdown();
});
