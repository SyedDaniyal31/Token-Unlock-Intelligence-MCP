/**
 * Multi-chain token supply risk engine: orchestrates supply, historical, vesting, emission, liquidity, risk.
 */

import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getScheduleByToken, getChainIdsForToken, getUnlockEventsInRange } from "../ingestion/unlockRegistry.js";
import { getMarketData } from "../market/MarketAggregator.js";
import { computeSellableSupply } from "../intelligence/sellableSupply.js";
import { buildSupplyMetrics } from "../core/supplyAnalyzer.js";
import { analyzeHistoricalUnlocks } from "../core/historicalUnlocks.js";
import { detectVestingCliffs } from "../core/vestingAnalyzer.js";
import { analyzeEmissionPattern } from "../core/emissionModel.js";
import { computeLiquidityStress } from "../core/liquidityAnalyzer.js";
import { computeSupplyRiskScore } from "../core/riskEngine.js";

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEFRAME_DAYS = 30;

export interface SupplyRiskInput {
  token_symbol: string;
  chain?: "ethereum" | "arbitrum" | "bsc";
  timeframe_days?: number;
}

export interface SupplyRiskOutput {
  success: true;
  data: {
    token: string;
    chain: string;
    supply_metrics: {
      total_supply: number;
      circulating_supply: number;
      max_supply: number;
      team_allocation_pct: number;
      investor_allocation_pct: number;
      treasury_allocation_pct: number;
      upcoming_unlock_amount: number;
      avg_30d_volume_usd: number;
    };
    historical_unlock_analysis: {
      unlock_events_last_12m: number;
      avg_unlock_size: number;
      supply_increase_pct_per_event: number;
      price_reaction_avg_pct: number;
      post_unlock_volatility: number;
    };
    vesting_cliff_analysis: {
      large_unlock_count: number;
      clustered_unlocks: boolean;
      has_cliff: boolean;
      next_cliff_date: string;
      cliff_severity_score: number;
      max_unlock_pct_supply: number;
      avg_unlock_size: number;
    };
    emission_analysis: {
      pattern: string;
      annual_inflation_rate_pct: number;
      supply_growth_30d_pct: number;
      supply_velocity: number;
      supply_change_pct: number;
    };
    liquidity_analysis: {
      unlock_to_volume_ratio: number;
      liquidity_stress_score: number;
      liquidity_risk_level: string;
      unlock_value_usd: number;
      volume_30d_avg: number;
      unlock_to_supply_pct: number;
    };
    risk_assessment: {
      overall_risk_score: number;
      risk_level: string;
      components: {
        historical_score: number;
        unlock_score: number;
        cliff_score: number;
        emission_score: number;
        liquidity_score: number;
      };
    };
  };
}

export interface SupplyRiskError {
  success: false;
  error: string;
}

export type SupplyRiskResult = SupplyRiskOutput | SupplyRiskError;

function num(x: unknown): number {
  if (typeof x === "number" && !Number.isNaN(x)) return x;
  const n = Number(x);
  return Number.isNaN(n) ? 0 : n;
}

function str(x: unknown): string {
  if (typeof x === "string") return x;
  return x != null ? String(x) : "";
}

/** Resolve display slug (ethereum|arbitrum|bsc) and DB chain_id. */
function resolveChain(
  requestedChain: string | undefined,
  chainIdsFromRegistry: string[]
): { slug: string; dbChainId: string } {
  const preferred = (requestedChain ?? "").toLowerCase().trim();
  const wantBsc = preferred === "bsc" || preferred === "bnb";
  const wantArbitrum = preferred === "arbitrum";
  const wantEthereum = preferred === "ethereum" || !preferred;

  if (wantEthereum && (chainIdsFromRegistry.includes("ethereum") || chainIdsFromRegistry.length === 0)) {
    return { slug: "ethereum", dbChainId: "ethereum" };
  }
  if (wantArbitrum && chainIdsFromRegistry.includes("arbitrum")) {
    return { slug: "arbitrum", dbChainId: "arbitrum" };
  }
  if (wantBsc) {
    const bscId = chainIdsFromRegistry.includes("bsc") ? "bsc" : chainIdsFromRegistry.includes("bnb") ? "bnb" : "bsc";
    return { slug: "bsc", dbChainId: bscId };
  }

  const first = chainIdsFromRegistry[0] ?? "ethereum";
  const slug = first === "bnb" ? "bsc" : first === "ethereum" || first === "arbitrum" || first === "bsc" ? first : "ethereum";
  return { slug, dbChainId: first };
}

export async function runAnalyzeTokenSupplyRisk(
  input: SupplyRiskInput,
  deps: UnlockIntelligenceDeps
): Promise<SupplyRiskResult> {
  const symbol = str(input.token_symbol).trim().toUpperCase();
  if (!symbol) return { success: false, error: "Token symbol is required." };

  const timeframeDays = Math.max(1, Math.min(365, num(input.timeframe_days) || DEFAULT_TIMEFRAME_DAYS));

  let chainIds: string[];
  try {
    chainIds = await getChainIdsForToken(symbol);
  } catch {
    return { success: false, error: "Token not supported on selected chain." };
  }

  const { slug: chainSlug, dbChainId } = resolveChain(input.chain, chainIds);
  const schedule = await getScheduleByToken(symbol, dbChainId);
  if (!schedule) return { success: false, error: "Token not supported on selected chain." };

  const market = await getMarketData(symbol, schedule.coingecko_id ?? undefined, schedule.paprika_id ?? undefined);
  const circulatingSupply = Math.max(0, num(market.circulatingSupply));
  const price = Math.max(0, num(market.price));
  const volume24h = Math.max(0, num(market.volume24h));
  const volume30dApprox = volume24h * 0.85;

  const supplyResult = await computeSellableSupply(symbol, volume30dApprox, dbChainId);
  const upcomingUnlockAmount = num(supplyResult.real_sellable_supply) || num(supplyResult.claimed_amount);

  const since12m = new Date(Date.now() - TWELVE_MONTHS_MS);
  let eventRows: { amount: string; timestamp: Date | null }[];
  try {
    eventRows = await getUnlockEventsInRange(symbol, since12m, new Date(), dbChainId);
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

  return {
    success: true,
    data: {
      token: symbol,
      chain: chainSlug,
      supply_metrics: {
        total_supply: supplyMetrics.total_supply,
        circulating_supply: supplyMetrics.circulating_supply,
        max_supply: supplyMetrics.max_supply,
        team_allocation_pct: supplyMetrics.team_allocation_pct,
        investor_allocation_pct: supplyMetrics.investor_allocation_pct,
        treasury_allocation_pct: supplyMetrics.treasury_allocation_pct,
        upcoming_unlock_amount: supplyMetrics.upcoming_unlock_amount,
        avg_30d_volume_usd: supplyMetrics.avg_30d_volume_usd,
      },
      historical_unlock_analysis: {
        unlock_events_last_12m: historical.unlock_events_last_12m,
        avg_unlock_size: historical.avg_unlock_size,
        supply_increase_pct_per_event: historical.supply_increase_pct_per_event,
        price_reaction_avg_pct: historical.price_reaction_avg_pct,
        post_unlock_volatility: historical.post_unlock_volatility,
      },
      vesting_cliff_analysis: {
        large_unlock_count: vesting.large_unlock_count,
        clustered_unlocks: vesting.clustered_unlocks,
        has_cliff: vesting.has_cliff,
        next_cliff_date: vesting.next_cliff_date,
        cliff_severity_score: vesting.cliff_severity_score,
        max_unlock_pct_supply: vesting.max_unlock_pct_supply,
        avg_unlock_size: vesting.avg_unlock_size,
      },
      emission_analysis: {
        pattern: emission.pattern,
        annual_inflation_rate_pct: emission.annual_inflation_rate_pct,
        supply_growth_30d_pct: emission.supply_growth_30d_pct,
        supply_velocity: emission.supply_velocity,
        supply_change_pct: emission.supply_change_pct,
      },
      liquidity_analysis: {
        unlock_to_volume_ratio: liquidity.unlock_to_volume_ratio,
        liquidity_stress_score: liquidity.liquidity_stress_score,
        liquidity_risk_level: liquidity.liquidity_risk_level,
        unlock_value_usd: liquidity.unlock_value_usd,
        volume_30d_avg: liquidity.volume_30d_avg,
        unlock_to_supply_pct: liquidity.unlock_to_supply_pct,
      },
      risk_assessment: {
        overall_risk_score: riskAssessment.overall_risk_score,
        risk_level: riskAssessment.risk_level,
        components: {
          historical_score: riskAssessment.components.historical_score,
          unlock_score: riskAssessment.components.unlock_score,
          cliff_score: riskAssessment.components.cliff_score,
          emission_score: riskAssessment.components.emission_score,
          liquidity_score: riskAssessment.components.liquidity_score,
        },
      },
    },
  };
}
