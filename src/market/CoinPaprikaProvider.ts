/**
 * CoinPaprika provider: fetches ticker by API id (e.g. "arb-arbitrum", "eth-ethereum").
 * Free API; no key. Uses in-memory cache, health circuit breaker, and rate limiter.
 */

import type { NormalizedMarket } from "./CoinGeckoProvider.js";
import { getFromCache, setCache } from "./MarketCache.js";
import { isProviderHealthy, recordSuccess, recordFailure } from "./ProviderHealth.js";
import { paprikaLimiter } from "../infrastructure/rateLimiter/RateLimiter.js";
import logger from "../core/logger.js";

export type { NormalizedMarket };

/** Fetches ticker from CoinPaprika by id; returns normalized market object or throws. */
export async function fetchFromCoinPaprika(id: string): Promise<NormalizedMarket> {
  if (!id || !id.trim()) {
    throw new Error("CoinPaprika request failed");
  }
  if (!(await isProviderHealthy("paprika"))) {
    throw new Error("Provider temporarily disabled");
  }
  const key = "paprika:" + id.trim();
  const cached = await getFromCache(key);
  if (cached) return cached;

  try {
    await paprikaLimiter.acquire();
    const url = `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id.trim())}`;
    const res = await fetch(url);
    if (res.status === 429) {
      logger.warn({ provider: "paprika" }, "Rate limited (429); cooldown 5s");
      await recordFailure("paprika");
      await new Promise<void>((r) => setTimeout(r, 5000));
      throw new Error("CoinPaprika request failed");
    }
    if (!res.ok) {
      await recordFailure("paprika");
      throw new Error("CoinPaprika request failed");
    }
    const data = (await res.json()) as {
      quotes?: { USD?: { price?: number; market_cap?: number; volume_24h?: number } };
      circulating_supply?: number;
    };
    const quotes = data?.quotes?.USD ?? {};
    const price = Number(quotes.price) || 0;
    const marketCap = Number(quotes.market_cap) || 0;
    const volume24h = Number(quotes.volume_24h) || 0;
    const circulatingSupply = Number(data?.circulating_supply) || 0;
    const result: NormalizedMarket = {
      price,
      marketCap,
      volume24h,
      circulatingSupply,
    };
    await setCache(key, result);
    await recordSuccess("paprika");
    return result;
  } catch (err) {
    await recordFailure("paprika");
    throw err;
  }
}
