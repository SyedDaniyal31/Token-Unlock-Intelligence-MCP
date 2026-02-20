import type { RiskLevel } from "../core/types.js";
import type { MarketSnapshot } from "../core/types.js";
import type { SellableSupplyResult } from "./sellableSupply.js";

export interface ScoringInput {
  percent_circulating_supply: number;
  percent_volume: number;
  percent_transferred_to_exchanges: number;
  liquidity_ratio?: number;
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
  primary_driver: string;
  sell_pressure_estimate: string;
}

const W_UNLOCK = 0.35;
const W_LIQUIDITY = 0.35;
const W_EXCHANGE_FLOW = 0.2;
const W_BEHAVIOR = 0.1;

function getRiskLevel(score: number): RiskLevel {
  if (score <= 30) return "low";
  if (score <= 55) return "moderate";
  if (score <= 75) return "high";
  return "extreme";
}

/**
 * Institutional formula: weighted sum of unlock %, liquidity ratio, exchange flow ratio, behavior.
 * Clamped 0–100. Returns primary_driver and sell_pressure_estimate.
 */
export function computeImpactScore(input: ScoringInput): ScoringOutput {
  const unlockComponent = Math.min(100, Math.max(0, input.percent_circulating_supply * 2));
  const liquidityComponent = Math.min(100, Math.max(0, input.percent_volume));
  const exchangeFlowComponent = Math.min(100, Math.max(0, input.percent_transferred_to_exchanges));
  const behaviorComponent = Math.min(100, Math.max(0, (input.behavioral_multiplier - 1) * 100));

  const score = Math.round(
    unlockComponent * W_UNLOCK +
    liquidityComponent * W_LIQUIDITY +
    exchangeFlowComponent * W_EXCHANGE_FLOW +
    behaviorComponent * W_BEHAVIOR
  );
  const clampedScore = Math.min(100, Math.max(0, score));
  const risk_level = getRiskLevel(clampedScore);

  const components = [
    { name: "unlock_percent_circulating", value: unlockComponent },
    { name: "liquidity_ratio", value: liquidityComponent },
    { name: "exchange_flow_ratio", value: exchangeFlowComponent },
    { name: "behavior_multiplier", value: behaviorComponent },
  ];
  const primary = components.reduce((a, b) => (a.value >= b.value ? a : b));
  const primary_driver = primary.name;

  const lr = input.liquidity_ratio ?? 0;
  const sell_pressure_estimate =
    lr >= 1 ? "Very high" : lr >= 0.5 ? "High" : lr >= 0.2 ? "Moderate" : "Low";

  const explanation = [
    `Unlock ${input.percent_circulating_supply.toFixed(1)}% circ; liquidity component ${liquidityComponent.toFixed(0)};`,
    `exchange flow ${input.percent_transferred_to_exchanges.toFixed(1)}%; behavior ${input.behavioral_multiplier.toFixed(2)}.`,
    `Score ${clampedScore} (${risk_level}). Primary driver: ${primary_driver}.`,
  ].join(" ");

  return {
    score: clampedScore,
    risk_level,
    explanation,
    primary_driver,
    sell_pressure_estimate,
  };
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

  const isLinearVesting =
    supply.vesting_type === "linear_vesting" || supply.vesting_type === "openzeppelin_token_vesting";
  const usePredictiveUnlock =
    isLinearVesting &&
    supply.expected_vested_24h != null &&
    supply.expected_vested_24h > 0 &&
    market.circulating_supply > 0;

  const percentCirculating = usePredictiveUnlock
    ? (supply.expected_vested_24h! / market.circulating_supply) * 100
    : market.circulating_supply > 0
      ? (supply.real_sellable_supply / market.circulating_supply) * 100
      : supply.claimed_amount > 0
        ? (supply.real_sellable_supply / supply.claimed_amount) * 10
        : 0;

  return {
    percent_circulating_supply: Math.min(100, percentCirculating),
    percent_volume: percentVolume,
    percent_transferred_to_exchanges: percentToExchanges,
    liquidity_ratio: supply.liquidity_ratio,
    liquidity_depth_multiplier: liquidityMultiplier,
    behavioral_multiplier: behavioralMultiplier,
    cohort_type: cohortType,
    avg_7d_return_post_unlock: avg7dReturn,
    token_performance_since_tge: performanceSinceTge,
    market_regime: "neutral",
  };
}
