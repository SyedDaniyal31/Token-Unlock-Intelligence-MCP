/**
 * Research-grade quantitative analytics for token supply risk.
 * Prediction uncertainty, volume fusion, concentration, liquidity depth, emission momentum, shock simulation.
 * Model metadata, data freshness, risk flags, risk tier. All outputs finite; scores 0–100.
 */

function fin(x: number): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// Model metadata & data freshness
// ---------------------------------------------------------------------------

export interface ModelMetadata {
  model_version: string;
  analytics_layer: string;
  build_timestamp: number;
}

export interface DataFreshness {
  supply_snapshot_timestamp: number;
  volume_snapshot_timestamp: number;
  last_rpc_block_number: number;
  block_number_used: number;
  block_timestamp_used: number;
}

const MODEL_VERSION = "2.0.0";
const ANALYTICS_LAYER = "quantitative";
const BUILD_TIMESTAMP = typeof process !== "undefined" && process.env?.BUILD_TIMESTAMP
  ? Math.floor(Number(process.env.BUILD_TIMESTAMP)) || 0
  : 0;

export function buildModelMetadata(): ModelMetadata {
  return {
    model_version: MODEL_VERSION,
    analytics_layer: ANALYTICS_LAYER,
    build_timestamp: Number.isFinite(BUILD_TIMESTAMP) ? BUILD_TIMESTAMP : 0,
  };
}

export function buildDataFreshness(params: {
  supply_snapshot_timestamp?: number;
  volume_snapshot_timestamp?: number;
  last_rpc_block_number?: number;
  block_number_used?: number;
  block_timestamp_used?: number;
  /** Frozen execution time (seconds) for deterministic outputs; omit to use current time. */
  nowSec?: number;
}): DataFreshness {
  const now = typeof params.nowSec === "number" && Number.isFinite(params.nowSec)
    ? Math.floor(params.nowSec)
    : Math.floor(Date.now() / 1000);
  return {
    supply_snapshot_timestamp: Math.max(0, fin(params.supply_snapshot_timestamp ?? now)),
    volume_snapshot_timestamp: Math.max(0, fin(params.volume_snapshot_timestamp ?? now)),
    last_rpc_block_number: Math.max(0, Math.floor(fin(params.last_rpc_block_number ?? 0))),
    block_number_used: Math.max(0, Math.floor(fin(params.block_number_used ?? 0))),
    block_timestamp_used: Math.max(0, Math.floor(fin(params.block_timestamp_used ?? 0))),
  };
}

// ---------------------------------------------------------------------------
// Data quality score (0–100)
// ---------------------------------------------------------------------------

/**
 * Data quality score from volume sources, unlock history depth, supply completeness.
 * Separate from model_confidence_score.
 */
export function computeDataQualityScore(params: {
  volumeSourceCount: number;
  unlockHistoryDepth: number;
  supplyHistoryCompleteness: number;
}): number {
  const v = Math.max(0, Math.min(10, fin(params.volumeSourceCount)));
  const u = Math.max(0, fin(params.unlockHistoryDepth));
  const s = Math.max(0, Math.min(1, fin(params.supplyHistoryCompleteness)));
  const volumeScore = v >= 2 ? 40 : v >= 1 ? 25 : 10;
  const unlockScore = u >= 12 ? 35 : u >= 6 ? 25 : u >= 1 ? 15 : 5;
  const supplyScore = s >= 1 ? 25 : s >= 0.5 ? 15 : 5;
  return Math.round(clamp(volumeScore + unlockScore + supplyScore, 0, 100));
}

// ---------------------------------------------------------------------------
// Risk flags & risk tier
// ---------------------------------------------------------------------------

export function buildRiskFlags(metrics: {
  liquidity_stress_score: number;
  unlock_pressure_ratio: number;
  cliff_detected: boolean;
  inflation_rate_30d: number;
  top_holder_concentration_score: number;
  emission_acceleration_score: number;
}): string[] {
  const flags: string[] = [];
  if (fin(metrics.liquidity_stress_score) >= 50) flags.push("HIGH_LIQUIDITY_STRESS");
  if (fin(metrics.unlock_pressure_ratio) >= 0.5) flags.push("ELEVATED_UNLOCK_PRESSURE");
  if (metrics.cliff_detected) flags.push("CLIFF_DETECTED");
  if (fin(metrics.inflation_rate_30d) > 1) flags.push("POSITIVE_INFLATION_30D");
  if (fin(metrics.top_holder_concentration_score) >= 50) flags.push("HIGH_CONCENTRATION");
  if (fin(metrics.emission_acceleration_score) >= 60) flags.push("ACCELERATING_EMISSION");
  if (fin(metrics.liquidity_stress_score) < 25 && fin(metrics.unlock_pressure_ratio) < 0.1) flags.push("LOW_RISK_PROFILE");
  return flags;
}

export type RiskTier = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export function getRiskTier(liquidity_stress_score: number): RiskTier {
  const s = clamp(fin(liquidity_stress_score), 0, 100);
  if (s <= 25) return "LOW";
  if (s <= 50) return "MODERATE";
  if (s <= 75) return "HIGH";
  return "EXTREME";
}

/** Unlock pressure classification from ratio (projected_new_supply_30d / fused_volume_30d). */
export type UnlockPressureClassification = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export function getUnlockPressureClassification(ratio: number): UnlockPressureClassification {
  const r = Math.max(0, fin(ratio));
  if (r < 0.1) return "LOW";
  if (r <= 0.5) return "MODERATE";
  if (r <= 1) return "HIGH";
  return "EXTREME";
}

/** Unlock pattern from time-series of amounts (no ABI). */
export type UnlockPatternType = "linear" | "burst" | "unknown";

export function computeUnlockPatternType(
  amounts: number[],
  timestamps?: (Date | number | null)[]
): UnlockPatternType {
  if (amounts.length < 2) return "unknown";
  const v = amounts.map(fin).filter((a) => a > 0);
  if (v.length < 2) return "unknown";
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
  if (cv < 0.4) return "linear";
  const max = Math.max(...v);
  if (max > mean * 2.5) return "burst";
  return "unknown";
}

/** Concentration risk bundle: all 0–100. */
export function computeConcentrationRisk(options: {
  topHolderPcts?: number[];
  treasuryPct?: number;
  maxSingleUnlockPct?: number;
}): { top_holder_concentration_score: number; treasury_exposure_score: number; max_single_unlock_risk: number } {
  const top = computeConcentrationScore(options);
  const treasury = options.treasuryPct != null
    ? Math.round(clamp(fin(options.treasuryPct) * 1.5, 0, 100))
    : top;
  const maxUnlock = options.maxSingleUnlockPct != null
    ? Math.round(clamp(fin(options.maxSingleUnlockPct) * 3, 0, 100))
    : top;
  return {
    top_holder_concentration_score: Math.round(clamp(top, 0, 100)),
    treasury_exposure_score: Math.round(clamp(treasury, 0, 100)),
    max_single_unlock_risk: Math.round(clamp(maxUnlock, 0, 100)),
  };
}

/** Supply volatility index from inflation rates only. Normalized 0–100. Backward compatible. */
export function computeSupplyVolatilityIndex(inflationRates: number[]): number {
  if (inflationRates.length < 2) return 0;
  const r = inflationRates.map(fin);
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / r.length;
  const std = Math.sqrt(variance);
  const normalized = Math.min(100, std * 10);
  return Math.round(clamp(normalized, 0, 100));
}

// ---------------------------------------------------------------------------
// Rolling 90d inflation (replaces synthetic inflation_90d = inflation_30d * 3)
// ---------------------------------------------------------------------------

const WEIGHTS_3_WINDOWS = [0.2, 0.3, 0.5];
const WEIGHTS_2_WINDOWS = [0.4, 0.6];

export interface RollingInflation90dResult {
  inflation_90d: number;
  historical_depth_limited: boolean;
}

/**
 * Compute 90d inflation from independent 30d windows. Weights favor recent (0.2, 0.3, 0.5).
 * If &lt; 60 days of data, returns fallback and historical_depth_limited = true.
 */
export function computeRollingInflation90d(params: {
  windowInflationRates: number[];
  fallbackScaled90d?: number;
}): RollingInflation90dResult {
  const rates = params.windowInflationRates.map(fin).filter((r) => Number.isFinite(r));
  const fallback = fin(params.fallbackScaled90d ?? 0);

  if (rates.length >= 3) {
    const w = WEIGHTS_3_WINDOWS;
    const weighted = rates[0]! * w[0]! + rates[1]! * w[1]! + rates[2]! * w[2]!;
    return {
      inflation_90d: Number(Number(weighted).toFixed(4)),
      historical_depth_limited: false,
    };
  }
  if (rates.length === 2) {
    const w = WEIGHTS_2_WINDOWS;
    const weighted = rates[0]! * w[0]! + rates[1]! * w[1]!;
    return {
      inflation_90d: Number(Number(weighted).toFixed(4)),
      historical_depth_limited: true,
    };
  }
  return {
    inflation_90d: Number(Number(fallback).toFixed(4)),
    historical_depth_limited: true,
  };
}

// ---------------------------------------------------------------------------
// Holder data confidence (transparency metadata; does not change concentration scores)
// ---------------------------------------------------------------------------

export type HolderDataSource = "real" | "treasury_inference" | "heuristic";

/**
 * Holder data confidence 0–100: real breakdown 90–100, treasury inference 50–70, purely heuristic 20–40.
 */
export function computeHolderDataConfidenceScore(source: HolderDataSource): number {
  switch (source) {
    case "real":
      return clamp(95, 90, 100);
    case "treasury_inference":
      return clamp(60, 50, 70);
    case "heuristic":
    default:
      return clamp(30, 20, 40);
  }
}

// ---------------------------------------------------------------------------
// Combined volatility index (inflation + volume + depth)
// ---------------------------------------------------------------------------

function stdNormalized0_100(values: number[]): number {
  if (values.length < 2) return 0;
  const v = values.map(fin);
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  const std = Math.sqrt(variance);
  return Math.round(clamp(Math.min(100, std * 10), 0, 100));
}

const VOLATILITY_WEIGHT_INFLATION = 0.5;
const VOLATILITY_WEIGHT_VOLUME = 0.3;
const VOLATILITY_WEIGHT_DEPTH = 0.2;

/**
 * Combined volatility with dynamic weight normalization.
 * Only available components are included; weights are normalized so they sum to 1.
 * Avoids understatement when volume or depth is missing. Deterministic.
 */
export function computeCombinedVolatilityIndex(params: {
  inflationRates: number[];
  volumeValues?: number[];
  depthMetrics?: number[];
}): number {
  const inflationVol = computeSupplyVolatilityIndex(params.inflationRates);
  const hasInflation = params.inflationRates.length >= 1 && Number.isFinite(inflationVol);
  let volumeVol = 0;
  const hasVolume = (params.volumeValues?.length ?? 0) >= 2;
  if (hasVolume && params.volumeValues) {
    volumeVol = stdNormalized0_100(params.volumeValues);
  }
  let depthVol = 0;
  const hasDepth = (params.depthMetrics?.length ?? 0) >= 2;
  if (hasDepth && params.depthMetrics) {
    depthVol = stdNormalized0_100(params.depthMetrics);
  }

  const components: { value: number; weight: number }[] = [];
  if (hasInflation) components.push({ value: inflationVol, weight: VOLATILITY_WEIGHT_INFLATION });
  if (hasVolume) components.push({ value: volumeVol, weight: VOLATILITY_WEIGHT_VOLUME });
  if (hasDepth) components.push({ value: depthVol, weight: VOLATILITY_WEIGHT_DEPTH });

  if (components.length === 0) return 0;
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0) return 0;
  const combined = components.reduce(
    (s, c) => s + c.value * (c.weight / totalWeight),
    0
  );
  return Math.round(clamp(Number.isFinite(combined) ? combined : 0, 0, 100));
}

// ---------------------------------------------------------------------------
// Pattern confidence score (unlock pattern detection reliability)
// ---------------------------------------------------------------------------

/**
 * Pattern confidence 0–100: ≥5 windows high (80–100), 3–4 medium (50–80), &lt;3 low (20–50).
 * Reduced if coefficient of variation &gt; 1.5 (very noisy).
 */
export function computePatternConfidenceScore(
  nDataPoints: number,
  coefficientOfVariation?: number
): number {
  const n = Math.max(0, Math.floor(fin(nDataPoints)));
  const cv = fin(coefficientOfVariation ?? 0);
  let base = 35;
  if (n >= 5) base = 90;
  else if (n >= 3) base = 65;
  else if (n >= 1) base = 35;
  const reduction = cv > 1.5 ? 20 : 0;
  return Math.round(clamp(base - reduction, 0, 100));
}

// ---------------------------------------------------------------------------
// 1. Prediction uncertainty (statistical smoothing + variance)
// ---------------------------------------------------------------------------

/** Flat MCP-compatible forward risk curve with uncertainty. */
export interface ForwardRiskCurveExtended {
  risk_30d: number;
  risk_90d: number;
  risk_180d: number;
  confidence_interval_low: number;
  confidence_interval_high: number;
  model_confidence_score: number;
}

/**
 * Build forward risk curve with confidence interval and model confidence.
 * Incorporates unlock variance and volume variance into normalized confidence (0–100).
 */
export function buildForwardRiskWithUncertainty(
  risk30d: number,
  risk90d: number,
  risk180d: number,
  options?: {
    volatilityHint?: number;
    dataQuality?: number;
    unlockVariance?: number;
    volumeVariance?: number;
  }
): ForwardRiskCurveExtended {
  const r30 = clamp(fin(risk30d), 0, 100);
  const r90 = clamp(fin(risk90d), 0, 100);
  const r180 = clamp(fin(risk180d), 0, 100);
  const vol = Math.max(0, Math.min(1, fin(options?.volatilityHint ?? 0.2)));
  const quality = Math.max(0, Math.min(1, fin(options?.dataQuality ?? 0.7)));
  const unlockVar = Math.max(0, Math.min(1, fin(options?.unlockVariance ?? 0.5)));
  const volumeVar = Math.max(0, Math.min(1, fin(options?.volumeVariance ?? 0.5)));

  const spread = 5 + vol * 15;
  const low = clamp(Math.min(r30, r90, r180) - spread, 0, 100);
  const high = clamp(Math.max(r30, r90, r180) + spread, 0, 100);

  const variancePenalty = (unlockVar + volumeVar) / 2;
  const qualityAdjusted = quality * (1 - variancePenalty * 0.5);
  const modelConfidence = Math.round(clamp(qualityAdjusted * 100, 0, 100));

  return {
    risk_30d: Math.round(r30),
    risk_90d: Math.round(r90),
    risk_180d: Math.round(r180),
    confidence_interval_low: Math.round(clamp(low, 0, 100)),
    confidence_interval_high: Math.round(clamp(high, 0, 100)),
    model_confidence_score: modelConfidence,
  };
}

// ---------------------------------------------------------------------------
// 2. Multi-source volume intelligence
// ---------------------------------------------------------------------------

export interface VolumeFusionResult {
  fused_volume_30d_usd: number;
  volume_source_consistency_score: number;
}

/**
 * Weighted fusion of multiple volume estimates. Consistency from coefficient of variation.
 */
export function computeVolumeFusion(
  volumes: number[],
  weights?: number[]
): VolumeFusionResult {
  const clean = volumes.map((v) => Math.max(0, fin(v))).filter((v) => v > 0);
  if (clean.length === 0) {
    return { fused_volume_30d_usd: 0, volume_source_consistency_score: 0 };
  }
  const w = weights && weights.length === clean.length
    ? weights.map((x) => Math.max(0, fin(x)))
    : clean.map(() => 1);
  const sumW = w.reduce((s, x) => s + x, 0) || 1;
  const fused = clean.reduce((s, v, i) => s + v * (w[i] ?? 1), 0) / sumW;
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((s, x) => s + (x - mean) ** 2, 0) / clean.length;
  const std = Math.sqrt(variance);
  const cv = mean > 0 ? std / mean : 0;
  const consistency = cv <= 0 ? 100 : clamp(100 - Math.min(100, cv * 100), 0, 100);
  return {
    fused_volume_30d_usd: fin(fused),
    volume_source_consistency_score: Math.round(consistency),
  };
}

// ---------------------------------------------------------------------------
// 3. Supply concentration risk (heuristic / probabilistic treasury)
// ---------------------------------------------------------------------------

/**
 * Top holder concentration score 0–100. Without exact wallets, use treasury/team % or unlock concentration.
 */
export function computeConcentrationScore(options: {
  topHolderPcts?: number[];
  treasuryPct?: number;
  maxSingleUnlockPct?: number;
}): number {
  const { topHolderPcts, treasuryPct, maxSingleUnlockPct } = options;
  if (topHolderPcts && topHolderPcts.length > 0) {
    const top1 = Math.max(0, fin(topHolderPcts[0]));
    return Math.round(clamp(top1 * 2, 0, 100));
  }
  const treasury = Math.max(0, fin(treasuryPct ?? 0));
  if (treasury > 0) return Math.round(clamp(treasury * 1.5, 0, 100));
  const unlock = Math.max(0, fin(maxSingleUnlockPct ?? 0));
  if (unlock > 0) return Math.round(clamp(unlock * 3, 0, 100));
  return 0;
}

// ---------------------------------------------------------------------------
// 4. Liquidity depth gradient (price impact for 1%, 3%, 5% sell)
// ---------------------------------------------------------------------------

export interface LiquidityDepthProfile {
  impact_1pct: number;
  impact_3pct: number;
  impact_5pct: number;
}

/**
 * Estimate price impact (%) for 1%, 3%, 5% of supply sold. Power-law style: impact ∝ (size/volume)^exponent.
 */
export function computeLiquidityDepthProfile(params: {
  volume30dUsd: number;
  circulatingSupply: number;
  price: number;
  unlockPressureRatio?: number;
}): LiquidityDepthProfile {
  const vol = Math.max(0, fin(params.volume30dUsd));
  const circ = Math.max(1, fin(params.circulatingSupply));
  const price = Math.max(0, fin(params.price));
  const pressure = Math.max(0, fin(params.unlockPressureRatio ?? 0));
  const exponent = 0.5 + pressure * 0.3;
  const volumeTokens = price > 0 && vol > 0 ? vol / price : circ;
  const dailyVolumeTokens = Math.max(1, volumeTokens / 30);

  function impactForPct(sellPct: number): number {
    const sellRatio = (sellPct / 100) * circ / dailyVolumeTokens;
    const raw = 100 * Math.pow(Math.min(sellRatio, 10), exponent) * 0.15;
    return fin(Number(raw.toFixed(2)));
  }

  return {
    impact_1pct: impactForPct(1),
    impact_3pct: impactForPct(3),
    impact_5pct: impactForPct(5),
  };
}

// ---------------------------------------------------------------------------
// 5. Emission momentum (temporal derivative of supply release)
// ---------------------------------------------------------------------------

/**
 * Emission acceleration score 0–100 from supply release derivative (increase in velocity = acceleration).
 */
export function computeEmissionAcceleration(unlockAmountsByPeriod: number[]): number {
  if (unlockAmountsByPeriod.length < 2) return 0;
  const v = unlockAmountsByPeriod.map(fin);
  const velocities: number[] = [];
  for (let i = 1; i < v.length; i++) {
    velocities.push(v[i]! - v[i - 1]!);
  }
  if (velocities.length < 2) return 0;
  const accels = velocities.slice(1).map((vel, i) => vel - (velocities[i] ?? 0));
  const meanAccel = accels.reduce((s, a) => s + a, 0) / accels.length;
  const maxAbs = Math.max(...accels.map(Math.abs), 1);
  const normalized = 50 + (meanAccel / maxAbs) * 50;
  return Math.round(clamp(normalized, 0, 100));
}

// ---------------------------------------------------------------------------
// 6. Market shock simulator (optional)
// ---------------------------------------------------------------------------

export interface ShockSimulationParams {
  price_shock_pct?: number;
  volume_shock_pct?: number;
  unlock_multiplier?: number;
}

export interface SimulationOutcome {
  price_shock_impact_score: number;
  volume_shock_impact_score: number;
  unlock_multiplier_impact_score: number;
}

/**
 * Run risk projection under shock scenarios. Returns impact scores 0–100.
 */
export function runShockSimulation(
  params: ShockSimulationParams,
  baseline: {
    liquidity_stress_score: number;
    unlock_pressure_ratio: number;
    inflation_rate_30d: number;
  }
): SimulationOutcome {
  const priceShock = fin(params.price_shock_pct ?? 0);
  const volShock = fin(params.volume_shock_pct ?? 0);
  const mult = Math.max(0.1, fin(params.unlock_multiplier ?? 1));

  const baseStress = clamp(baseline.liquidity_stress_score, 0, 100);
  const basePressure = Math.max(0, baseline.unlock_pressure_ratio);
  const baseInflation = baseline.inflation_rate_30d;

  const priceImpact = priceShock !== 0
    ? clamp(baseStress * (1 + priceShock / 100), 0, 100)
    : 0;
  const volumeImpact = volShock !== 0
    ? clamp(baseStress * (1 - volShock / 100), 0, 100)
    : baseStress;
  const unlockImpact = mult !== 1
    ? clamp(baseStress * Math.min(mult, 3), 0, 100)
    : baseStress;

  return {
    price_shock_impact_score: Math.round(clamp(priceImpact, 0, 100)),
    volume_shock_impact_score: Math.round(clamp(volumeImpact, 0, 100)),
    unlock_multiplier_impact_score: Math.round(clamp(unlockImpact, 0, 100)),
  };
}
