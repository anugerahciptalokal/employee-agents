import type { ServiceEvent } from '@open-employee/contracts/contracts/service';

export function mergeEventStreams(
  afterSeq: number,
  ...streams: ServiceEvent[][]
): ServiceEvent[] {
  const bySequence = new Map<number, ServiceEvent>();

  for (const stream of streams) {
    for (const event of stream) {
      if (event.seq <= afterSeq) continue;
      if (!bySequence.has(event.seq)) {
        bySequence.set(event.seq, event);
      }
    }
  }

  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}
