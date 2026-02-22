/**
 * Historical unlock analysis: events in last 12 months, avg size, % supply per event, post-unlock volatility placeholder.
 */

export interface HistoricalUnlockAnalysis {
  unlock_events_last_12m: number;
  avg_unlock_size: number;
  supply_increase_pct_per_event: number;
  /** Placeholder when no price API; 0. */
  price_reaction_avg_pct: number;
  /** Placeholder when no price API; 0. */
  post_unlock_volatility: number;
}

export interface HistoricalUnlockInput {
  eventAmounts: number[];
  circulatingSupply: number;
}

export function analyzeHistoricalUnlocks(input: HistoricalUnlockInput): HistoricalUnlockAnalysis {
  const { eventAmounts, circulatingSupply } = input;
  const safeCirculating = Math.max(1, circulatingSupply);
  const count = eventAmounts.length;
  const total = eventAmounts.reduce((s, a) => s + a, 0);
  const avgUnlockSize = count > 0 ? total / count : 0;
  const supplyIncreasePctPerEvent = count > 0 && safeCirculating > 0
    ? (avgUnlockSize / safeCirculating) * 100
    : 0;

  return {
    unlock_events_last_12m: count,
    avg_unlock_size: Number(avgUnlockSize.toFixed(0)),
    supply_increase_pct_per_event: Number(supplyIncreasePctPerEvent.toFixed(2)),
    price_reaction_avg_pct: 0,
    post_unlock_volatility: 0,
  };
}
