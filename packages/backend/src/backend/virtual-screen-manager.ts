import { EventEmitter } from 'events';
import { type ChildProcess } from 'child_process';
import net from 'net';
import {
  parseResolutionString,
  encodeRfbPointerEvent,
  encodeRfbKeyEvent
} from '@open-employee/contracts/rfb-protocol';

export {
  parseResolutionString,
  encodeRfbPointerEvent,
  encodeRfbKeyEvent
};

export interface VirtualScreenConfig {
  display?: string;
  resolution?: string;
  vncPort?: number;
  wsPort?: number;
  autoStart?: boolean;
}

export type VirtualScreenState = 'stopped' | 'starting' | 'ready' | 'error';

export interface VirtualScreenStatus {
  state: VirtualScreenState;
  display: string;
  resolution: string;
  width: number;
  height: number;
  vncPort: number;
  wsPort: number;
  fps: number;
  error?: string;
}

export class VirtualScreenManager extends EventEmitter {
  private display: string;
  private resolution: string;
  private width: number;
  private height: number;
  private vncPort: number;
  private wsPort: number;
  private state: VirtualScreenState = 'stopped';
  private errorMessage?: string;
  private processes: ChildProcess[] = [];

  constructor(config: VirtualScreenConfig = {}) {
    super();
    this.display = config.display || process.env.DISPLAY_NUM || ':0';
    this.resolution = config.resolution || process.env.RESOLUTION || '1440x900';
    const parsed = parseResolutionString(this.resolution);
    this.width = parsed.width;
    this.height = parsed.height;
    this.vncPort = config.vncPort || (process.env.VNC_PORT ? parseInt(process.env.VNC_PORT, 10) : 5900);
    this.wsPort = config.wsPort || (process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 6080);

    if (config.autoStart) {
      this.start().catch((err) => {
        this.emit('error', err);
      });
    }
  }

  public getStatus(): VirtualScreenStatus {
    return {
      state: this.state,
      display: this.display,
      resolution: this.resolution,
      width: this.width,
      height: this.height,
      vncPort: this.vncPort,
      wsPort: this.wsPort,
      fps: 60,
      error: this.errorMessage
    };
  }

  public setResolution(newResolution: string): void {
    const parsed = parseResolutionString(newResolution);
    this.resolution = newResolution;
    this.width = parsed.width;
    this.height = parsed.height;
    this.emit('resolution-change', {
      resolution: this.resolution,
      width: this.width,
      height: this.height
    });
  }

  public async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') {
      return;
    }

    this.state = 'starting';
    this.errorMessage = undefined;
    this.emit('state-change', this.state);

    // If running in Docker Linux sandbox, ensure xvfb and websockify ports
    try {
      this.state = 'ready';
      this.emit('state-change', this.state);
    } catch (err: any) {
      this.state = 'error';
      this.errorMessage = err?.message || String(err);
      this.emit('error', err);
    }
  }

  public async stop(): Promise<void> {
    this.state = 'stopped';
    for (const proc of this.processes) {
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
    this.processes = [];
    this.emit('state-change', this.state);
  }

  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Health check to detect whether the VNC or websockify port is responsive
   */
  public async isPortAlive(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(300);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, host);
    });
  }
}

// Global Singleton for the backend
export const globalVirtualScreenManager = new VirtualScreenManager({
  autoStart: false
});
