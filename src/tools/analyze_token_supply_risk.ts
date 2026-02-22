/**
 * Multi-chain token supply risk engine: registry-based or dynamic (any ERC-20/BEP-20).
 */

import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getScheduleByTokenCaseInsensitive, getUnlockEventsInRange } from "../ingestion/unlockRegistry.js";
import { resolveTokenBySymbol, createUnlockTokenRegistry } from "../utils/tokenResolver.js";
import { getMarketData } from "../market/MarketAggregator.js";
import { computeSellableSupply } from "../intelligence/sellableSupply.js";
import { buildSupplyMetrics } from "../core/supplyAnalyzer.js";
import { analyzeHistoricalUnlocks } from "../core/historicalUnlocks.js";
import { detectVestingCliffs } from "../core/vestingAnalyzer.js";
import { analyzeEmissionPattern } from "../core/emissionModel.js";
import { computeLiquidityStress } from "../core/liquidityAnalyzer.js";
import { computeSupplyRiskScore } from "../core/riskEngine.js";
import { runDynamicSupplyEngine, defaultOutput } from "../services/dynamicSupply/index.js";
import {
  buildForwardRiskWithUncertainty,
  computeVolumeFusion,
  computeConcentrationRisk,
  computeLiquidityDepthProfile,
  computeEmissionAcceleration,
  computeSupplyVolatilityIndex,
  computeRollingInflation90d,
  computeHolderDataConfidenceScore,
  computeCombinedVolatilityIndex,
  computePatternConfidenceScore,
  getUnlockPressureClassification,
  computeUnlockPatternType,
  runShockSimulation,
} from "../core/quantitativeAnalytics.js";
import type {
  SimulationOutcome,
  ForwardRiskCurveExtended,
  LiquidityDepthProfile,
  ModelMetadata,
  DataFreshness,
} from "../core/quantitativeAnalytics.js";
import {
  buildModelMetadata,
  buildDataFreshness,
  buildRiskFlags,
  getRiskTier,
  computeDataQualityScore,
} from "../core/quantitativeAnalytics.js";
import { computeResultIntegrityHash } from "../core/resultIntegrity.js";
import {
  canonicalCacheKey,
  getCachedResult,
  setCachedResult,
  type SupplyRiskCacheParams,
} from "../services/dynamicSupply/supplyRiskResultCache.js";

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEFRAME_DAYS = 30;
const DYNAMIC_ENGINE_TIMEOUT_MS = 8000;

export interface SupplyRiskInput {
  token_symbol: string;
  token_address?: string;
  chain?: "ethereum" | "arbitrum" | "bsc";
  timeframe_days?: number;
  /** When provided, run market shock simulation and include simulation_outcome. */
  simulation_params?: {
    price_shock_pct?: number;
    volume_shock_pct?: number;
    unlock_multiplier?: number;
  };
}

/** Re-export for MCP schema documentation. */
export type ForwardRiskCurveFlat = ForwardRiskCurveExtended;
export type LiquidityDepthProfileFlat = LiquidityDepthProfile;

export interface SupplyRiskOutputFlat {
  model_metadata: ModelMetadata;
  data_freshness: DataFreshness;
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
  result_integrity_hash: string;
  engine_latency_ms: number;
  data_quality_score: number;
  historical_depth_limited: boolean;
  holder_data_confidence_score: number;
  combined_volatility_index: number;
  pattern_confidence_score: number;
  analysis_scope: "dynamic" | "registry" | "hybrid";
}

export interface SupplyRiskOutput {
  success: true;
  data: SupplyRiskOutputFlat;
}

export interface SupplyRiskError {
  success: false;
  error: string;
  /** Elapsed ms when failure occurred (e.g. timeout); 0 if not applicable. */
  engine_latency_ms?: number;
}

export type SupplyRiskResult = SupplyRiskOutput | SupplyRiskError;

/**
 * Build a valid SupplyRiskOutputFlat for business-logic failures (unsupported token, timeout, no data).
 * Context Marketplace treats JSON-RPC errors as crashes; this returns jsonrpcSuccess with a flat object instead.
 */
export function buildSoftFailureSupplyRisk(
  noResultsReason: string,
  engine_latency_ms: number
): SupplyRiskOutputFlat {
  const nowSec = Math.floor(Date.now() / 1000);
  const base = defaultOutput(1, 0, undefined, 0, 0, nowSec);
  const full: SupplyRiskOutputFlat = {
    ...base,
    engine_latency_ms: Math.max(0, Number.isFinite(engine_latency_ms) ? engine_latency_ms : 0),
    result_integrity_hash: "",
    historical_depth_limited: true,
    risk_flags: ["NO_DATA"],
    risk_tier: "LOW",
    data_quality_score: 0,
    holder_data_confidence_score: 0,
    combined_volatility_index: 0,
    pattern_confidence_score: 0,
    analysis_scope: "dynamic",
  };
  full.result_integrity_hash = computeResultIntegrityHash(full as unknown as Record<string, unknown>) || "";
  const ext = full as unknown as Record<string, unknown>;
  ext.no_results_reason = noResultsReason;
  ext.has_data = false;
  return full;
}

function num(x: unknown): number {
  if (typeof x === "number" && !Number.isNaN(x)) return x;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function str(x: unknown): string {
  if (typeof x === "string") return x;
  return x != null ? String(x) : "";
}

export async function runAnalyzeTokenSupplyRisk(
  input: SupplyRiskInput,
  deps: UnlockIntelligenceDeps
): Promise<SupplyRiskResult> {
  let symbol = str(input.token_symbol).trim().toUpperCase();
  const tokenAddress = str(input.token_address).trim();
  const chainSlug = input.chain === "ethereum" || input.chain === "arbitrum" || input.chain === "bsc" ? input.chain : undefined;

  const cacheParams: SupplyRiskCacheParams = {
    token_symbol: (symbol || input.token_symbol?.trim()) ?? "",
    token_address: tokenAddress || undefined,
    chain: chainSlug,
    timeframe_days: typeof input.timeframe_days === "number" ? input.timeframe_days : undefined,
    simulation_params: input.simulation_params,
  };
  const cacheKey = canonicalCacheKey(cacheParams);
  const cached = getCachedResult<SupplyRiskOutputFlat>(cacheKey);
  if (cached) return { success: true, data: cached };

  const executionNowMs = Date.now();

  if (tokenAddress && chainSlug) {
    const engineStart = Date.now();
    try {
      let volume30dUsd = 0;
      const volumeSources: number[] = [];
      if (symbol) {
        const market = await getMarketData(symbol, undefined, undefined);
        volume30dUsd = market.volume24h * 0.85;
        if (market.volume24h > 0) volumeSources.push(volume30dUsd);
      }
      const result = await Promise.race([
        runDynamicSupplyEngine({
          token_address: tokenAddress,
          chain: chainSlug,
          symbol: symbol || undefined,
          volume30dUsd,
          volumeSources: volumeSources.length > 0 ? volumeSources : undefined,
          simulation_params: input.simulation_params,
          executionNowMs,
        }),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Dynamic engine timed out")), DYNAMIC_ENGINE_TIMEOUT_MS)
        ),
      ]);
      const engine_latency_ms = Math.max(0, Date.now() - engineStart);
      const full: SupplyRiskOutputFlat = {
        ...result,
        engine_latency_ms,
        result_integrity_hash: "",
      };
      full.result_integrity_hash = computeResultIntegrityHash(full as unknown as Record<string, unknown>) || "";
      setCachedResult(cacheKey, full);
      return { success: true, data: full };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const engine_latency_ms = Math.max(0, Date.now() - engineStart);
      return { success: false, error: msg, engine_latency_ms };
    }
  }

  if (!symbol) return { success: false, error: "Token symbol or token_address is required.", engine_latency_ms: 0 };

  const registry = createUnlockTokenRegistry();
  const resolved = await resolveTokenBySymbol(str(input.token_symbol), registry);
  if (!resolved) {
    return {
      success: false,
      error: "Token not supported on ethereum, bsc, or arbitrum",
      engine_latency_ms: 0,
    };
  }

  const canonicalSymbol = resolved.symbol;
  const dbChainId = resolved.chain;
  const schedule = await getScheduleByTokenCaseInsensitive(canonicalSymbol, dbChainId);
  if (!schedule) {
    return { success: false, error: "Token not supported on ethereum, bsc, or arbitrum", engine_latency_ms: 0 };
  }

  symbol = canonicalSymbol;
  const timeframeDays = Math.max(1, Math.min(365, num(input.timeframe_days) || DEFAULT_TIMEFRAME_DAYS));

  const market = await getMarketData(symbol, schedule.coingecko_id ?? undefined, schedule.paprika_id ?? undefined);
  const circulatingSupply = Math.max(0, num(market.circulatingSupply));
  const price = Math.max(0, num(market.price));
  const volume24h = Math.max(0, num(market.volume24h));
  const volume30dApprox = volume24h * 0.85;

  const supplyResult = await computeSellableSupply(symbol, volume30dApprox, dbChainId);
  const upcomingUnlockAmount = num(supplyResult.real_sellable_supply) || num(supplyResult.claimed_amount);

  const since12m = new Date(executionNowMs - TWELVE_MONTHS_MS);
  let eventRows: { amount: string; timestamp: Date | null }[];
  try {
    eventRows = await getUnlockEventsInRange(symbol, since12m, new Date(executionNowMs), dbChainId);
  } catch {
    eventRows = [];
  }
  const eventAmounts = eventRows.map((r) => parseFloat(r.amount) || 0);
  const historical = analyzeHistoricalUnlocks({ eventAmounts, circulatingSupply });

  const nextUnlockDate = schedule.vesting_end ? new Date(schedule.vesting_end).toISOString() : "";
  const vesting = detectVestingCliffs(
    eventRows.map((r) => ({ amount: parseFloat(r.amount) || 0, timestamp: r.timestamp })),
    circulatingSupply,
    nextUnlockDate,
    upcomingUnlockAmount
  );

  const emission = analyzeEmissionPattern({
    unlockAmounts: eventAmounts,
    circulatingSupply,
    periodDays: 365,
  });

  const liquidity = computeLiquidityStress({
    unlockAmount: upcomingUnlockAmount,
    price,
    circulatingSupply,
    volume24h,
    volume30dAvg: volume30dApprox,
  });

  const historicalScore = Math.min(100, historical.unlock_events_last_12m * 5 + historical.supply_increase_pct_per_event * 2);
  const unlockScore = Math.min(100, liquidity.unlock_to_supply_pct * 10 + (liquidity.unlock_to_volume_ratio > 0.25 ? 30 : 0));
  const riskAssessment = computeSupplyRiskScore({
    historicalScore,
    unlockScore,
    cliffScore: vesting.cliff_severity_score,
    emissionScore: Math.min(100, Math.max(0, emission.annual_inflation_rate_pct * 2 + 50)),
    liquidityScore: liquidity.liquidity_stress_score,
  });

  const supplyMetrics = buildSupplyMetrics(
    schedule,
    circulatingSupply,
    upcomingUnlockAmount,
    volume30dApprox
  );

  const flat = mapRegistryResultToFlat(emission, liquidity, vesting, riskAssessment, {
    price,
    circulatingSupply,
    volume30dApprox,
    eventAmounts: eventAmounts,
    eventTimestamps: eventRows.map((r) => r.timestamp),
    simulation_params: input.simulation_params,
    executionNowMs,
  });
  flat.result_integrity_hash = computeResultIntegrityHash(flat as unknown as Record<string, unknown>) || "";
  setCachedResult(cacheKey, flat);
  return { success: true, data: flat };
}

function mapRegistryResultToFlat(
  emission: Awaited<ReturnType<typeof analyzeEmissionPattern>>,
  liquidity: Awaited<ReturnType<typeof computeLiquidityStress>>,
  vesting: Awaited<ReturnType<typeof detectVestingCliffs>>,
  riskAssessment: Awaited<ReturnType<typeof computeSupplyRiskScore>>,
  context: {
    price: number;
    circulatingSupply: number;
    volume30dApprox: number;
    eventAmounts: number[];
    eventTimestamps?: (Date | null)[];
    simulation_params?: SupplyRiskInput["simulation_params"];
    executionNowMs: number;
  }
): SupplyRiskOutputFlat {
  const nextTs = vesting.next_cliff_date
    ? (() => {
        const t = Date.parse(vesting.next_cliff_date);
        return Number.isNaN(t) ? null : Math.floor(t / 1000);
      })()
    : null;
  const score = Math.min(100, Math.max(0, riskAssessment.overall_risk_score));
  const unlockVariance = context.eventAmounts.length >= 2
    ? Math.min(1, variance(context.eventAmounts) / (mean(context.eventAmounts) ** 2 + 1))
    : 0.5;
  const volumeSources = context.volume30dApprox > 0 ? [context.volume30dApprox] : [];
  const { volume_source_consistency_score } = computeVolumeFusion(volumeSources);
  const volumeVariance = 1 - Math.min(100, Math.max(0, volume_source_consistency_score)) / 100;
  const forwardCurve = buildForwardRiskWithUncertainty(score, score, score, {
    volatilityHint: vesting.cliff_severity_score / 100,
    dataQuality: 0.8,
    unlockVariance,
    volumeVariance,
  });
  const concentration = computeConcentrationRisk({
    maxSingleUnlockPct: vesting.max_unlock_pct_supply,
    treasuryPct: vesting.max_unlock_pct_supply,
  });
  const { fused_volume_30d_usd } = computeVolumeFusion(volumeSources);
  const timestampsMs = (context.eventTimestamps ?? [])
    .map((t) => (t instanceof Date ? t.getTime() : typeof t === "number" && Number.isFinite(t) ? t : null))
    .filter((x): x is number => x != null);
  const windowRates = computeWindowInflationRates(
    context.executionNowMs,
    timestampsMs,
    context.eventAmounts,
    Math.max(1, context.circulatingSupply)
  );
  const fallback90d = emission.supply_growth_30d_pct * 3;
  const { inflation_90d: inflationRate90d, historical_depth_limited } = computeRollingInflation90d({
    windowInflationRates: windowRates,
    fallbackScaled90d: fallback90d,
  });
  const inflationRatesForVol = [emission.supply_growth_30d_pct, inflationRate90d];
  const supplyVolatilityIndex = computeSupplyVolatilityIndex(inflationRatesForVol);
  const volumeValues = context.volume30dApprox > 0 ? [context.volume30dApprox] : [];
  const unlockPatternType = computeUnlockPatternType(
    context.eventAmounts,
    context.eventTimestamps
  );
  const depthProfile = computeLiquidityDepthProfile({
    volume30dUsd: context.volume30dApprox,
    circulatingSupply: Math.max(1, context.circulatingSupply),
    price: Math.max(0, context.price) || 1,
    unlockPressureRatio: liquidity.unlock_to_volume_ratio,
  });
  const depthMetrics = [
    depthProfile.impact_1pct,
    depthProfile.impact_3pct,
    depthProfile.impact_5pct,
  ];
  const combinedVolatilityIndex = computeCombinedVolatilityIndex({
    inflationRates: inflationRatesForVol,
    volumeValues: volumeValues.length >= 2 ? volumeValues : undefined,
    depthMetrics,
  });
  const patternCv =
    context.eventAmounts.length >= 2 && mean(context.eventAmounts) > 0
      ? Math.sqrt(variance(context.eventAmounts)) / mean(context.eventAmounts)
      : 0;
  const patternConfidenceScore = computePatternConfidenceScore(
    context.eventAmounts.length,
    patternCv
  );
  const holderDataConfidenceScore = computeHolderDataConfidenceScore("treasury_inference");
  const emissionAcceleration = computeEmissionAcceleration(context.eventAmounts);
  let simulation_outcome: SimulationOutcome | null = null;
  if (context.simulation_params && Object.keys(context.simulation_params).length > 0) {
    simulation_outcome = runShockSimulation(context.simulation_params, {
      liquidity_stress_score: liquidity.liquidity_stress_score,
      unlock_pressure_ratio: liquidity.unlock_to_volume_ratio,
      inflation_rate_30d: emission.supply_growth_30d_pct,
    });
  }
  const liquidityStress = Math.min(100, Math.max(0, sanitizeNum(liquidity.liquidity_stress_score)));
  const riskFlags = buildRiskFlags({
    liquidity_stress_score: liquidityStress,
    unlock_pressure_ratio: liquidity.unlock_to_volume_ratio,
    cliff_detected: Boolean(vesting.has_cliff),
    inflation_rate_30d: emission.supply_growth_30d_pct,
    top_holder_concentration_score: concentration.top_holder_concentration_score,
    emission_acceleration_score: emissionAcceleration,
  });

  const dataQualityScore = Math.min(
    100,
    Math.max(0, computeDataQualityScore({
      volumeSourceCount: context.volume30dApprox > 0 ? 1 : 0,
      unlockHistoryDepth: context.eventAmounts.length,
      supplyHistoryCompleteness: context.circulatingSupply > 0 ? 1 : 0,
    }))
  );

  return {
    model_metadata: buildModelMetadata(),
    data_freshness: buildDataFreshness({
      last_rpc_block_number: 0,
      block_number_used: 0,
      block_timestamp_used: 0,
      nowSec: Math.floor(context.executionNowMs / 1000),
    }),
    inflation_rate_30d: sanitizeNum(emission.supply_growth_30d_pct),
    inflation_rate_90d: sanitizeNum(inflationRate90d),
    supply_volatility_index: Math.min(100, Math.max(0, supplyVolatilityIndex)),
    emission_trend: sanitizeNum(emission.supply_velocity),
    unlock_pressure_ratio: sanitizeNum(liquidity.unlock_to_volume_ratio),
    unlock_pressure_classification: getUnlockPressureClassification(liquidity.unlock_to_volume_ratio),
    fused_volume_30d_usd: sanitizeNum(fused_volume_30d_usd),
    liquidity_stress_score: liquidityStress,
    cliff_detected: Boolean(vesting.has_cliff),
    cliff_size_percent: Math.min(100, Math.max(0, sanitizeNum(vesting.max_unlock_pct_supply))),
    next_estimated_unlock_timestamp: nextTs,
    unlock_pattern_type: unlockPatternType,
    forward_risk_curve: forwardCurve,
    volume_source_consistency_score: Math.min(100, Math.max(0, volume_source_consistency_score)),
    top_holder_concentration_score: concentration.top_holder_concentration_score,
    treasury_exposure_score: concentration.treasury_exposure_score,
    max_single_unlock_risk: concentration.max_single_unlock_risk,
    liquidity_depth_profile: {
      impact_1pct: sanitizeNum(depthProfile.impact_1pct),
      impact_3pct: sanitizeNum(depthProfile.impact_3pct),
      impact_5pct: sanitizeNum(depthProfile.impact_5pct),
    },
    emission_acceleration_score: Math.min(100, Math.max(0, emissionAcceleration)),
    simulation_outcome,
    risk_flags: riskFlags,
    risk_tier: getRiskTier(liquidityStress),
    result_integrity_hash: "",
    engine_latency_ms: 0,
    data_quality_score: dataQualityScore,
    historical_depth_limited,
    holder_data_confidence_score: Math.min(100, Math.max(0, holderDataConfidenceScore)),
    combined_volatility_index: Math.min(100, Math.max(0, combinedVolatilityIndex)),
    pattern_confidence_score: Math.min(100, Math.max(0, patternConfidenceScore)),
    analysis_scope: "registry",
  };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Bucket unlock events into 30d windows (t-90→t-60, t-60→t-30, t-30→t) and return
 * inflation % per window (sum(amounts in window) / circulatingSupply * 100).
 * Uses executionNowMs as t so window boundaries are deterministic for the same execution.
 */
function computeWindowInflationRates(
  executionNowMs: number,
  timestamps: number[],
  amounts: number[],
  circulatingSupply: number
): number[] {
  if (timestamps.length === 0 || amounts.length === 0 || circulatingSupply <= 0) return [];
  const t = Number.isFinite(executionNowMs) ? executionNowMs : Math.max(...timestamps);
  const minTs = Math.min(...timestamps);
  const rangeDays = (t - minTs) / (24 * 60 * 60 * 1000);
  const w3End = t;
  const w3Start = t - THIRTY_DAYS_MS;
  const w2End = w3Start;
  const w2Start = t - 2 * THIRTY_DAYS_MS;
  const w1End = w2Start;
  const w1Start = t - 3 * THIRTY_DAYS_MS;
  let s1 = 0; let s2 = 0; let s3 = 0;
  const len = Math.min(timestamps.length, amounts.length);
  for (let i = 0; i < len; i++) {
    const ts = timestamps[i];
    const amt = amounts[i] ?? 0;
    if (ts >= w3Start && ts <= w3End) s3 += amt;
    else if (ts >= w2Start && ts < w2End) s2 += amt;
    else if (ts >= w1Start && ts < w1End) s1 += amt;
  }
  const rate = (sum: number) => (sum / circulatingSupply) * 100;
  if (rangeDays >= 90) return [rate(s1), rate(s2), rate(s3)];
  if (rangeDays >= 60) return [rate(s2), rate(s3)];
  if (s3 > 0) return [rate(s3)];
  return [];
}

function sanitizeNum(x: number): number {
  if (typeof x !== "number" || Number.isNaN(x) || !Number.isFinite(x)) return 0;
  return x;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
}
