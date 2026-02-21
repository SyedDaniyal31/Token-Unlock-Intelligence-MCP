/**
 * Unifies market data: delegates to MarketAggregatorService with fallback.
 * Never throws; returns zero market on total failure (report-safe).
 */

import type { NormalizedMarket } from "./CoinGeckoProvider.js";
import {
  MarketAggregatorService,
  InvalidTokenIdError,
  MarketUnavailableError,
} from "../services/MarketAggregator.js";
import logger from "../core/logger.js";

const aggregatorService = new MarketAggregatorService();

function zeroMarket(): NormalizedMarket {
  return {
    price: 0,
    marketCap: 0,
    volume24h: 0,
    circulatingSupply: 0,
  };
}

function toNormalized(r: {
  price: number;
  marketCap: number;
  volume24h: number;
  circulatingSupply: number;
}): NormalizedMarket {
  return {
    price: r.price,
    marketCap: r.marketCap,
    volume24h: r.volume24h,
    circulatingSupply: r.circulatingSupply,
  };
}

/**
 * Resolves market data via MarketAggregatorService; CoinGecko first, then CoinPaprika.
 * Returns zero market when both fail, invalid id, or no IDs; never throws.
 */
export async function getMarketData(
  symbol: string,
  coingeckoId?: string | null,
  paprikaId?: string | null
): Promise<NormalizedMarket> {
  const cgId = coingeckoId?.trim() || undefined;
  const papId = paprikaId?.trim() || undefined;
  if (!cgId && !papId) return zeroMarket();

  try {
    const result = await aggregatorService.getMarketData(cgId, papId);
    return toNormalized(result);
  } catch (err) {
    if (err instanceof InvalidTokenIdError) {
      logger.warn({ err, token_symbol: symbol }, "Invalid market token ID; using zero market");
    } else if (err instanceof MarketUnavailableError) {
      logger.warn({ token_symbol: symbol }, "Market data unavailable; using zero market");
    } else {
      logger.warn({ err, token_symbol: symbol }, "Market fetch failed; using zero market");
    }
    return zeroMarket();
  }
}
