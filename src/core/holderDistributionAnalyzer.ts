/**
 * Holder distribution risk mode: snapshot-only metrics when unlock discovery is empty or low-confidence.
 * No historical block scanning. Respects AbortSignal and deadline; must complete under 2s.
 */

const HOLDER_FALLBACK_TIMEOUT_MS = 2000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function toNum(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function throwIfAborted(signal: AbortSignal | undefined, deadline: number | undefined): void {
  if (signal?.aborted) throw new Error("Dynamic engine aborted");
  if (deadline != null && Date.now() > deadline) throw new Error("Unlock scanner deadline exceeded");
}

export interface HolderDistributionInput {
  chain: "ethereum" | "bsc" | "arbitrum" | "base";
  tokenAddress: string;
  totalSupply: number;
  /** Optional: from getMarketEnrichment for heuristic when no holder API. */
  enrichment?: {
    marketCapUsd?: number;
    liquidityUsd?: number;
    circulatingSupply?: number;
  } | null;
}

export interface HolderDistributionResult {
  top_holder_concentration_score: number;
  treasury_exposure_score: number;
  combined_volatility_index: number;
  /** 0–100 whale dominance from top-holder share. */
  whale_dominance_score: number;
}

/**
 * Compute holder-based concentration and volatility metrics from snapshot data.
 * Uses enrichment (liquidity/mcap, circulating/total) when no holder list is available.
 * Completes in under 2s; respects signal and deadline.
 */
export async function runHolderDistributionAnalysis(
  input: HolderDistributionInput,
  options?: { signal?: AbortSignal; deadline?: number }
): Promise<HolderDistributionResult> {
  const deadline = options?.deadline ?? Date.now() + HOLDER_FALLBACK_TIMEOUT_MS;
  throwIfAborted(options?.signal, deadline);

  const totalSupply = Math.max(1, toNum(input.totalSupply));
  const enrichment = input.enrichment;
  const circ = Math.max(0, toNum(enrichment?.circulatingSupply));
  const mcap = Math.max(0, toNum(enrichment?.marketCapUsd));
  const liquidityUsd = Math.max(0, toNum(enrichment?.liquidityUsd));

  // Heuristic: liquidity vs market cap ratio (low liquidity share => concentration risk)
  const liquidityShare = mcap > 0 ? liquidityUsd / mcap : 0;
  const concentrationFromLiquidity = liquidityShare <= 0 ? 40 : liquidityShare >= 0.1 ? 15 : clamp(40 - liquidityShare * 250, 15, 50);

  // Circulating vs total (locked estimate): high locked share => treasury/exposure risk
  const circulatingRatio = totalSupply > 0 ? circ / totalSupply : 1;
  const lockedSharePct = (1 - circulatingRatio) * 100;
  const treasuryExposure = clamp(lockedSharePct * 1.2, 0, 100);

  const topHolderConcentration = clamp(concentrationFromLiquidity + (lockedSharePct > 20 ? 20 : 0), 0, 100);
  const treasuryScore = clamp(treasuryExposure, 0, 100);
  const whaleDominance = clamp(topHolderConcentration * 0.9, 0, 100);
  const combinedVolatility = clamp((topHolderConcentration + treasuryScore) / 2, 0, 100);

  throwIfAborted(options?.signal, deadline);

  return {
    top_holder_concentration_score: Math.round(topHolderConcentration),
    treasury_exposure_score: Math.round(treasuryScore),
    combined_volatility_index: Math.round(combinedVolatility),
    whale_dominance_score: Math.round(whaleDominance),
  };
}
