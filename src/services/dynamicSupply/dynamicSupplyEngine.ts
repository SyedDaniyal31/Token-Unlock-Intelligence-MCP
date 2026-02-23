/**
 * Dynamic token supply risk engine: works for any ERC-20/BEP-20 without static registry.
 * Includes quantitative analytics: uncertainty, volume fusion, concentration, depth, emission momentum, optional shock simulation.
 */

import { getSupplyFromCache, getSupplyFromCacheWithTimestamp, setSupplyInCache } from "./supplyCache.js";
import { runUnlockScanner } from "../unlockScanner/unlockScanner.js";
import { getRpcUrl, getCurrentBlock, getBlockTimestamp, readErc20SupplyFromRpc } from "../unlockScanner/chainClient.js";
import { getMarketEnrichment } from "../marketData/marketEnrichment.js";
import {
  buildForwardRiskWithUncertainty,
  buildModelMetadata,
  buildDataFreshness,
  buildRiskFlags,
  getRiskTier,
  getUnlockPressureClassification,
  computeVolumeFusion,
  computeConcentrationRisk,
  computeLiquidityDepthProfile,
  computeEmissionAcceleration,
  computeSupplyVolatilityIndex,
  computeHolderDataConfidenceScore,
  computeCombinedVolatilityIndex,
  computePatternConfidenceScore,
  computeUnlockPatternType,
  computeDataQualityScore,
  runShockSimulation,
  type ForwardRiskCurveExtended,
  type LiquidityDepthProfile,
  type SimulationOutcome,
  type UnlockPatternType,
} from "../../core/quantitativeAnalytics.js";

const REQUEST_TIMEOUT_MS = 8000;

/**
 * Internal deterministic test harness: same input → same output.
 * Verification: call twice with identical input (same token, chain, executionNowMs, price, deadline)
 * and assert deep equality of liquidity_stress_score, risk_flags, risk_tier, unlock_amount_usd,
 * unlock_market_cap_impact, forward_risk_curve. Do not use Date.now() in test input.
 */
async function deterministicTestWrapper(input: DynamicSupplyInput): Promise<DynamicSupplyOutput> {
  return runDynamicSupplyEngine(input);
}

export interface DynamicSupplyOutput {
  model_metadata: ReturnType<typeof buildModelMetadata>;
  data_freshness: ReturnType<typeof buildDataFreshness>;
  inflation_rate_30d: number;
  inflation_rate_90d: number;
  supply_volatility_index: number;
  emission_trend: number;
  unlock_pressure_ratio: number;
  unlock_pressure_classification: string;
  fused_volume_30d_usd: number;
  liquidity_stress_score: number;
  cliff_detected: boolean;
  cliff_size_percent: number;
  next_estimated_unlock_timestamp: number | null;
  unlock_pattern_type: string;
  forward_risk_curve: ForwardRiskCurveExtended;
  volume_source_consistency_score: number;
  top_holder_concentration_score: number;
  treasury_exposure_score: number;
  max_single_unlock_risk: number;
  liquidity_depth_profile: LiquidityDepthProfile;
  emission_acceleration_score: number;
  simulation_outcome: SimulationOutcome | null;
  risk_flags: string[];
  risk_tier: string;
  data_quality_score: number;
  historical_depth_limited: boolean;
  holder_data_confidence_score: number;
  combined_volatility_index: number;
  pattern_confidence_score: number;
  analysis_scope: "dynamic" | "registry" | "hybrid";
  /** Optional enrichment from CoinGecko + DeFiLlama. */
  market_cap_usd?: number;
  volume_24h_usd?: number;
  liquidity_usd?: number;
  unlock_amount_usd?: number;
  unlock_market_cap_impact?: number;
}

function toNum(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface DynamicSupplyInput {
  token_address: string;
  chain: "ethereum" | "arbitrum" | "bsc";
  symbol?: string;
  volume30dUsd?: number;
  /** Multiple volume estimates for weighted fusion and consistency score. */
  volumeSources?: number[];
  totalSupply?: number;
  price?: number;
  circulatingSupply?: number;
  /** When set, run shock simulation and include simulation_outcome. */
  simulation_params?: { price_shock_pct?: number; volume_shock_pct?: number; unlock_multiplier?: number };
  /** Frozen execution time (ms) for deterministic timestamps and windowing; omit to use current time. */
  executionNowMs?: number;
}

/**
 * Run dynamic supply engine with 8s timeout. Returns normalized metrics; never undefined/NaN.
 */
export async function runDynamicSupplyEngine(
  input: DynamicSupplyInput
): Promise<DynamicSupplyOutput> {
  const executionNowMs = typeof input.executionNowMs === "number" && Number.isFinite(input.executionNowMs)
    ? input.executionNowMs
    : Date.now();
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const chainKey = input.chain;
  const addr = input.token_address.startsWith("0x")
    ? input.token_address
    : "0x" + input.token_address;

  let totalSupply = toNum(input.totalSupply);
  let decimals = 18;
  let supplySnapshotTs = Math.floor(executionNowMs / 1000);
  let blockNumberUsed = 0;
  let blockTimestampUsed = 0;

  try {
    if (getRpcUrl(chainKey) == null) {
      throw new Error("RPC_FAILURE");
    }

    const cachedEntry = getSupplyFromCacheWithTimestamp(addr, chainKey);
    if (cachedEntry && cachedEntry.data.totalSupply >= 0) {
      totalSupply = totalSupply || cachedEntry.data.totalSupply;
      decimals = cachedEntry.data.decimals;
      supplySnapshotTs = cachedEntry.timestamp;
    } else {
      const snapshot = await readErc20SupplyFromRpc(chainKey, addr);
      totalSupply = totalSupply || snapshot.totalSupply;
      decimals = snapshot.decimals;
      setSupplyInCache(addr, chainKey, snapshot);
    }

    if (Date.now() < deadline) {
      blockNumberUsed = await getCurrentBlock(chainKey);
      if (blockNumberUsed > 0) {
        blockTimestampUsed = await getBlockTimestamp(chainKey, blockNumberUsed);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "RPC_FAILURE") throw err;
    return defaultOutput(totalSupply, toNum(input.volume30dUsd), supplySnapshotTs, 0, 0, Math.floor(executionNowMs / 1000));
  }

  if (Date.now() >= deadline) {
    return defaultOutput(totalSupply, toNum(input.volume30dUsd), supplySnapshotTs, blockNumberUsed, blockTimestampUsed, Math.floor(executionNowMs / 1000));
  }

  const supplySafe = Math.max(1, totalSupply);
  const volume30d = Math.max(0, toNum(input.volume30dUsd));
  let unlockPressureRatio =
    volume30d > 0 && totalSupply > 0
      ? supplySafe / volume30d
      : 0;
  let inflation30d = 0;
  let inflation90d = 0;
  let cliffDetected = false;
  let unlockPatternType: UnlockPatternType = "unknown";
  let supplyVolatilityIndex = 0;
  let emissionAcceleration = 0;

  const unlockScannerResult = await runUnlockScanner({
    chain: input.chain,
    tokenAddress: addr,
    circulatingSupply: Math.max(1, toNum(input.circulatingSupply) || supplySafe),
    volume30dUsd: volume30d,
    price: toNum(input.price) > 0 ? toNum(input.price) : undefined,
    executionNowMs,
    deadlineMs: deadline,
  });
  if (unlockScannerResult && Date.now() < deadline) {
    inflation30d = Number(unlockScannerResult.inflationRate30d);
    inflation90d = Number(unlockScannerResult.inflationRate90d);
    unlockPressureRatio = Number(unlockScannerResult.unlockPressureRatio);
    cliffDetected = Boolean(unlockScannerResult.cliffDetected);
    const pt = unlockScannerResult.unlockPatternType;
    unlockPatternType = (pt === "linear" || pt === "burst" ? pt : "unknown") as UnlockPatternType;
    supplyVolatilityIndex = Number(unlockScannerResult.supplyVolatilityIndex);
    emissionAcceleration = Number(unlockScannerResult.emissionAccelerationScore);
  }
  if (Number.isFinite(unlockPressureRatio) === false) unlockPressureRatio = 0;
  const pressureRatioClean = Math.max(0, unlockPressureRatio);
  const emissionTrend = 0;
  const cliffPct = 0;
  const liquidityScore = computeLiquidityStressScore(pressureRatioClean, inflation30d, cliffPct);
  let liquidityStressRounded = Math.round(clamp(liquidityScore, 0, 100));
  const nextUnlockTs: number | null = null;

  let enrichment: Awaited<ReturnType<typeof getMarketEnrichment>> = null;
  if (Date.now() < deadline) {
    try {
      enrichment = await getMarketEnrichment(
        input.symbol ?? "",
        chainKey,
        addr ?? null,
        executionNowMs
      );
    } catch {
      enrichment = null;
    }
  }

  const priceForUnlock =
    enrichment != null && Number.isFinite(enrichment.priceUsd) && enrichment.priceUsd > 0
      ? enrichment.priceUsd
      : toNum(input.price);
  const supplyForUnlock = Math.max(0, totalSupply);
  const inflation90dPct = Number.isFinite(inflation90d) && inflation90d >= 0 ? inflation90d : 0;
  const unlockAmountTokens = supplyForUnlock * (inflation90dPct / 100);
  const unlockAmountUsd =
    Number.isFinite(unlockAmountTokens) && Number.isFinite(priceForUnlock) && priceForUnlock >= 0
      ? Math.max(0, unlockAmountTokens * priceForUnlock)
      : 0;
  const unlockMarketCapImpact =
    enrichment != null && enrichment.marketCapUsd > 0 && Number.isFinite(unlockAmountUsd)
      ? clamp(unlockAmountUsd / enrichment.marketCapUsd, 0, 1e6)
      : 0;

  const safeUnlockMarketCapImpact =
    Number.isFinite(unlockMarketCapImpact) && unlockMarketCapImpact > 0 ? unlockMarketCapImpact : 0;
  const safeUnlockPressure =
    Number.isFinite(pressureRatioClean) && pressureRatioClean > 0 ? pressureRatioClean : 0;
  const safeLiquidityUsd =
    enrichment != null && Number.isFinite(enrichment.liquidityUsd) && enrichment.liquidityUsd > 0
      ? enrichment.liquidityUsd
      : 0;
  const safeUnlockAmountUsd =
    Number.isFinite(unlockAmountUsd) && unlockAmountUsd > 0 ? unlockAmountUsd : 0;

  let unlockLiquidityImpact = 0;
  if (safeLiquidityUsd > 0 && safeUnlockAmountUsd > 0) {
    unlockLiquidityImpact = safeUnlockAmountUsd / safeLiquidityUsd;
  }
  if (!Number.isFinite(unlockLiquidityImpact) || unlockLiquidityImpact < 0) {
    unlockLiquidityImpact = 0;
  }

  const normalize = (value: number, scale: number): number => {
    if (!Number.isFinite(value) || value <= 0) return 0;
    const scaled = value * scale;
    return Math.max(0, Math.min(100, scaled));
  };

  const marketCapImpactScore = normalize(safeUnlockMarketCapImpact, 500);
  const pressureScore = normalize(safeUnlockPressure, 100);
  const liquidityImpactScore = normalize(unlockLiquidityImpact, 100);

  const components: { value: number; weight: number }[] = [];
  if (marketCapImpactScore > 0) {
    components.push({ value: marketCapImpactScore, weight: 0.4 });
  }
  if (pressureScore > 0) {
    components.push({ value: pressureScore, weight: 0.35 });
  }
  if (liquidityImpactScore > 0) {
    components.push({ value: liquidityImpactScore, weight: 0.25 });
  }

  let fusedLiquidityStress = 0;
  if (components.length > 0) {
    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    fusedLiquidityStress = components.reduce(
      (sum, c) => sum + c.value * (c.weight / totalWeight),
      0
    );
  }
  if (!Number.isFinite(fusedLiquidityStress) || fusedLiquidityStress < 0) {
    fusedLiquidityStress = 0;
  }
  fusedLiquidityStress = Math.max(0, Math.min(100, fusedLiquidityStress));

  const baseLiquidityScore = clamp(liquidityScore, 0, 100);
  let finalLiquidityStress = baseLiquidityScore;
  if (components.length > 0) {
    finalLiquidityStress =
      0.5 * baseLiquidityScore +
      0.5 * fusedLiquidityStress;
  }
  if (!Number.isFinite(finalLiquidityStress) || finalLiquidityStress < 0) {
    finalLiquidityStress = 0;
  }
  finalLiquidityStress = Math.max(0, Math.min(100, finalLiquidityStress));
  liquidityStressRounded = Math.round(finalLiquidityStress);

  const risk30d = clamp(liquidityScore, 0, 100);
  const risk90d = clamp(liquidityScore * 1.1, 0, 100);
  const risk180d = clamp(liquidityScore * 1.2, 0, 100);

  const volumeSources = input.volumeSources && input.volumeSources.length > 0
    ? input.volumeSources
    : volume30d > 0 ? [volume30d] : [];
  const { fused_volume_30d_usd, volume_source_consistency_score } = computeVolumeFusion(volumeSources);
  const volumeVariance = 1 - Math.min(100, Math.max(0, volume_source_consistency_score)) / 100;
  if (!Number.isFinite(inflation90d)) inflation90d = inflation30d * 3;
  if (unlockScannerResult == null) {
    supplyVolatilityIndex = computeSupplyVolatilityIndex([inflation30d, inflation90d]);
  }
  const unlockPressureClassification = getUnlockPressureClassification(pressureRatioClean);

  const forwardCurve = buildForwardRiskWithUncertainty(risk30d, risk90d, risk180d, {
    volatilityHint: pressureRatioClean > 0.5 ? 0.4 : 0.2,
    dataQuality: volume30d > 0 ? 0.75 : 0.5,
    unlockVariance: 0.5,
    volumeVariance,
  });

  const concentration = computeConcentrationRisk({
    treasuryPct: cliffPct,
    maxSingleUnlockPct: cliffPct,
  });

  const price = Math.max(0, toNum(input.price));
  const circ = Math.max(1, toNum(input.circulatingSupply) || supplySafe);
  const depthProfile = computeLiquidityDepthProfile({
    volume30dUsd: volume30d,
    circulatingSupply: circ,
    price: price || 1,
    unlockPressureRatio: pressureRatioClean,
  });

  if (unlockScannerResult == null) {
    emissionAcceleration = computeEmissionAcceleration([]);
  }

  let simulation_outcome: SimulationOutcome | null = null;
  if (input.simulation_params && Object.keys(input.simulation_params).length > 0) {
    simulation_outcome = runShockSimulation(input.simulation_params, {
      liquidity_stress_score: liquidityScore,
      unlock_pressure_ratio: pressureRatioClean,
      inflation_rate_30d: inflation30d,
    });
  }

  const volumeSnapshotTs = Math.floor(executionNowMs / 1000);
  const riskFlags = buildRiskFlags({
    liquidity_stress_score: liquidityStressRounded,
    unlock_pressure_ratio: pressureRatioClean,
    cliff_detected: cliffDetected,
    inflation_rate_30d: inflation30d,
    top_holder_concentration_score: concentration.top_holder_concentration_score,
    emission_acceleration_score: emissionAcceleration,
  });

  const volumeSourceCount = volumeSources.length;
  const dataQualityScore = Math.min(
    100,
    Math.max(0, computeDataQualityScore({
      volumeSourceCount,
      unlockHistoryDepth: 0,
      supplyHistoryCompleteness: totalSupply > 0 ? 1 : 0,
    }))
  );

  const inflationRates = [inflation30d, inflation90d];
  const combinedVolatilityIndex = computeCombinedVolatilityIndex({
    inflationRates,
    volumeValues: volumeSources.length >= 2 ? volumeSources : undefined,
    depthMetrics: [depthProfile.impact_1pct, depthProfile.impact_3pct, depthProfile.impact_5pct],
  });
  const holderDataConfidenceScore = computeHolderDataConfidenceScore("heuristic");
  const patternConfidenceScore = computePatternConfidenceScore(0);

  const out: DynamicSupplyOutput = {
    model_metadata: buildModelMetadata(),
    data_freshness: buildDataFreshness({
      supply_snapshot_timestamp: supplySnapshotTs,
      volume_snapshot_timestamp: volumeSnapshotTs,
      last_rpc_block_number: blockNumberUsed,
      block_number_used: blockNumberUsed,
      block_timestamp_used: blockTimestampUsed,
      nowSec: Math.floor(executionNowMs / 1000),
    }),
    inflation_rate_30d: Number(Number(inflation30d).toFixed(4)),
    inflation_rate_90d: Number(Number(inflation90d).toFixed(4)),
    supply_volatility_index: Math.min(100, Math.max(0, supplyVolatilityIndex)),
    emission_trend: Number(Number(emissionTrend).toFixed(4)),
    unlock_pressure_ratio: Number(Number(pressureRatioClean).toFixed(4)),
    unlock_pressure_classification: unlockPressureClassification,
    fused_volume_30d_usd: toNum(fused_volume_30d_usd),
    liquidity_stress_score: liquidityStressRounded,
    cliff_detected: cliffDetected,
    cliff_size_percent: toNum(cliffPct),
    next_estimated_unlock_timestamp: nextUnlockTs,
    unlock_pattern_type: unlockPatternType,
    forward_risk_curve: forwardCurve,
    volume_source_consistency_score: Math.min(100, Math.max(0, volume_source_consistency_score)),
    top_holder_concentration_score: concentration.top_holder_concentration_score,
    treasury_exposure_score: concentration.treasury_exposure_score,
    max_single_unlock_risk: concentration.max_single_unlock_risk,
    liquidity_depth_profile: {
      impact_1pct: toNum(depthProfile.impact_1pct),
      impact_3pct: toNum(depthProfile.impact_3pct),
      impact_5pct: toNum(depthProfile.impact_5pct),
    },
    emission_acceleration_score: Math.min(100, Math.max(0, emissionAcceleration)),
    simulation_outcome,
    risk_flags: riskFlags,
    risk_tier: getRiskTier(liquidityStressRounded),
    data_quality_score: dataQualityScore,
    historical_depth_limited: true,
    holder_data_confidence_score: Math.min(100, Math.max(0, holderDataConfidenceScore)),
    combined_volatility_index: Math.min(100, Math.max(0, combinedVolatilityIndex)),
    pattern_confidence_score: Math.min(100, Math.max(0, patternConfidenceScore)),
    analysis_scope: "dynamic",
  };

  if (enrichment != null) {
    out.market_cap_usd = Number.isFinite(enrichment.marketCapUsd) ? Math.max(0, enrichment.marketCapUsd) : undefined;
    out.volume_24h_usd = Number.isFinite(enrichment.volume24hUsd) ? Math.max(0, enrichment.volume24hUsd) : undefined;
    out.liquidity_usd = Number.isFinite(enrichment.liquidityUsd) ? Math.max(0, enrichment.liquidityUsd) : undefined;
    out.unlock_amount_usd = Number.isFinite(unlockAmountUsd) ? Math.max(0, unlockAmountUsd) : undefined;
    out.unlock_market_cap_impact = Number.isFinite(unlockMarketCapImpact) ? Math.max(0, unlockMarketCapImpact) : undefined;
  }

  return out;
}

function computeLiquidityStressScore(
  pressureRatio: number,
  inflationPct: number,
  cliffPct: number
): number {
  let s = 0;
  if (pressureRatio >= 1) s += 50;
  else if (pressureRatio >= 0.5) s += 35;
  else if (pressureRatio >= 0.1) s += 20;
  if (inflationPct > 5) s += 25;
  else if (inflationPct > 1) s += 15;
  if (cliffPct > 5) s += 25;
  else if (cliffPct > 1) s += 10;
  return clamp(s, 0, 100);
}

/** Exported for soft-failure flat construction (no-data / business-logic failure). */
export function defaultOutput(
  totalSupply: number,
  volume30dUsd: number,
  supplySnapshotTs?: number,
  blockNumberUsed = 0,
  blockTimestampUsed = 0,
  nowSec?: number
): DynamicSupplyOutput {
  const supplySafe = Math.max(1, totalSupply);
  const ratio = volume30dUsd > 0 ? supplySafe / volume30dUsd : 0;
  const forwardCurve = buildForwardRiskWithUncertainty(0, 0, 0, { dataQuality: 0 });
  const now = typeof nowSec === "number" && Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  const fused = volume30dUsd > 0 ? volume30dUsd : 0;
  return {
    model_metadata: buildModelMetadata(),
    data_freshness: buildDataFreshness({
      supply_snapshot_timestamp: supplySnapshotTs ?? now,
      volume_snapshot_timestamp: now,
      last_rpc_block_number: blockNumberUsed,
      block_number_used: blockNumberUsed,
      block_timestamp_used: blockTimestampUsed,
      nowSec: now,
    }),
    inflation_rate_30d: 0,
    inflation_rate_90d: 0,
    supply_volatility_index: 0,
    emission_trend: 0,
    unlock_pressure_ratio: Number(Number(ratio).toFixed(4)),
    unlock_pressure_classification: getUnlockPressureClassification(ratio),
    fused_volume_30d_usd: fused,
    liquidity_stress_score: 0,
    cliff_detected: false,
    cliff_size_percent: 0,
    next_estimated_unlock_timestamp: null,
    historical_depth_limited: true,
    holder_data_confidence_score: Math.min(100, Math.max(0, computeHolderDataConfidenceScore("heuristic"))),
    combined_volatility_index: 0,
    pattern_confidence_score: Math.min(100, Math.max(0, computePatternConfidenceScore(0))),
    analysis_scope: "dynamic",
    unlock_pattern_type: "unknown",
    forward_risk_curve: forwardCurve,
    volume_source_consistency_score: 0,
    top_holder_concentration_score: 0,
    treasury_exposure_score: 0,
    max_single_unlock_risk: 0,
    liquidity_depth_profile: { impact_1pct: 0, impact_3pct: 0, impact_5pct: 0 },
    emission_acceleration_score: 0,
    simulation_outcome: null,
    risk_flags: ["NO_DATA"],
    risk_tier: "LOW",
    data_quality_score: 0,
  };
}
