import type { RiskLevel } from "../core/types.js";
import type { MarketSnapshot } from "../core/types.js";
import type { SellableSupplyResult } from "./sellableSupply.js";

export interface ScoringInput {
  percent_circulating_supply: number;
  percent_volume: number;
  percent_transferred_to_exchanges: number;
  liquidity_depth_multiplier: number;
  behavioral_multiplier: number;
  cohort_type: string;
  avg_7d_return_post_unlock: number;
  token_performance_since_tge: number;
  market_regime: "bull" | "neutral" | "bear";
}

export interface ScoringOutput {
  score: number;
  risk_level: RiskLevel;
  explanation: string;
}

const SIZE_CAP = 25;
const SIZE_CIRC_WEIGHT = 2;
const SIZE_FREE_FLOAT_WEIGHT = 1.5;

function computeSizeScore(
  percentCirculating: number,
  percentFreeFloat: number
): number {
  const raw =
    percentCirculating * SIZE_CIRC_WEIGHT +
    percentFreeFloat * SIZE_FREE_FLOAT_WEIGHT;
  return Math.min(SIZE_CAP, Math.max(0, raw));
}

const LIQUIDITY_MAX = 25;

function computeLiquidityScore(
  unlockVsVolume: number,
  liquidityMultiplier: number
): number {
  if (unlockVsVolume <= 0) return LIQUIDITY_MAX;
  const base =
    unlockVsVolume < 0.1 ? 2 :
    unlockVsVolume < 0.25 ? 8 :
    unlockVsVolume < 0.5 ? 15 :
    unlockVsVolume < 1.0 ? 20 : 25;
  return Math.min(LIQUIDITY_MAX, base * liquidityMultiplier);
}

const COHORT_BASE: Record<string, number> = {
  vc: 18,
  team: 15,
  foundation: 12,
  ecosystem: 8,
  airdrop: 6,
  strategic: 10,
};

function computeCohortScore(
  cohortType: string,
  tokenPerformanceSinceTge: number
): number {
  const base = COHORT_BASE[cohortType.toLowerCase()] ?? 10;
  if (tokenPerformanceSinceTge < -50) return Math.max(0, base * 0.8);
  if (tokenPerformanceSinceTge > 200) return Math.min(20, base * 1.2);
  return Math.max(0, Math.min(20, base));
}

function computeHistoricalScore(avg7dReturn: number): number {
  if (avg7dReturn > 5) return 0;
  if (avg7dReturn >= 0) return 3;
  if (avg7dReturn > -5) return 6;
  if (avg7dReturn > -10) return 10;
  return 15;
}

const REGIME_MULT: Record<string, number> = {
  bull: 0.8,
  neutral: 1.0,
  bear: 1.2,
};

function getRiskLevel(score: number): RiskLevel {
  if (score <= 30) return "low";
  if (score <= 55) return "moderate";
  if (score <= 75) return "high";
  return "extreme";
}

function buildExplanation(
  input: ScoringInput,
  score: number,
  riskLevel: RiskLevel,
  components: { size: number; liquidity: number; cohort: number; historical: number; behavioral: number }
): string {
  const parts: string[] = [];
  parts.push(`Unlock represents ${input.percent_circulating_supply.toFixed(1)}% of circulating supply.`);
  parts.push(`Liquidity score component: ${components.liquidity.toFixed(0)}.`);
  parts.push(`Cohort (${input.cohort_type}): ${components.cohort.toFixed(0)}.`);
  parts.push(`Historical 7d return post-unlock: ${input.avg_7d_return_post_unlock}%.`);
  parts.push(`Behavioral multiplier: ${input.behavioral_multiplier.toFixed(2)}.`);
  parts.push(`Final score: ${score} (${riskLevel} risk).`);
  return parts.join(" ");
}

/**
 * Advanced trader logic: size, liquidity, cohort, historical, regime, behavioral.
 */
export function computeImpactScore(input: ScoringInput): ScoringOutput {
  const size_score = computeSizeScore(
    input.percent_circulating_supply,
    input.percent_circulating_supply * 1.2
  );
  const liquidity_score = computeLiquidityScore(
    input.percent_volume,
    input.liquidity_depth_multiplier
  );
  const cohort_score = computeCohortScore(
    input.cohort_type,
    input.token_performance_since_tge
  );
  const historical_score = computeHistoricalScore(input.avg_7d_return_post_unlock);
  const regime_mult = REGIME_MULT[input.market_regime] ?? 1.0;
  const behavioral = input.behavioral_multiplier;

  const base =
    size_score + liquidity_score + cohort_score + historical_score;
  const adjusted = base * regime_mult * behavioral;
  const score = Math.min(100, Math.max(0, Math.round(adjusted)));
  const risk_level = getRiskLevel(score);

  const explanation = buildExplanation(input, score, risk_level, {
    size: size_score,
    liquidity: liquidity_score,
    cohort: cohort_score,
    historical: historical_score,
    behavioral,
  });

  return { score, risk_level, explanation };
}

/**
 * Build scoring input from market snapshot and sellable supply.
 */
export function buildScoringInput(
  tokenSymbol: string,
  market: MarketSnapshot,
  supply: SellableSupplyResult,
  cohortType: string,
  avg7dReturn: number,
  performanceSinceTge: number
): ScoringInput {
  const percentVolume =
    market.avg_30d_volume_usd > 0
      ? (supply.real_sellable_supply / market.avg_30d_volume_usd) * 100
      : 0;
  const percentToExchanges =
    supply.claimed_amount > 0
      ? (supply.exchange_inflow / supply.claimed_amount) * 100
      : 0;
  const liquidityMultiplier =
    market.liquidity_depth_usd > 0
      ? Math.min(1.5, market.avg_30d_volume_usd / market.liquidity_depth_usd)
      : 1;
  const behavioralMultiplier = 1 + percentToExchanges / 100;

  return {
    percent_circulating_supply: supply.claimed_amount > 0 ? (supply.real_sellable_supply / supply.claimed_amount) * 10 : 0,
    percent_volume: percentVolume,
    percent_transferred_to_exchanges: percentToExchanges,
    liquidity_depth_multiplier: liquidityMultiplier,
    behavioral_multiplier: behavioralMultiplier,
    cohort_type: cohortType,
    avg_7d_return_post_unlock: avg7dReturn,
    token_performance_since_tge: performanceSinceTge,
    market_regime: "neutral",
  };
}
