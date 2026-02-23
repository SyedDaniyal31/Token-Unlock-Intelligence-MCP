/**
 * Market enrichment layer: CoinGecko + DeFiLlama merge. 5-min cache, soft-fail, deterministic.
 */

import { fetchCoinGeckoData } from "./coingeckoClient.js";
import { fetchDefiLlamaLiquidity } from "./defillamaClient.js";

const CACHE_BUCKET_MS = 5 * 60 * 1000;

export interface MarketEnrichment {
  priceUsd: number;
  volume24hUsd: number;
  circulatingSupply: number;
  marketCapUsd: number;
  liquidityUsd: number;
}

const enrichmentCache = new Map<string, { data: MarketEnrichment; expires: number }>();

function cacheKey(symbol: string, chain: string, executionNowMs: number): string {
  const bucket = Math.floor(executionNowMs / CACHE_BUCKET_MS);
  return `${symbol.toLowerCase().trim()}:${chain}:${bucket}`;
}

function toNum(x: number | null | undefined): number {
  if (x != null && typeof x === "number" && Number.isFinite(x) && x >= 0) return x;
  return 0;
}

/**
 * Get merged market data from CoinGecko and (optionally) DeFiLlama. Never throws; returns null on failure.
 */
export async function getMarketEnrichment(
  symbol: string,
  chain: "ethereum" | "bsc" | "arbitrum",
  address: string | null,
  executionNowMs: number
): Promise<MarketEnrichment | null> {
  const key = cacheKey(symbol, chain, executionNowMs);
  const cached = enrichmentCache.get(key);
  if (cached != null && Date.now() < cached.expires) {
    return cached.data;
  }

  const cg = await fetchCoinGeckoData(symbol);
  if (cg == null) return null;

  let liquidityUsd = 0;
  if (address != null && address.trim() !== "") {
    const llama = await fetchDefiLlamaLiquidity(chain, address);
    if (llama != null && llama.liquidityUsd != null && Number.isFinite(llama.liquidityUsd)) {
      liquidityUsd = Math.max(0, llama.liquidityUsd);
    }
  }

  const data: MarketEnrichment = {
    priceUsd: toNum(cg.priceUsd),
    volume24hUsd: toNum(cg.volume24hUsd),
    circulatingSupply: toNum(cg.circulatingSupply),
    marketCapUsd: toNum(cg.marketCapUsd),
    liquidityUsd,
  };

  if (enrichmentCache.size >= 500) {
    const first = enrichmentCache.keys().next().value;
    if (first) enrichmentCache.delete(first);
  }
  enrichmentCache.set(key, { data, expires: Date.now() + CACHE_BUCKET_MS });

  return data;
}
