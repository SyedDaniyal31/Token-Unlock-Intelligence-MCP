import type { MarketDataProvider, MarketSnapshot } from "../../core/types.js";

/**
 * Stub market provider. Returns zeroed snapshot.
 * Production: integrate with CoinGecko, Birdeye, or exchange APIs.
 */
export class StubMarketProvider implements MarketDataProvider {
  async getMarketSnapshot(tokenSymbol: string): Promise<MarketSnapshot> {
    return {
      token_symbol: tokenSymbol,
      avg_30d_volume_usd: 0,
      price_usd: 0,
      market_cap_usd: 0,
      liquidity_depth_usd: 0,
      fetched_at: new Date().toISOString(),
    };
  }
}
