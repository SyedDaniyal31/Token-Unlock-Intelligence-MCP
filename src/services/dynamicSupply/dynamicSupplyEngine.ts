/**
 * Dynamic token supply risk engine: works for any ERC-20/BEP-20 without static registry.
 * Includes quantitative analytics: uncertainty, volume fusion, concentration, depth, emission momentum, optional shock simulation.
 *
 * Unlock Pressure Separation Model
 *
 * unlock_pressure_ratio:
 *   - Represents scheduled unlock pressure from calendar/provider data ONLY.
 *
 * inferred_distribution_pressure:
 *   - Represents modeled distribution risk when no scheduled unlock data exists.
 *
 * These two signals must never be merged.
 */

import logger from "../../core/logger.js";
import { acquireDynamicEngineSlot } from "../../core/engineConcurrencyGuard.js";
import { runHolderDistributionAnalysis } from "../../core/holderDistributionAnalyzer.js";
import { getSupplyFromCache, getSupplyFromCacheWithTimestamp, setSupplyInCache } from "./supplyCache.js";
import { getMemoizedResult, setMemoizedResult } from "./intelligenceMemo.js";
import { resolveAsset, type AssetMetadata } from "../../core/assetResolver.js";
import { resolveUnlockData } from "../../unlock/unlockProviderEngine.js";
import { getRpcUrl, getCurrentBlock, getBlockTimestamp, readErc20SupplyFromRpc } from "../unlockScanner/chainClient.js";
import { getMarketEnrichment, type MarketEnrichment } from "../marketData/marketEnrichment.js";
import { inferSupplyShockUnlock, shouldApplySupplyShockInference } from "../../intelligence/supplyShockInference.js";
import { computeSupplyShockFusion } from "../../intelligence/supplyShockFusion.js";
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Dynamic engine aborted");
}

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
  analysis_scope: "dynamic" | "registry" | "hybrid" | "dynamic_fallback" | "unlock_only" | "combined" | "supply_only" | "insufficient";
  /** Unlock provider name (e.g. CryptoRank, ManualRegistry). */
  unlock_provider?: string;
  /** Unlock provider confidence 0–1. */
  unlock_provider_confidence?: number;
  analysis_provenance: {
    primary_model: "registry" | "dynamic_unlock" | "holder_distribution";
    fallback_used: boolean;
    unlock_data_available: boolean;
    confidence_basis: "unlock_events" | "holder_distribution" | "mixed";
  };
  /** Optional enrichment from CoinGecko + DeFiLlama. */
  market_cap_usd?: number;
  volume_24h_usd?: number;
  liquidity_usd?: number;
  unlock_amount_usd?: number;
  unlock_market_cap_impact?: number;
  /** Set when unlock intelligence is inferred (no scanner/registry data). */
  unlock_model?: string;
  inference_source?: string;
  confidence_score?: number;
  /** Unlock intelligence source: registry > external_calendar > scanner > inferred. */
  unlock_data_source?: "registry" | "external_calendar" | "scanner" | "inferred";
  /** Supply Shock Fusion Index (0–100) and risk tier. */
  supply_shock_index?: number;
  supply_shock_risk_tier?: string;
  /** True when high unlock + high liquidity stress triggered SSI cascade boost. */
  cascade_risk_detected?: boolean;
  /** Inferred supply/distribution pressure when no scheduled unlock data; only set when unlock_data_available is false. */
  inferred_distribution_pressure?: number;
  /** Risk classification of inferred distribution pressure (e.g. MODERATE); only set when unlock_data_available is false. */
  inferred_distribution_classification?: string;
  /** Set when engine returns early (e.g. INVALID_SUPPLY) for structured no-data. */
  no_results_reason?: string;
}

function toNum(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const TIER_ORDER = { LOW: 0, MODERATE: 1, HIGH: 2, EXTREME: 3 } as const;
type Tier = keyof typeof TIER_ORDER;
function combineRiskTiers(a: Tier, b: Tier): Tier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

const LIQUIDITY_FREE_FLOAT_THRESHOLD_USD = 10_000_000;
const TOKEN_AGE_FREE_FLOAT_DAYS = 180;
const HOLDER_CONCENTRATION_FREE_FLOAT_PCT = 40;

/**
 * Fast pre-check: skip expensive unlock scanning when token looks like a free-float asset (no vesting/unlock structure).
 * Returns true when we SHOULD run the scanner; false when all free-float conditions hold and we can skip.
 */
async function shouldRunUnlockScanner(
  tokenAddress: string,
  chain: "ethereum" | "arbitrum" | "bsc",
  totalSupply: number,
  supplyStable: boolean,
  marketData?: MarketEnrichment | null,
  tokenAgeDays?: number,
  topHolderConcentrationPct?: number
): Promise<boolean> {
  const inflationRate30d = 0; // no prior unlock data before scanning
  const noVestingFound = true; // we have not run scanner yet
  const liquidityUsd = marketData != null && Number.isFinite(marketData.liquidityUsd) ? marketData.liquidityUsd : 0;
  const liquidityOk = liquidityUsd > LIQUIDITY_FREE_FLOAT_THRESHOLD_USD;
  const tokenAgeOk = tokenAgeDays == null || tokenAgeDays > TOKEN_AGE_FREE_FLOAT_DAYS;
  const concentrationOk = topHolderConcentrationPct == null || topHolderConcentrationPct < HOLDER_CONCENTRATION_FREE_FLOAT_PCT;

  const allFreeFloat =
    inflationRate30d === 0 &&
    supplyStable &&
    liquidityOk &&
    tokenAgeOk &&
    noVestingFound &&
    concentrationOk;

  return !allFreeFloat;
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
  /** When provided, used as single source of truth; resolveAsset is skipped. */
  asset?: AssetMetadata;
}

export interface RunDynamicSupplyEngineOptions {
  signal?: AbortSignal;
}

/**
 * Run dynamic supply engine with optional abort signal for cancellation. Returns normalized metrics; never undefined/NaN.
 */
export async function runDynamicSupplyEngine(
  input: DynamicSupplyInput,
  options?: RunDynamicSupplyEngineOptions
): Promise<DynamicSupplyOutput> {
  const t0 = Date.now();
  const signal = options?.signal;
  throwIfAborted(signal);

  const releaseSlot = await acquireDynamicEngineSlot(signal);
  try {
  const executionNowMs = typeof input.executionNowMs === "number" && Number.isFinite(input.executionNowMs)
    ? input.executionNowMs
    : Date.now();
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const chainKey = input.chain;
  const addr = input.token_address.startsWith("0x")
    ? input.token_address
    : "0x" + input.token_address;

  const asset: AssetMetadata = input.asset ?? await resolveAsset({
    symbol: input.symbol ?? "",
    token_address: addr,
    chain: input.chain,
  });
  if (!asset.supported) {
    logger.info({ symbol: asset.symbol, chain_type: asset.chain_type }, "ASSET_UNSUPPORTED");
    const out = defaultOutput(1, toNum(input.volume30dUsd), undefined, 0, 0, Math.floor(executionNowMs / 1000));
    out.no_results_reason = "UNSUPPORTED_ASSET";
    return out;
  }

  let totalSupply = toNum(input.totalSupply);
  let decimals = 18;
  let supplySnapshotTs = Math.floor(executionNowMs / 1000);
  let blockNumberUsed = 0;
  let blockTimestampUsed = 0;

  let supplyFromCache = false;
  try {
    if (getRpcUrl(chainKey) == null) {
      throw new Error("RPC_FAILURE");
    }

    const cachedEntry = getSupplyFromCacheWithTimestamp(addr, chainKey);
    if (cachedEntry && cachedEntry.data.totalSupply >= 0) {
      supplyFromCache = true;
      totalSupply = totalSupply || cachedEntry.data.totalSupply;
      decimals = cachedEntry.data.decimals;
      supplySnapshotTs = cachedEntry.timestamp;
      logger.info({ ms: 0, cached: true }, "STAGE_RPC_SUPPLY_DONE");
    } else {
      const tRpcSupplyStart = Date.now();
      const snapshot = await readErc20SupplyFromRpc(chainKey, addr);
      logger.info({ ms: Date.now() - tRpcSupplyStart }, "STAGE_RPC_SUPPLY_DONE");
      throwIfAborted(signal);
      totalSupply = totalSupply || snapshot.totalSupply;
      decimals = snapshot.decimals;
      setSupplyInCache(addr, chainKey, snapshot);
    }

    if (Date.now() < deadline) {
      const tBlockStart = Date.now();
      blockNumberUsed = await getCurrentBlock(chainKey);
      logger.info({ ms: Date.now() - tBlockStart }, "STAGE_GET_CURRENT_BLOCK_DONE");
      throwIfAborted(signal);
      if (blockNumberUsed > 0) {
        const tBlockTsStart = Date.now();
        blockTimestampUsed = await getBlockTimestamp(chainKey, blockNumberUsed);
        logger.info({ ms: Date.now() - tBlockTsStart }, "STAGE_GET_BLOCK_TIMESTAMP_DONE");
      }
      throwIfAborted(signal);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "RPC_FAILURE") throw err;
    if (msg === "Dynamic engine aborted") throw err;
    logger.info({ ms: Date.now() - t0 }, "STAGE_ENGINE_TOTAL");
    return defaultOutput(totalSupply, toNum(input.volume30dUsd), supplySnapshotTs, 0, 0, Math.floor(executionNowMs / 1000));
  }

  throwIfAborted(signal);
  if (Date.now() >= deadline) {
    logger.info({ ms: Date.now() - t0 }, "STAGE_ENGINE_TOTAL");
    return defaultOutput(totalSupply, toNum(input.volume30dUsd), supplySnapshotTs, blockNumberUsed, blockTimestampUsed, Math.floor(executionNowMs / 1000));
  }

  if (totalSupply <= 0) {
    logger.info({ ms: Date.now() - t0 }, "STAGE_ENGINE_TOTAL");
    const out = defaultOutput(1, toNum(input.volume30dUsd), supplySnapshotTs, blockNumberUsed, blockTimestampUsed, Math.floor(executionNowMs / 1000));
    out.no_results_reason = "INVALID_SUPPLY";
    return out;
  }

  const memoKey = `${chainKey}:${addr.toLowerCase()}`;
  if (blockNumberUsed > 0) {
    const memoHit = getMemoizedResult(memoKey, blockNumberUsed);
    if (memoHit != null) {
      logger.warn(
        { token: input.symbol },
        "INTELLIGENCE_MEMO_HIT"
      );
      return memoHit;
    }
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

  throwIfAborted(signal);
  let enrichment: Awaited<ReturnType<typeof getMarketEnrichment>> = null;
  if (Date.now() < deadline) {
    try {
      const tEnrichStart = Date.now();
      enrichment = await getMarketEnrichment(
        input.symbol ?? "",
        chainKey,
        addr ?? null,
        executionNowMs
      );
      logger.info({ ms: Date.now() - tEnrichStart }, "STAGE_MARKET_ENRICHMENT_DONE");
    } catch {
      enrichment = null;
    }
  }
  throwIfAborted(signal);

  // Provider engine: DefiLlama → ManualRegistry (single unlock source for dynamic EVM path).
  const tUnlockStart = Date.now();
  const unlockData = await resolveUnlockData(asset);
  if (!unlockData.success) {
    logger.info({ symbol: asset.symbol }, "UNLOCK_PROVIDER_NO_DATA");
  }
  logger.info({ ms: Date.now() - tUnlockStart, source: unlockData.source }, "STAGE_UNIFIED_UNLOCK_INTEL_DONE");
  throwIfAborted(signal);

  let unlockIntelSource: "registry" | "external_calendar" | "scanner" | "inferred" = "inferred";
  let unlockIntelEvents: { unlock_timestamp: number; amount: string }[] = [];
  let nextUnlockTs: number | null = null;
  let providerUsed: string = "none";

  if (unlockData.success && unlockData.events.length > 0) {
    providerUsed = unlockData.source ?? "external_calendar";
    unlockIntelSource =
      unlockData.source === "ManualRegistry"
        ? "registry"
        : "external_calendar";
    unlockIntelEvents = unlockData.events.map((e) => ({
      unlock_timestamp: e.unlock_timestamp,
      amount: String(e.unlock_amount),
    }));
    nextUnlockTs = unlockData.next_unlock_timestamp ?? null;
  }

  if (unlockIntelEvents.length > 0) {
    const priceForUnlockCalc =
      enrichment != null && Number.isFinite(enrichment.priceUsd) && enrichment.priceUsd > 0
        ? enrichment.priceUsd
        : toNum(input.price);
    const totalUnlockTokens = unlockIntelEvents.reduce(
      (sum, e) => sum + (Number.isFinite(Number(e.amount)) ? Number(e.amount) : 0),
      0
    );
    if (volume30d > 0 && priceForUnlockCalc > 0 && totalUnlockTokens > 0) {
      const pressureFromEvents = (totalUnlockTokens * priceForUnlockCalc) / volume30d;
      if (Number.isFinite(pressureFromEvents)) {
        unlockPressureRatio = pressureFromEvents;
      }
    }
  }
  if (Number.isFinite(unlockPressureRatio) === false) unlockPressureRatio = 0;
  const pressureRatioClean = Math.max(0, unlockPressureRatio);
  const unlock_data_available =
    unlockIntelSource !== "inferred" &&
    (unlockIntelEvents.length > 0 || nextUnlockTs !== null);

  const hasUnlockData = unlock_data_available;
  const hasOnchainData = totalSupply > 0;

  const emissionTrend = 0;
  const cliffPct = 0;
  const liquidityScore = computeLiquidityStressScore(pressureRatioClean, inflation30d, cliffPct);
  let liquidityStressRounded = Math.round(clamp(liquidityScore, 0, 100));
  throwIfAborted(signal);

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
  if (!unlock_data_available) {
    supplyVolatilityIndex = computeSupplyVolatilityIndex([inflation30d, inflation90d]);
  }
  const unlockPressureClassification = getUnlockPressureClassification(pressureRatioClean);

  const unlockRiskScore: Tier | null = hasUnlockData ? (unlockPressureClassification as Tier) : null;
  const supplyRiskScore: Tier | null = hasOnchainData ? (getRiskTier(liquidityStressRounded) as Tier) : null;

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

  if (!unlock_data_available) {
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
    analysis_provenance: {
      primary_model: "dynamic_unlock",
      fallback_used: false,
      unlock_data_available: true,
      confidence_basis: "unlock_events",
    },
  };

  // Layered risk and analysis scope (no short-circuit; liquidity/supply always computed when onchain data exists).
  if (unlockRiskScore != null && supplyRiskScore != null) {
    out.risk_tier = combineRiskTiers(unlockRiskScore, supplyRiskScore);
    out.analysis_scope = "combined";
  } else if (unlockRiskScore != null) {
    out.risk_tier = unlockRiskScore;
    out.analysis_scope = "unlock_only";
  } else if (supplyRiskScore != null) {
    out.risk_tier = supplyRiskScore;
    out.analysis_scope = "supply_only";
  } else {
    out.risk_tier = "INSUFFICIENT_DATA";
    out.analysis_scope = "insufficient";
  }
  out.unlock_data_source = unlockIntelSource;
  out.next_estimated_unlock_timestamp = nextUnlockTs;
  out.unlock_provider = providerUsed;
  out.unlock_provider_confidence =
    providerUsed === "none" ? 0 : (typeof unlockData.confidence_score === "number" ? unlockData.confidence_score : 0);
  out.analysis_provenance.unlock_data_available = unlock_data_available;

  if (shouldApplySupplyShockInference(unlock_data_available)) {
    const inferred = inferSupplyShockUnlock({
      inflation_rate_30d: out.inflation_rate_30d,
      supply_volatility_index: out.supply_volatility_index,
      liquidity_stress_score: out.liquidity_stress_score,
      emission_trend: out.emission_trend,
      holder_data_confidence_score: out.holder_data_confidence_score,
      liquidity_data_available:
        enrichment != null && Number.isFinite(enrichment.liquidityUsd) && enrichment.liquidityUsd > 0,
      market_enrichment_available: enrichment != null,
      block_freshness_hint: blockNumberUsed > 0 ? 1 : 0,
    });
    // Scheduled unlock fields: ONLY represent calendar/provider data. Never assign inferred values to them.
    out.unlock_pressure_ratio = 0;
    out.unlock_pressure_classification = "NO_SCHEDULED_DATA";
    out.inferred_distribution_pressure = Number(Number(inferred.synthetic_unlock_pressure).toFixed(4));
    out.inferred_distribution_classification = inferred.unlock_pressure_classification;
    out.unlock_model = inferred.unlock_model;
    out.inference_source = inferred.inference_source;
    out.confidence_score = inferred.confidence_score;
    out.analysis_scope = "dynamic_fallback";
    out.unlock_data_source = "inferred";
    out.unlock_provider = "none";
    out.unlock_provider_confidence = 0;
    out.analysis_provenance = {
      primary_model: "dynamic_unlock",
      fallback_used: true,
      unlock_data_available: false,
      confidence_basis: "mixed",
    };
  }

  if (enrichment != null) {
    out.market_cap_usd = Number.isFinite(enrichment.marketCapUsd) ? Math.max(0, enrichment.marketCapUsd) : undefined;
    out.volume_24h_usd = Number.isFinite(enrichment.volume24hUsd) ? Math.max(0, enrichment.volume24hUsd) : undefined;
    out.liquidity_usd = Number.isFinite(enrichment.liquidityUsd) ? Math.max(0, enrichment.liquidityUsd) : undefined;
    out.unlock_amount_usd = Number.isFinite(unlockAmountUsd) ? Math.max(0, unlockAmountUsd) : undefined;
    out.unlock_market_cap_impact = Number.isFinite(unlockMarketCapImpact) ? Math.max(0, unlockMarketCapImpact) : undefined;
  }

  const noUnlockEvents = !unlock_data_available;
  const shouldUseHolderFallback =
    noUnlockEvents || unlockPatternType === "unknown" || dataQualityScore < 10;

  if (shouldUseHolderFallback) {
    const holderDeadline = Math.min(deadline, Date.now() + 2000);
    try {
      throwIfAborted(signal);
      const holderResult = await runHolderDistributionAnalysis(
        {
          chain: chainKey,
          tokenAddress: addr,
          totalSupply: totalSupply,
          enrichment:
            enrichment != null
              ? {
                  marketCapUsd: enrichment.marketCapUsd,
                  liquidityUsd: enrichment.liquidityUsd,
                  circulatingSupply: enrichment.circulatingSupply,
                }
              : undefined,
        },
        { signal, deadline: holderDeadline }
      );
      out.top_holder_concentration_score = holderResult.top_holder_concentration_score;
      out.treasury_exposure_score = holderResult.treasury_exposure_score;
      out.combined_volatility_index = Math.min(100, Math.max(0, holderResult.combined_volatility_index));
      out.risk_flags = [...out.risk_flags, "HOLDER_CONCENTRATION_MODE"];
      out.analysis_scope = "dynamic_fallback";
      out.analysis_provenance = {
        primary_model: "holder_distribution",
        fallback_used: true,
        unlock_data_available: false,
        confidence_basis: "holder_distribution",
      };
    } catch {
      /* keep existing out; do not overwrite with NO_DATA */
    }
  }

  if (out.analysis_provenance == null) {
    out.analysis_provenance = {
      primary_model: "dynamic_unlock",
      fallback_used: false,
      unlock_data_available: true,
      confidence_basis: "unlock_events",
    };
  }

  // IMPORTANT: SSI must only reflect scheduled unlock pressure.
  // Inferred distribution pressure is informational and must not inflate SSI.
  const ssi = computeSupplyShockFusion({
    unlock_pressure_ratio: out.unlock_pressure_ratio,
    liquidity_stress_score: out.liquidity_stress_score,
    supply_volatility_index: out.supply_volatility_index,
    inflation_rate_30d: out.inflation_rate_30d,
    confidence_score: out.confidence_score ?? 100,
    unlock_provider_confidence: providerUsed === "none" ? 0 : (typeof unlockData.confidence_score === "number" ? unlockData.confidence_score : 0),
  });
  out.supply_shock_index = ssi.supply_shock_index;
  out.supply_shock_risk_tier = ssi.supply_shock_risk_tier;
  if (ssi.cascade_risk_detected !== undefined) out.cascade_risk_detected = ssi.cascade_risk_detected;

  // When scheduled unlock exists, inferred fields must not appear (mutual exclusivity).
  if (out.analysis_provenance.unlock_data_available && out.inferred_distribution_pressure != null) {
    delete out.inferred_distribution_pressure;
    delete out.inferred_distribution_classification;
  }

  logger.info({ ms: Date.now() - t0 }, "STAGE_ENGINE_TOTAL");
  setMemoizedResult(memoKey, blockNumberUsed, out);
  return out;
  } finally {
    releaseSlot();
  }
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
    risk_tier: "INSUFFICIENT_UNLOCK_DATA",
    data_quality_score: 0,
    analysis_provenance: {
      primary_model: "dynamic_unlock",
      fallback_used: false,
      unlock_data_available: false,
      confidence_basis: "holder_distribution",
    },
    supply_shock_index: 0,
    supply_shock_risk_tier: "LOW",
  };
}
