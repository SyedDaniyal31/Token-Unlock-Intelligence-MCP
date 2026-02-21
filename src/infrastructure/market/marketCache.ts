import type { MarketDataProvider, MarketSnapshot } from "../../core/types.js";

const TTL_MS = 5 * 60 * 1000;

interface Entry {
  snapshot: MarketSnapshot;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

export function getCachedMarketSnapshot(tokenSymbol: string): MarketSnapshot | null {
  const key = tokenSymbol.toUpperCase();
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) cache.delete(key);
    return null;
  }
  return entry.snapshot;
}

export function setCachedMarketSnapshot(tokenSymbol: string, snapshot: MarketSnapshot): void {
  const key = tokenSymbol.toUpperCase();
  cache.set(key, {
    snapshot,
    expiresAt: Date.now() + TTL_MS,
  });
}

function stubSnapshot(tokenSymbol: string): MarketSnapshot {
  return {
    token_symbol: tokenSymbol,
    price_usd: 0,
    circulating_supply: 0,
    avg_30d_volume_usd: 0,
    market_cap_usd: 0,
    liquidity_depth_usd: 0,
    fetched_at: new Date().toISOString(),
  };
}

/**
 * Wraps a MarketDataProvider with 5-minute in-memory cache for &lt; 1.5s cached responses.
 * On upstream failure returns stub snapshot so report generation does not crash.
 */
export class CachingMarketProvider implements MarketDataProvider {
  constructor(private readonly inner: MarketDataProvider) {}

  async getMarketSnapshot(tokenSymbol: string): Promise<MarketSnapshot> {
    const cached = getCachedMarketSnapshot(tokenSymbol);
    if (cached) return cached;
    try {
      const snapshot = await this.inner.getMarketSnapshot(tokenSymbol);
      setCachedMarketSnapshot(tokenSymbol, snapshot);
      return snapshot;
    } catch {
      return stubSnapshot(tokenSymbol);
    }
  }
}
