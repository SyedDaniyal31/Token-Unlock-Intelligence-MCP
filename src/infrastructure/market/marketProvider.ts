import type { MarketDataProvider, MarketSnapshot } from "../../core/types.js";

/**
 * Stub market provider. Returns zeroed snapshot.
 */
export class StubMarketProvider implements MarketDataProvider {
  async getMarketSnapshot(tokenSymbol: string): Promise<MarketSnapshot> {
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
}

const COINGECKO_SYMBOL_TO_ID: Record<string, string> = {
  ARB: "arbitrum",
  OP: "optimism",
  APT: "aptos",
  ETH: "ethereum",
  MATIC: "matic-network",
  SAND: "the-sandbox",
  AXS: "axie-infinity",
};

/**
 * CoinGecko market data provider. Fetches price, circulating supply, and volume.
 * No direct API calls inside intelligence layer; abstracted via MarketDataProvider.
 * Optional COINGECKO_API_KEY for higher rate limits.
 */
export class CoinGeckoMarketProvider implements MarketDataProvider {
  private readonly baseUrl = "https://api.coingecko.com/api/v3";
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? "";
  }

  async getMarketSnapshot(tokenSymbol: string): Promise<MarketSnapshot> {
    const id = COINGECKO_SYMBOL_TO_ID[tokenSymbol.toUpperCase()];
    if (!id) {
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
    const url = this.apiKey
      ? `${this.baseUrl}/coins/${id}?x_cg_pro_api_key=${this.apiKey}`
      : `${this.baseUrl}/coins/${id}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        return this.zeroSnapshot(tokenSymbol);
      }
      const data = (await res.json()) as {
        market_data?: {
          current_price?: { usd?: number };
          circulating_supply?: number;
          total_volume?: { usd?: number };
          market_cap?: { usd?: number };
        };
      };
      const md = data.market_data ?? {};
      const price = md.current_price?.usd ?? 0;
      const circulating = md.circulating_supply ?? 0;
      const totalVol = md.total_volume?.usd ?? 0;
      const marketCap = md.market_cap?.usd ?? price * circulating;
      return {
        token_symbol: tokenSymbol,
        price_usd: price,
        circulating_supply: circulating,
        avg_30d_volume_usd: totalVol * 30,
        market_cap_usd: marketCap,
        liquidity_depth_usd: totalVol,
        fetched_at: new Date().toISOString(),
      };
    } catch {
      return this.zeroSnapshot(tokenSymbol);
    }
  }

  private zeroSnapshot(tokenSymbol: string): MarketSnapshot {
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
}
