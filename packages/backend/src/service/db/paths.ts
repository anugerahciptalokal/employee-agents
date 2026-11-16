import { resolve } from 'path';

export const AGENT_HARNESS_DB_FILENAME = 'agent-harness.db';

export function resolveAgentHarnessDbPath(dataDir: string): string {
  return resolve(dataDir, AGENT_HARNESS_DB_FILENAME);
}
