import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { ServiceEvent, ServiceEventType } from '@open-employee/contracts/contracts/service';
import type { ExecutionDatabase } from '../db/database';

interface EventRow {
  id: string;
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
  createdAt: number;
}

function mapEvent(row: EventRow): ServiceEvent {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    type: row.type as ServiceEventType,
    payload: JSON.parse(row.payloadJson) as unknown,
    createdAt: row.createdAt
  };
}

export class EventStore {
  constructor(private readonly database: ExecutionDatabase) {}

  public appendInTransaction(
    connection: Database.Database,
    runId: string,
    type: ServiceEventType,
    payload: Record<string, unknown> = {},
    createdAt = Date.now()
  ): ServiceEvent {
    const row = connection
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?')
      .get(runId) as { seq: number };

    const seq = row.seq + 1;
    const id = randomUUID();
    const payloadJson = JSON.stringify(payload);

    connection
      .prepare(
        `INSERT INTO events (id, run_id, seq, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, runId, seq, type, payloadJson, createdAt);

    return {
      id,
      runId,
      seq,
      type,
      payload,
      createdAt
    };
  }

  public listAfter(runId: string, afterSeq = 0): ServiceEvent[] {
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new Error('Event cursor must be a non-negative integer.');
    }

    const rows = this.database.read(
      (connection) =>
        connection
          .prepare(
            `SELECT id, run_id AS runId, seq, type, payload_json AS payloadJson,
                    created_at AS createdAt
             FROM events
             WHERE run_id = ? AND seq > ?
             ORDER BY seq ASC`
          )
          .all(runId, afterSeq) as EventRow[]
    );

    return rows.map(mapEvent);
  }

  public latestSequence(runId: string): number {
    const row = this.database.read(
      (connection) =>
        connection
          .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?')
          .get(runId) as { seq: number }
    );

    return row.seq;
  }
}
