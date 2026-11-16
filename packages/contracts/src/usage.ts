export type UsageRange = 'today' | '7d' | '30d' | 'all';

const DAY_MS = 24 * 60 * 60 * 1000;

export function usageRangeToSince(range: string | null | undefined, now = Date.now()): number | null {
  switch (range) {
    case 'today': {
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      return startOfDay.getTime();
    }
    case '7d':
      return now - 7 * DAY_MS;
    case '30d':
      return now - 30 * DAY_MS;
    case 'all':
      return null;
    default:
      return now - 30 * DAY_MS;
  }
}
