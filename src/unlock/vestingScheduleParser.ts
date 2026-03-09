/**
 * Vesting schedule parser: turns raw unlock events + supply into a structured output
 * with cliff, linear vesting, frequency, next unlock date/amount, and category.
 */

import type { NormalizedUnlockEvent } from "./providers/UnlockProvider.js";

export type UnlockCategory = "team" | "investor" | "ecosystem" | "foundation" | "unknown";

export interface VestingScheduleOutput {
  token: string;
  total_supply: number;
  circulating_supply: number;
  next_unlock_date: string | null;
  next_unlock_amount: number;
  unlock_percent_of_circulating: number;
  unlock_category: UnlockCategory;
  /** Cliff period in days if detectable; null otherwise. */
  cliff_period_days?: number | null;
  /** True when schedule appears linear (recurring similar amounts). */
  linear_vesting?: boolean;
  /** Approximate unlock frequency in days; null if single or irregular. */
  unlock_frequency_days?: number | null;
}

const NOW_SEC = () => Math.floor(Date.now() / 1000);

/**
 * Infer category from provider source or event metadata when available.
 */
function inferCategory(event: NormalizedUnlockEvent): UnlockCategory {
  const src = (event as NormalizedUnlockEvent & { allocation_name?: string; standard_allocation_name?: string })
    .allocation_name
    ?? (event as NormalizedUnlockEvent & { standardAllocationName?: string }).standardAllocationName
    ?? event.source;
  if (!src || typeof src !== "string") return "unknown";
  const s = src.toLowerCase();
  if (s.includes("team") || s.includes("founder")) return "team";
  if (s.includes("investor") || s.includes("private")) return "investor";
  if (s.includes("ecosystem") || s.includes("community")) return "ecosystem";
  if (s.includes("foundation")) return "foundation";
  return "unknown";
}

/**
 * Compute approximate unlock frequency (median days between consecutive future events).
 */
function computeUnlockFrequencyDays(events: NormalizedUnlockEvent[], nowSec: number): number | null {
  const future = events
    .filter((e) => e.unlock_timestamp > nowSec)
    .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
  if (future.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < future.length; i++) {
    gaps.push((future[i].unlock_timestamp - future[i - 1].unlock_timestamp) / 86400);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 === 0 ? (gaps[mid - 1]! + gaps[mid]!) / 2 : gaps[mid]!;
  return Math.round(median);
}

/**
 * Detect if schedule looks linear (similar amounts at regular intervals).
 */
function detectLinearVesting(events: NormalizedUnlockEvent[], nowSec: number): boolean {
  const future = events
    .filter((e) => e.unlock_timestamp > nowSec)
    .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
  if (future.length < 2) return false;
  const amounts = future.map((e) => e.unlock_amount);
  const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  const variance = amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
  const cv = mean === 0 ? 0 : Math.sqrt(variance) / mean;
  const freqDays = computeUnlockFrequencyDays(events, nowSec);
  return cv < 0.5 && freqDays != null && freqDays >= 1 && freqDays <= 365;
}

/**
 * Estimate cliff in days from first future unlock to "start" (e.g. TGE or min timestamp in events).
 */
function estimateCliffDays(events: NormalizedUnlockEvent[], nowSec: number): number | null {
  const sorted = [...events].sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
  const future = sorted.filter((e) => e.unlock_timestamp > nowSec);
  const past = sorted.filter((e) => e.unlock_timestamp <= nowSec);
  if (future.length === 0) return null;
  const firstFuture = future[0]!.unlock_timestamp;
  const reference = past.length > 0 ? past[past.length - 1]!.unlock_timestamp : nowSec;
  const days = (firstFuture - reference) / 86400;
  return days > 0 ? Math.round(days) : null;
}

/**
 * Parse unlock events and supply into a structured vesting schedule output.
 */
export function parseVestingFromEvents(
  events: NormalizedUnlockEvent[],
  totalSupply: number,
  circulatingSupply: number,
  tokenSymbol: string
): VestingScheduleOutput {
  const nowSec = NOW_SEC();
  const future = events
    .filter((e) => e.unlock_timestamp > nowSec)
    .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

  const nextEvent = future[0] ?? null;
  const next_unlock_date = nextEvent
    ? new Date(nextEvent.unlock_timestamp * 1000).toISOString().slice(0, 10)
    : null;
  const next_unlock_amount = nextEvent ? nextEvent.unlock_amount : 0;
  const circulating = circulatingSupply > 0 ? circulatingSupply : totalSupply || 1;
  const unlock_percent_of_circulating =
    next_unlock_amount > 0 && circulating > 0
      ? (next_unlock_amount / circulating) * 100
      : 0;
  const unlock_category = nextEvent ? inferCategory(nextEvent) : "unknown";

  const out: VestingScheduleOutput = {
    token: tokenSymbol,
    total_supply: totalSupply,
    circulating_supply: circulatingSupply,
    next_unlock_date,
    next_unlock_amount,
    unlock_percent_of_circulating,
    unlock_category,
  };

  if (events.length > 0) {
    out.cliff_period_days = estimateCliffDays(events, nowSec);
    out.linear_vesting = detectLinearVesting(events, nowSec);
    out.unlock_frequency_days = computeUnlockFrequencyDays(events, nowSec);
  }

  return out;
}
