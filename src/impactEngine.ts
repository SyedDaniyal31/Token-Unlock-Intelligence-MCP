/**
 * Unlock Impact Engine — deterministic, institutional-grade scoring model
 * for token unlock sell-pressure risk. No randomness; production-ready.
 */

export type MarketRegime = "bull" | "neutral" | "bear";

export type CohortType =
  | "vc"
  | "team"
  | "foundation"
  | "ecosystem"
  | "airdrop"
  | "strategic";

export interface ImpactInput {
  unlock_percent_circulating: number;
  unlock_percent_free_float: number;
  unlock_usd_value: number;
  avg_30d_volume_usd: number;
  cohort_type: CohortType;
  avg_7d_return_post_unlock: number;
  token_performance_since_tge: number;
  market_regime: MarketRegime;
}

export interface ImpactOutput {
  final_score: number;
  risk_level: "Low" | "Medium" | "High" | "Extreme";
  component_breakdown: {
    size_score: number;
    liquidity_score: number;
    cohort_score: number;
    historical_score: number;
    regime_multiplier: number;
  };
  risk_summary: string;
}

const SIZE_CAP = 25;
const SIZE_CIRC_WEIGHT = 2;
const SIZE_FREE_FLOAT_WEIGHT = 1.5;

function computeSizeScore(
  unlockPercentCirculating: number,
  unlockPercentFreeFloat: number
): number {
  const raw =
    unlockPercentCirculating * SIZE_CIRC_WEIGHT +
    unlockPercentFreeFloat * SIZE_FREE_FLOAT_WEIGHT;
  return Math.min(SIZE_CAP, Math.max(0, raw));
}

const LIQUIDITY_MAX = 25;

function computeLiquidityScore(
  unlockUsdValue: number,
  avg30dVolumeUsd: number
): number {
  if (avg30dVolumeUsd <= 0) {
    return LIQUIDITY_MAX;
  }
  const ratio = unlockUsdValue / avg30dVolumeUsd;
  if (ratio < 0.1) return 2;
  if (ratio < 0.25) return 8;
  if (ratio < 0.5) return 15;
  if (ratio < 1.0) return 20;
  return 25;
}

const COHORT_BASE: Record<CohortType, number> = {
  vc: 18,
  team: 15,
  foundation: 12,
  ecosystem: 8,
  airdrop: 6,
  strategic: 10,
};

const COHORT_MIN = 0;
const COHORT_MAX = 20;
const COHORT_ADJUST_THRESHOLD_LOW = -50;
const COHORT_ADJUST_THRESHOLD_HIGH = 200;
const COHORT_ADJUST_FACTOR = 0.2;

function computeCohortScore(
  cohortType: CohortType,
  tokenPerformanceSinceTge: number
): number {
  let score = COHORT_BASE[cohortType];
  if (tokenPerformanceSinceTge < COHORT_ADJUST_THRESHOLD_LOW) {
    score = score * (1 - COHORT_ADJUST_FACTOR);
  } else if (tokenPerformanceSinceTge > COHORT_ADJUST_THRESHOLD_HIGH) {
    score = score * (1 + COHORT_ADJUST_FACTOR);
  }
  return Math.max(COHORT_MIN, Math.min(COHORT_MAX, score));
}

function computeHistoricalScore(avg7dReturnPostUnlock: number): number {
  if (avg7dReturnPostUnlock > 5) return 0;
  if (avg7dReturnPostUnlock >= 0) return 3;
  if (avg7dReturnPostUnlock > -5) return 6;
  if (avg7dReturnPostUnlock > -10) return 10;
  return 15;
}

const REGIME_MULTIPLIER: Record<MarketRegime, number> = {
  bull: 0.8,
  neutral: 1.0,
  bear: 1.2,
};

function getRegimeMultiplier(regime: MarketRegime): number {
  return REGIME_MULTIPLIER[regime];
}

function getRiskLevel(finalScore: number): ImpactOutput["risk_level"] {
  if (finalScore <= 30) return "Low";
  if (finalScore <= 55) return "Medium";
  if (finalScore <= 75) return "High";
  return "Extreme";
}

function roundToInteger(value: number): number {
  return Math.round(value);
}

/**
 * Build risk summary with structured tone: event magnitude, market impact,
 * liquidity absorption risk, volatility expectation. No defensive hedging.
 */
function buildRiskSummary(
  input: ImpactInput,
  output: ImpactOutput
): string {
  const ratio =
    input.avg_30d_volume_usd > 0
      ? input.unlock_usd_value / input.avg_30d_volume_usd
      : 0;
  const ratioRounded = Math.round(ratio * 100) / 100;
  const pctCirc = input.unlock_percent_circulating;
  const cohortLabel = input.cohort_type.toUpperCase();
  const hist7d = input.avg_7d_return_post_unlock;
  const regime = input.market_regime;

  switch (output.risk_level) {
    case "Low": {
      const magnitude = `Unlock represents ${pctCirc}% of circulating supply and ${ratioRounded}x daily volume. ${cohortLabel} allocation.`;
      const marketImpact = "Historical unlocks have not produced sustained downside.";
      const liquidity = "Market liquidity sufficient to absorb supply.";
      const volatility = "Low volatility expected around unlock window.";
      return `${magnitude} ${marketImpact} ${liquidity} ${volatility}`;
    }
    case "Medium": {
      const magnitude = `Unlock represents ${pctCirc}% of circulating supply and ${ratioRounded}x daily volume. ${cohortLabel} allocation.`;
      const marketImpact = `Post-unlock 7d return history: ${hist7d}%. ${regime} regime.`;
      const liquidity = "Market liquidity can absorb typical unlock volume.";
      const volatility = "Moderate volatility expected around unlock.";
      return `${magnitude} ${marketImpact} ${liquidity} ${volatility}`;
    }
    case "High": {
      const magnitude = `Upcoming unlock equals ${ratioRounded}x daily trading volume and ${pctCirc}% of circulating supply.`;
      const marketImpact = `Previous unlocks resulted in average ${hist7d}% 7d returns. ${cohortLabel} allocation with elevated profit-taking incentive.`;
      const liquidity = "Liquidity may be strained during unlock window.";
      const volatility = "Elevated short-term downside risk.";
      return `${magnitude} ${marketImpact} ${liquidity} ${volatility}`;
    }
    case "Extreme": {
      const magnitude = `Unlock exceeds ${ratioRounded}x daily volume and ${pctCirc}% of free float.`;
      const marketImpact = `Historical pattern shows repeated post-unlock drawdowns (avg 7d: ${hist7d}%). ${cohortLabel} cohort. ${regime} macro regime.`;
      const liquidity = "High probability of liquidity-driven repricing.";
      const volatility = "High volatility expected around unlock.";
      return `${magnitude} ${marketImpact} ${liquidity} ${volatility}`;
    }
    default: {
      const _: never = output.risk_level;
      return "";
    }
  }
}

/**
 * Computes unlock impact score (0–100) and risk level from five dimensions:
 * Size Shock, Liquidity Absorption, Cohort Sell Probability, Historical Reaction,
 * and Market Regime multiplier. Fully deterministic.
 */
export function computeImpactScore(input: ImpactInput): ImpactOutput {
  const size_score = computeSizeScore(
    input.unlock_percent_circulating,
    input.unlock_percent_free_float
  );

  const liquidity_score = computeLiquidityScore(
    input.unlock_usd_value,
    input.avg_30d_volume_usd
  );

  const cohort_score = computeCohortScore(
    input.cohort_type,
    input.token_performance_since_tge
  );

  const historical_score = computeHistoricalScore(
    input.avg_7d_return_post_unlock
  );

  const regime_multiplier = getRegimeMultiplier(input.market_regime);

  const base_score =
    size_score + liquidity_score + cohort_score + historical_score;
  const regime_adjusted = base_score * regime_multiplier;
  const final_score = Math.min(100, Math.max(0, roundToInteger(regime_adjusted)));

  const risk_level = getRiskLevel(final_score);

  const component_breakdown = {
    size_score,
    liquidity_score,
    cohort_score,
    historical_score,
    regime_multiplier,
  };

  const output: ImpactOutput = {
    final_score,
    risk_level,
    component_breakdown,
    risk_summary: "",
  };

  output.risk_summary = buildRiskSummary(input, output);

  return output;
}
