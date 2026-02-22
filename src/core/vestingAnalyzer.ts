/**
 * Vesting cliff detection: large unlocks (>3% circulating), clustered events, next cliff date, severity 0-100.
 */

export interface VestingCliffAnalysis {
  /** Count of large unlock events (>3% of circulating). */
  large_unlock_count: number;
  /** Whether unlocks are clustered in time. */
  clustered_unlocks: boolean;
  /** Has at least one cliff-style unlock. */
  has_cliff: boolean;
  /** Next significant cliff date (ISO string or empty). */
  next_cliff_date: string;
  /** Cliff severity score 0-100. */
  cliff_severity_score: number;
  /** Max single unlock as % of circulating supply. */
  max_unlock_pct_supply: number;
  /** Avg unlock size in tokens. */
  avg_unlock_size: number;
}

const LARGE_UNLOCK_PCT_THRESHOLD = 3;
const CLUSTER_WINDOW_DAYS = 14;
const CLUSTER_MIN_EVENTS = 3;

export interface UnlockEventInput {
  amount: number;
  timestamp: Date | null;
}

export function detectVestingCliffs(
  events: UnlockEventInput[],
  circulatingSupply: number,
  nextUnlockDate: string,
  nextUnlockAmount: number
): VestingCliffAnalysis {
  const safeCirculating = Math.max(1, circulatingSupply);
  const amounts = events.map((e) => e.amount).filter((a) => a > 0);
  const pcts = amounts.map((a) => (a / safeCirculating) * 100);
  const largeUnlockCount = pcts.filter((p) => p >= LARGE_UNLOCK_PCT_THRESHOLD).length;
  const maxUnlockPctSupply = pcts.length > 0 ? Math.max(...pcts) : 0;
  const avgUnlockSize = amounts.length > 0 ? amounts.reduce((s, a) => s + a, 0) / amounts.length : 0;

  const hasCliff = largeUnlockCount > 0 || (nextUnlockAmount / safeCirculating) * 100 >= LARGE_UNLOCK_PCT_THRESHOLD;

  const withTs = events.filter((e) => e.timestamp != null) as Array<{ amount: number; timestamp: Date }>;
  let clustered = false;
  if (withTs.length >= CLUSTER_MIN_EVENTS) {
    const sorted = [...withTs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const windowMs = CLUSTER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (let i = 0; i <= sorted.length - CLUSTER_MIN_EVENTS; i++) {
      const start = sorted[i].timestamp.getTime();
      const end = sorted[i + CLUSTER_MIN_EVENTS - 1].timestamp.getTime();
      if (end - start <= windowMs) {
        clustered = true;
        break;
      }
    }
  }

  const nextCliffDate = nextUnlockDate ?? "";
  const nextUnlockPct = safeCirculating > 0 ? (nextUnlockAmount / safeCirculating) * 100 : 0;
  const severityFromHistory = Math.min(100, maxUnlockPctSupply * 10 + largeUnlockCount * 5);
  const severityFromNext = Math.min(100, nextUnlockPct * 8);
  const cliffSeverityScore = Math.round(Math.min(100, Math.max(0, (severityFromHistory * 0.5 + severityFromNext * 0.5) + (clustered ? 15 : 0))));

  return {
    large_unlock_count: largeUnlockCount,
    clustered_unlocks: clustered,
    has_cliff: hasCliff,
    next_cliff_date: nextCliffDate,
    cliff_severity_score: cliffSeverityScore,
    max_unlock_pct_supply: Number(maxUnlockPctSupply.toFixed(2)),
    avg_unlock_size: Number(avgUnlockSize.toFixed(0)),
  };
}
