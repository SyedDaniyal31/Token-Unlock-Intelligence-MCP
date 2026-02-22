/**
 * Emission pattern detection: linear, exponential decay, fixed cap, inflationary, deflationary.
 * Computes annual inflation rate, 30d supply growth, supply velocity.
 */

export type EmissionPattern =
  | "linear"
  | "exponential_decay"
  | "fixed_cap"
  | "inflationary"
  | "deflationary"
  | "unknown";

export interface EmissionAnalysis {
  pattern: EmissionPattern;
  annual_inflation_rate_pct: number;
  supply_growth_30d_pct: number;
  supply_velocity: number;
  /** Total supply change over observed period. */
  supply_change_pct: number;
}

export interface EmissionInput {
  /** Unlock amounts over time (e.g. last 12 months). */
  unlockAmounts: number[];
  /** Circulating supply at end of period. */
  circulatingSupply: number;
  /** Total supply at end (if known). */
  totalSupply?: number;
  /** Days covered by unlockAmounts (e.g. 365). */
  periodDays: number;
}

function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
}

export function analyzeEmissionPattern(input: EmissionInput): EmissionAnalysis {
  const { unlockAmounts, circulatingSupply, periodDays } = input;
  const totalSupply = input.totalSupply ?? circulatingSupply;
  const safeCirculating = Math.max(1, circulatingSupply);
  const totalUnlocked = unlockAmounts.reduce((s, a) => s + a, 0);
  const supplyChangePct = safeCirculating > 0 ? (totalUnlocked / safeCirculating) * 100 : 0;
  const supplyGrowth30dPct = periodDays >= 30 ? (supplyChangePct / periodDays) * 30 : supplyChangePct;
  const annualInflationPct = periodDays > 0 ? (supplyChangePct / periodDays) * 365 : 0;
  const supplyVelocity = periodDays > 0 ? totalUnlocked / periodDays : 0;

  let pattern: EmissionPattern = "unknown";
  if (unlockAmounts.length >= 3) {
    const v = variance(unlockAmounts);
    const mean = totalUnlocked / unlockAmounts.length;
    const cv = mean > 0 ? Math.sqrt(v) / mean : 0;
    if (totalUnlocked <= 0 && circulatingSupply >= totalSupply) pattern = "fixed_cap";
    else if (annualInflationPct < -0.5) pattern = "deflationary";
    else if (annualInflationPct > 0.5 && cv < 0.4) pattern = "linear";
    else if (annualInflationPct > 0.5 && cv >= 0.4) pattern = "exponential_decay";
  }
  if (pattern === "unknown" && annualInflationPct > 0) pattern = "inflationary";
  if (pattern === "unknown" && annualInflationPct < 0) pattern = "deflationary";

  return {
    pattern,
    annual_inflation_rate_pct: Number(annualInflationPct.toFixed(2)),
    supply_growth_30d_pct: Number(supplyGrowth30dPct.toFixed(2)),
    supply_velocity: Number(supplyVelocity.toFixed(0)),
    supply_change_pct: Number(supplyChangePct.toFixed(2)),
  };
}
