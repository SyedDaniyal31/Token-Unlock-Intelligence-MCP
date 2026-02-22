/**
 * Liquidity stress scoring: unlock vs volume ratio, 0-100 score, risk level.
 * >25% volume = high risk; >50% volume = extreme risk.
 */

import type { LiquidityRiskLevel } from "./types.js";
import { calculateLiquidityStress } from "../services/LiquidityStressModel.js";

export interface LiquidityAnalysis {
  unlock_to_volume_ratio: number;
  liquidity_stress_score: number;
  liquidity_risk_level: LiquidityRiskLevel;
  unlock_value_usd: number;
  volume_30d_avg: number;
  unlock_to_supply_pct: number;
}

export interface LiquidityInput {
  unlockAmount: number;
  price: number;
  circulatingSupply: number;
  volume24h: number;
  volume30dAvg?: number;
  totalSupply?: number;
}

export function computeLiquidityStress(input: LiquidityInput): LiquidityAnalysis {
  const result = calculateLiquidityStress(input.unlockAmount, {
    price: input.price,
    marketCap: input.price * input.circulatingSupply,
    volume24h: input.volume24h,
    circulatingSupply: input.circulatingSupply,
    volume30dAvg: input.volume30dAvg,
    totalSupply: input.totalSupply,
  });

  const liquidityStressScore = result.compositeScore ?? 0;
  const riskLevel: LiquidityRiskLevel = result.riskLevel ?? "LOW";

  return {
    unlock_to_volume_ratio: Number((result.unlockToVolumeRatio ?? 0).toFixed(4)),
    liquidity_stress_score: Math.round(Math.min(100, Math.max(0, liquidityStressScore))),
    liquidity_risk_level: riskLevel,
    unlock_value_usd: Number((result.unlockValueUSD ?? 0).toFixed(0)),
    volume_30d_avg: Number((result.volume30dAvg ?? 0).toFixed(0)),
    unlock_to_supply_pct: Number((result.unlockToSupplyPct ?? 0).toFixed(2)),
  };
}
