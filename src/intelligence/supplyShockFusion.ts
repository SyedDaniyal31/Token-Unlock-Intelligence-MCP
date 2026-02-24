/**
 * Supply Shock Fusion Index (SSI): single institutional risk index from
 * unlock and supply metrics. Run after unlock hierarchy resolution.
 */

export type SupplyShockRiskTier = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export interface SupplyShockFusionInput {
  unlock_pressure_ratio: number;
  liquidity_stress_score: number;
  supply_volatility_index: number;
  inflation_rate_30d: number;
  confidence_score: number;
}

export interface SupplyShockFusionOutput {
  supply_shock_index: number;
  supply_shock_risk_tier: SupplyShockRiskTier;
  /** True when high unlock pressure and high liquidity stress triggered cascade boost. */
  cascade_risk_detected?: boolean;
}

function fin(x: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Normalize a value to 0–1. For ratios and percentages that may exceed 1, cap at 1.
 */
function normalize01(value: number, max?: number): number {
  const v = fin(value);
  const cap = max != null && Number.isFinite(max) ? max : 1;
  return clamp(v / cap, 0, 1);
}

/**
 * Compute Supply Shock Fusion Index (SSI) from normalized inputs.
 * Weights: unlock 0.35, liquidity 0.25, volatility 0.20, inflation 0.20.
 * Adjusted by confidence; scaled to 0–100.
 */
export function computeSupplyShockFusion(input: SupplyShockFusionInput): SupplyShockFusionOutput {
  const unlockNorm = normalize01(input.unlock_pressure_ratio, 2);
  const liquidityNorm = normalize01(input.liquidity_stress_score, 100);
  const volatilityNorm = normalize01(input.supply_volatility_index, 100);
  const inflationNorm = normalize01(input.inflation_rate_30d, 100);

  let ssiRaw =
    unlockNorm * 0.35 +
    liquidityNorm * 0.25 +
    volatilityNorm * 0.2 +
    inflationNorm * 0.2;

  const CASCADE_UNLOCK_THRESHOLD = 0.6;
  const CASCADE_LIQUIDITY_THRESHOLD = 0.6;
  const CASCADE_MULTIPLIER = 1.15;

  let cascadeBoostApplied = false;
  if (
    unlockNorm > CASCADE_UNLOCK_THRESHOLD &&
    liquidityNorm > CASCADE_LIQUIDITY_THRESHOLD
  ) {
    ssiRaw *= CASCADE_MULTIPLIER;
    cascadeBoostApplied = true;
  }
  ssiRaw = Math.min(ssiRaw, 1);

  const confidenceNorm = clamp(normalize01(input.confidence_score, 100), 0, 1);
  const ssiAdjusted = ssiRaw * confidenceNorm;
  const supply_shock_index = Math.round(clamp(ssiAdjusted * 100, 0, 100));

  let supply_shock_risk_tier: SupplyShockRiskTier;
  if (supply_shock_index <= 25) supply_shock_risk_tier = "LOW";
  else if (supply_shock_index <= 50) supply_shock_risk_tier = "MODERATE";
  else if (supply_shock_index <= 75) supply_shock_risk_tier = "HIGH";
  else supply_shock_risk_tier = "EXTREME";

  return {
    supply_shock_index,
    supply_shock_risk_tier,
    cascade_risk_detected: cascadeBoostApplied,
  };
}
