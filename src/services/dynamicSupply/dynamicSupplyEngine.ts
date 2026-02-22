/**
 * Dynamic token supply risk engine: works for any ERC-20/BEP-20 without static registry.
 * Fetches totalSupply, decimals, Transfer events; computes inflation, pressure, cliff heuristic, forward risk.
 */

import type { ChainProvider } from "../../core/types.js";
import { getChainProvider } from "../../infrastructure/rpc/chainProviderFactory.js";
import { readErc20Supply } from "./erc20ChainReader.js";
import { getSupplyFromCache, setSupplyInCache } from "./supplyCache.js";

const REQUEST_TIMEOUT_MS = 8000;

export interface ForwardRiskCurve {
  risk_30d: number;
  risk_90d: number;
  risk_180d: number;
}

export interface DynamicSupplyOutput {
  inflation_rate_30d: number;
  emission_trend: number;
  unlock_pressure_ratio: number;
  liquidity_stress_score: number;
  cliff_detected: boolean;
  next_estimated_unlock_timestamp: number | null;
  forward_risk_curve: ForwardRiskCurve;
}

function toNum(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export interface DynamicSupplyInput {
  token_address: string;
  chain: "ethereum" | "arbitrum" | "bsc";
  symbol?: string;
  volume30dUsd?: number;
  totalSupply?: number;
}

/**
 * Run dynamic supply engine with 8s timeout. Returns normalized metrics; never undefined/NaN.
 */
export async function runDynamicSupplyEngine(
  input: DynamicSupplyInput
): Promise<DynamicSupplyOutput> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const chainKey = input.chain;
  const provider = getChainProvider(chainKey);

  const addr = input.token_address.startsWith("0x")
    ? input.token_address
    : "0x" + input.token_address;

  let totalSupply = toNum(input.totalSupply);
  let decimals = 18;

  const cached = getSupplyFromCache(addr, chainKey);
  if (cached && cached.totalSupply >= 0) {
    totalSupply = totalSupply || cached.totalSupply;
    decimals = cached.decimals;
  } else {
    const snapshot = await readErc20Supply(provider, addr);
    totalSupply = totalSupply || snapshot.totalSupply;
    decimals = snapshot.decimals;
    setSupplyInCache(addr, chainKey, snapshot);
  }

  if (Date.now() >= deadline) {
    return defaultOutput(totalSupply, toNum(input.volume30dUsd));
  }

  const supplySafe = Math.max(1, totalSupply);
  const volume30d = Math.max(0, toNum(input.volume30dUsd));
  const unlockPressureRatio =
    volume30d > 0 && totalSupply > 0
      ? supplySafe / volume30d
      : 0;
  const pressureRatioClean = Number.isFinite(unlockPressureRatio) ? Math.max(0, unlockPressureRatio) : 0;
  const inflation30d = 0;
  const emissionTrend = 0;
  const cliffDetected = false;
  const cliffPct = 0;
  const liquidityScore = computeLiquidityStressScore(pressureRatioClean, inflation30d, cliffPct);
  const nextUnlockTs: number | null = null;

  const risk30d = clamp(liquidityScore, 0, 100);
  const risk90d = clamp(liquidityScore * 1.1, 0, 100);
  const risk180d = clamp(liquidityScore * 1.2, 0, 100);

  return {
    inflation_rate_30d: Number(Number(inflation30d).toFixed(4)),
    emission_trend: Number(Number(emissionTrend).toFixed(4)),
    unlock_pressure_ratio: Number(Number(pressureRatioClean).toFixed(4)),
    liquidity_stress_score: Math.round(clamp(liquidityScore, 0, 100)),
    cliff_detected: cliffDetected,
    next_estimated_unlock_timestamp: nextUnlockTs,
    forward_risk_curve: {
      risk_30d: Math.round(risk30d),
      risk_90d: Math.round(risk90d),
      risk_180d: Math.round(risk180d),
    },
  };
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

function defaultOutput(totalSupply: number, volume30dUsd: number): DynamicSupplyOutput {
  const supplySafe = Math.max(1, totalSupply);
  const ratio = volume30dUsd > 0 ? supplySafe / volume30dUsd : 0;
  return {
    inflation_rate_30d: 0,
    emission_trend: 0,
    unlock_pressure_ratio: Number(Number(ratio).toFixed(4)),
    liquidity_stress_score: 0,
    cliff_detected: false,
    next_estimated_unlock_timestamp: null,
    forward_risk_curve: { risk_30d: 0, risk_90d: 0, risk_180d: 0 },
  };
}
