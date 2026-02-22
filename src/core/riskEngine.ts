/**
 * Final supply risk score: weighted combination of historical, upcoming, cliff, emission, liquidity.
 * Weights: historical 20%, upcoming 25%, cliff 15%, emission 15%, liquidity 25%.
 */

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "EXTREME";

export interface RiskAssessment {
  overall_risk_score: number;
  risk_level: RiskLevel;
  components: {
    historical_score: number;
    unlock_score: number;
    cliff_score: number;
    emission_score: number;
    liquidity_score: number;
  };
}

const W_HISTORICAL = 0.2;
const W_UNLOCK = 0.25;
const W_CLIFF = 0.15;
const W_EMISSION = 0.15;
const W_LIQUIDITY = 0.25;

function clampScore(s: number): number {
  return Math.round(Math.min(100, Math.max(0, s)));
}

function toRiskLevel(score: number): RiskLevel {
  if (score <= 25) return "LOW";
  if (score <= 50) return "MODERATE";
  if (score <= 75) return "HIGH";
  return "EXTREME";
}

export interface RiskEngineInput {
  historicalScore: number;
  unlockScore: number;
  cliffScore: number;
  emissionScore: number;
  liquidityScore: number;
}

export function computeSupplyRiskScore(input: RiskEngineInput): RiskAssessment {
  const h = clampScore(input.historicalScore);
  const u = clampScore(input.unlockScore);
  const c = clampScore(input.cliffScore);
  const e = clampScore(input.emissionScore);
  const l = clampScore(input.liquidityScore);

  const overall = Math.round(
    h * W_HISTORICAL + u * W_UNLOCK + c * W_CLIFF + e * W_EMISSION + l * W_LIQUIDITY
  );
  const overallClamped = clampScore(overall);

  return {
    overall_risk_score: overallClamped,
    risk_level: toRiskLevel(overallClamped),
    components: {
      historical_score: h,
      unlock_score: u,
      cliff_score: c,
      emission_score: e,
      liquidity_score: l,
    },
  };
}
