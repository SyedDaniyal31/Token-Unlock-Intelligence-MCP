/**
 * Unlock Pressure vs Market Liquidity Modeling.
 * Computes structural sell-pressure risk from unlock size, volume, supply, and FDV.
 * Isolated from routes/controllers for future extensions (orderbook depth, volatility, cohort weighting).
 *
 * Scoring formula:
 * - volume30dAvg = volume30dAvg ?? (volume24h * 0.85)
 * - unlockToVolumeRatio = unlockValueUSD / volume30dAvg  (≈0.5 manageable, >1 heavy, >2 severe)
 * - unlockToSupplyPct = unlockAmount / circulatingSupply * 100  (>1% low, >3% meaningful, >5%+ high)
 * - unlockToFDVPct = unlockValueUSD / fdv * 100  (optional when totalSupply present)
 * - Composite: piecewise-scaled scores → volume 50%, supply 35%, FDV 15%; clamp 0–100
 * - Risk: 0–25 LOW, 26–50 MODERATE, 51–75 HIGH, 76–100 EXTREME
 *
 * Example output:
 * {
 *   "unlockAmount": 1000000,
 *   "unlockValueUSD": 2500000,
 *   "volume30dAvg": 5000000,
 *   "unlockToVolumeRatio": 0.5,
 *   "circulatingSupply": 50000000,
 *   "unlockToSupplyPct": 2,
 *   "fdv": 100000000,
 *   "unlockToFDVPct": 2.5,
 *   "compositeScore": 42,
 *   "riskLevel": "MODERATE"
 * }
 */

import type { LiquidityStressResult } from "../core/types.js";
import logger from "../core/logger.js";

const VOLUME_30D_SMOOTHING = 0.85;

/** Input market data; totalSupply and volume30dAvg are optional (FDV and 30d approx when missing). */
export interface MarketData {
  price: number;
  marketCap: number;
  volume24h: number;
  circulatingSupply: number;
  totalSupply?: number;
  /** When provided, used as 30d avg volume; otherwise volume30dAvg = volume24h * 0.85 */
  volume30dAvg?: number;
}

const WEIGHT_VOLUME = 0.5;
const WEIGHT_SUPPLY = 0.35;
const WEIGHT_FDV = 0.15;

/** Piecewise linear: (x, score) breakpoints, interpolate between, clamp beyond. */
function piecewiseScale(
  x: number,
  points: ReadonlyArray<[number, number]>
): number {
  if (x <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    if (x <= points[i][0]) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return points[points.length - 1][1];
}

/** Unlock/Volume ratio → 0–100: 0.2→10, 0.5→30, 1.0→60, 2.0+→100 */
function scaleVolumeRatio(ratio: number): number {
  return piecewiseScale(ratio, [
    [0, 0],
    [0.2, 10],
    [0.5, 30],
    [1.0, 60],
    [2.0, 100],
  ]);
}

/** Unlock/Supply % → 0–100: 1%→20, 3%→50, 5%→80, 8%+→100 */
function scaleSupplyPct(pct: number): number {
  return piecewiseScale(pct, [
    [0, 0],
    [1, 20],
    [3, 50],
    [5, 80],
    [8, 100],
  ]);
}

/** Unlock/FDV % → 0–100: 0.5%→20, 1%→40, 2%→70, 5%+→100 */
function scaleFDVPct(pct: number): number {
  return piecewiseScale(pct, [
    [0, 0],
    [0.5, 20],
    [1, 40],
    [2, 70],
    [5, 100],
  ]);
}

function classifyRisk(compositeScore: number): LiquidityStressResult["riskLevel"] {
  if (compositeScore <= 25) return "LOW";
  if (compositeScore <= 50) return "MODERATE";
  if (compositeScore <= 75) return "HIGH";
  return "EXTREME";
}

/**
 * Computes liquidity stress from unlock amount and market data.
 * Fail-safe: on missing price/volume/circulatingSupply returns compositeScore 0, riskLevel LOW, insufficientData true.
 */
export function calculateLiquidityStress(
  unlockAmount: number,
  marketData: MarketData
): LiquidityStressResult {
  const price = Number(marketData.price) || 0;
  const circulatingSupply = Number(marketData.circulatingSupply) || 0;
  const volume24h = Number(marketData.volume24h) || 0;
  const volume30dAvg =
    marketData.volume30dAvg != null && marketData.volume30dAvg > 0
      ? Number(marketData.volume30dAvg)
      : volume24h * VOLUME_30D_SMOOTHING;

  const insufficientData =
    price <= 0 || (volume24h <= 0 && volume30dAvg <= 0) || circulatingSupply <= 0;

  if (insufficientData) {
    const result: LiquidityStressResult = {
      unlockAmount,
      unlockValueUSD: unlockAmount * price,
      volume30dAvg,
      unlockToVolumeRatio: 0,
      circulatingSupply,
      unlockToSupplyPct: circulatingSupply > 0 ? (unlockAmount / circulatingSupply) * 100 : 0,
      compositeScore: 0,
      riskLevel: "LOW",
      insufficientData: true,
    };
    logger.info(
      { unlockAmount, compositeScore: 0, riskLevel: "LOW", insufficientData: true },
      "Liquidity stress: insufficient market data"
    );
    return result;
  }

  const unlockValueUSD = unlockAmount * price;
  const unlockToVolumeRatio =
    volume30dAvg > 0 ? unlockValueUSD / volume30dAvg : 0;
  const unlockToSupplyPct =
    circulatingSupply > 0 ? (unlockAmount / circulatingSupply) * 100 : 0;

  const totalSupply = marketData.totalSupply != null && marketData.totalSupply > 0
    ? Number(marketData.totalSupply)
    : undefined;
  const fdv = totalSupply != null ? price * totalSupply : undefined;
  const unlockToFDVPct =
    fdv != null && fdv > 0 ? (unlockValueUSD / fdv) * 100 : undefined;

  const scoreVolume = scaleVolumeRatio(unlockToVolumeRatio);
  const scoreSupply = scaleSupplyPct(unlockToSupplyPct);
  const scoreFDV =
    unlockToFDVPct != null ? scaleFDVPct(unlockToFDVPct) : 50;

  const compositeScore = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        scoreVolume * WEIGHT_VOLUME +
          scoreSupply * WEIGHT_SUPPLY +
          scoreFDV * WEIGHT_FDV
      )
    )
  );
  const riskLevel = classifyRisk(compositeScore);

  const result: LiquidityStressResult = {
    unlockAmount,
    unlockValueUSD,
    volume30dAvg,
    unlockToVolumeRatio,
    circulatingSupply,
    unlockToSupplyPct,
    fdv,
    unlockToFDVPct,
    compositeScore,
    riskLevel,
  };

  logger.info(
    {
      unlockAmount,
      unlockValueUSD,
      unlockToVolumeRatio,
      unlockToSupplyPct,
      compositeScore,
      riskLevel,
    },
    "Liquidity stress calculated"
  );

  return result;
}
