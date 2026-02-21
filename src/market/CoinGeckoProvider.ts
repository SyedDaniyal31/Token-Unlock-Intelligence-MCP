/**
 * CoinGecko provider: fetches coin by API id (e.g. "arbitrum", "ethereum").
 * No API key; free tier. Uses in-memory cache, health circuit breaker, and rate limiter.
 */

import { getFromCache, setCache } from "./MarketCache.js";
import { isProviderHealthy, recordSuccess, recordFailure } from "./ProviderHealth.js";
import { coingeckoLimiter } from "../infrastructure/rateLimiter/RateLimiter.js";
import logger from "../core/logger.js";

export interface NormalizedMarket {
  price: number;
  marketCap: number;
  volume24h: number;
  circulatingSupply: number;
}

/** Fetches coin data from CoinGecko by id; returns normalized market object or throws. */
export async function fetchFromCoinGecko(id: string): Promise<NormalizedMarket> {
  if (!id || !id.trim()) {
    throw new Error("CoinGecko request failed");
  }
  if (!(await isProviderHealthy("coingecko"))) {
    throw new Error("Provider temporarily disabled");
  }
  const key = "coingecko:" + id.trim();
  const cached = await getFromCache(key);
  if (cached) return cached;

  try {
    await coingeckoLimiter.acquire();
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id.trim())}`;
    const res = await fetch(url);
    if (res.status === 429) {
      logger.warn({ provider: "coingecko" }, "Rate limited (429); cooldown 5s");
      await recordFailure("coingecko");
      await new Promise<void>((r) => setTimeout(r, 5000));
      throw new Error("CoinGecko request failed");
    }
    if (!res.ok) {
      await recordFailure("coingecko");
      throw new Error("CoinGecko request failed");
    }
    const data = (await res.json()) as {
      market_data?: {
        current_price?: { usd?: number };
        market_cap?: { usd?: number };
        total_volume?: { usd?: number };
        circulating_supply?: number;
      };
    };
    const md = data?.market_data ?? {};
    const price = Number(md.current_price?.usd) || 0;
    const marketCap = Number(md.market_cap?.usd) || 0;
    const volume24h = Number(md.total_volume?.usd) || 0;
    const circulatingSupply = Number(md.circulating_supply) || 0;
    const result: NormalizedMarket = {
      price,
      marketCap,
      volume24h,
      circulatingSupply,
    };
    await setCache(key, result);
    await recordSuccess("coingecko");
    return result;
  } catch (err) {
    await recordFailure("coingecko");
    throw err;
  }
}
