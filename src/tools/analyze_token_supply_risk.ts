/**
 * Multi-chain token supply risk engine: registry-based or dynamic (any ERC-20/BEP-20).
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
import { runDynamicSupplyEngine } from "../services/dynamicSupply/index.js";

const TWELVE_MONTHS_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEFRAME_DAYS = 30;
const DYNAMIC_ENGINE_TIMEOUT_MS = 8000;

export interface SupplyRiskInput {
  token_symbol: string;
  token_address?: string;
  chain?: "ethereum" | "arbitrum" | "bsc";
  timeframe_days?: number;
}

export interface SupplyRiskOutputFlat {
  inflation_rate_30d: number;
  emission_trend: number;
  unlock_pressure_ratio: number;
  liquidity_stress_score: number;
  cliff_detected: boolean;
  next_estimated_unlock_timestamp: number | null;
  forward_risk_curve: { risk_30d: number; risk_90d: number; risk_180d: number };
}

export interface SupplyRiskOutput {
  success: true;
  data: SupplyRiskOutputFlat;
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
  const tokenAddress = str(input.token_address).trim();
  const chainSlug = input.chain === "ethereum" || input.chain === "arbitrum" || input.chain === "bsc" ? input.chain : undefined;

  if (tokenAddress && chainSlug) {
    try {
      const volume30dUsd = symbol
        ? (await getMarketData(symbol, undefined, undefined)).volume24h * 0.85
        : 0;
      const result = await Promise.race([
        runDynamicSupplyEngine({
          token_address: tokenAddress,
          chain: chainSlug,
          symbol: symbol || undefined,
          volume30dUsd,
        }),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("Dynamic engine timed out")), DYNAMIC_ENGINE_TIMEOUT_MS)
        ),
      ]);
      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  if (!symbol) return { success: false, error: "Token symbol or token_address is required." };

  const timeframeDays = Math.max(1, Math.min(365, num(input.timeframe_days) || DEFAULT_TIMEFRAME_DAYS));

  let chainIds: string[];
  try {
    chainIds = await getChainIdsForToken(symbol);
  } catch {
    return { success: false, error: "Token not supported on selected chain." };
  }

  const { slug: chainSlugReg, dbChainId } = resolveChain(input.chain, chainIds);
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

  const flat = mapRegistryResultToFlat(emission, liquidity, vesting, riskAssessment);
  return { success: true, data: flat };
}

function mapRegistryResultToFlat(
  emission: Awaited<ReturnType<typeof analyzeEmissionPattern>>,
  liquidity: Awaited<ReturnType<typeof computeLiquidityStress>>,
  vesting: Awaited<ReturnType<typeof detectVestingCliffs>>,
  riskAssessment: Awaited<ReturnType<typeof computeSupplyRiskScore>>
): SupplyRiskOutputFlat {
  const nextTs = vesting.next_cliff_date
    ? (() => {
        const t = Date.parse(vesting.next_cliff_date);
        return Number.isNaN(t) ? null : Math.floor(t / 1000);
      })()
    : null;
  const score = Math.min(100, Math.max(0, riskAssessment.overall_risk_score));
  return {
    inflation_rate_30d: sanitizeNum(emission.supply_growth_30d_pct),
    emission_trend: sanitizeNum(emission.supply_velocity),
    unlock_pressure_ratio: sanitizeNum(liquidity.unlock_to_volume_ratio),
    liquidity_stress_score: Math.min(100, Math.max(0, sanitizeNum(liquidity.liquidity_stress_score))),
    cliff_detected: Boolean(vesting.has_cliff),
    next_estimated_unlock_timestamp: nextTs,
    forward_risk_curve: {
      risk_30d: score,
      risk_90d: score,
      risk_180d: score,
    },
  };
}

function sanitizeNum(x: number): number {
  if (typeof x !== "number" || Number.isNaN(x) || !Number.isFinite(x)) return 0;
  return x;
}
