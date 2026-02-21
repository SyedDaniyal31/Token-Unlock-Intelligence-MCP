/**
 * Production-grade market data aggregator: CoinGecko + CoinPaprika with
 * Redis cache (5 min), token ID validation, 429 retry with exponential backoff, and fallback.
 */

import { getRedisClient } from "../infrastructure/cache/RedisClient.js";
import { isProviderHealthy, recordFailure, recordSuccess } from "../market/ProviderHealth.js";
import { coingeckoLimiter, paprikaLimiter } from "../infrastructure/rateLimiter/RateLimiter.js";
import logger from "../core/logger.js";

const COINGECKO_BASE = "https://api.coingecko.com/api/v3/coins";
const PAPRIKA_BASE = "https://api.coinpaprika.com/v1/tickers";
const TOKEN_ID_REGEX = /^[a-z0-9-]+$/;
const CACHE_TTL_SEC = 300; // 5 minutes
const CACHE_KEY_PREFIX = "market:";
const BACKOFF_MS = [500, 1000, 2000];
const MAX_RETRIES = 3;

export type MarketProvider = "coingecko" | "paprika";

export interface UnifiedMarketResult {
  provider: MarketProvider;
  price: number;
  marketCap: number;
  volume24h: number;
  circulatingSupply: number;
  totalSupply: number;
  sourceRaw?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown when token ID format is invalid (400).
 */
export class InvalidTokenIdError extends Error {
  constructor(id: string) {
    super(`Invalid token ID: ${id}`);
    this.name = "InvalidTokenIdError";
  }
}

/**
 * Thrown when all providers fail (503).
 */
export class MarketUnavailableError extends Error {
  constructor() {
    super("Market data unavailable");
    this.name = "MarketUnavailableError";
  }
}

export class MarketAggregatorService {
  /**
   * Validates token ID: only lowercase letters, numbers, dashes. Throws InvalidTokenIdError if invalid.
   */
  validateTokenId(id: string): void {
    const trimmed = id?.trim() ?? "";
    if (!trimmed || !TOKEN_ID_REGEX.test(trimmed)) {
      throw new InvalidTokenIdError(trimmed || id);
    }
  }

  /**
   * Retries fn up to 3 times on failure with exponential backoff (500, 1000, 2000 ms).
   */
  private async retryWithBackoff<T>(
    fn: () => Promise<T>,
    _provider: MarketProvider
  ): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          await sleep(BACKOFF_MS[attempt] ?? 2000);
        }
      }
    }
    throw lastErr ?? new Error("Retries exhausted");
  }

  private async fetchFromCoinGecko(id: string): Promise<UnifiedMarketResult> {
    await coingeckoLimiter.acquire();
    const url = `${COINGECKO_BASE}/${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (res.status === 429) {
      await recordFailure("coingecko");
      throw new Error("Rate limited (429)");
    }
    if (!res.ok) {
      await recordFailure("coingecko");
      throw new Error(`CoinGecko request failed: ${res.status}`);
    }
    const raw = (await res.json()) as {
      market_data?: {
        current_price?: { usd?: number };
        market_cap?: { usd?: number };
        total_volume?: { usd?: number };
        circulating_supply?: number | null;
        total_supply?: number | null;
      };
    };
    const md = raw?.market_data ?? {};
    const price = Number(md.current_price?.usd) || 0;
    const marketCap = Number(md.market_cap?.usd) || 0;
    const volume24h = Number(md.total_volume?.usd) || 0;
    const circulatingSupply = Number(md.circulating_supply) ?? 0;
    const totalSupply = Number(md.total_supply) ?? 0;
    return {
      provider: "coingecko",
      price,
      marketCap,
      volume24h,
      circulatingSupply,
      totalSupply,
      sourceRaw: raw,
    };
  }

  private async fetchFromCoinPaprika(id: string): Promise<UnifiedMarketResult> {
    await paprikaLimiter.acquire();
    const url = `${PAPRIKA_BASE}/${encodeURIComponent(id)}`;
    const res = await fetch(url);
    if (res.status === 429) {
      await recordFailure("paprika");
      throw new Error("Rate limited (429)");
    }
    if (!res.ok) {
      await recordFailure("paprika");
      throw new Error(`CoinPaprika request failed: ${res.status}`);
    }
    const raw = (await res.json()) as {
      quotes?: { USD?: { price?: number; market_cap?: number; volume_24h?: number } };
      circulating_supply?: number | null;
      total_supply?: number | null;
    };
    const quotes = raw?.quotes?.USD ?? {};
    const price = Number(quotes.price) || 0;
    const marketCap = Number(quotes.market_cap) || 0;
    const volume24h = Number(quotes.volume_24h) || 0;
    const circulatingSupply = Number(raw?.circulating_supply) ?? 0;
    const totalSupply = Number(raw?.total_supply) ?? 0;
    return {
      provider: "paprika",
      price,
      marketCap,
      volume24h,
      circulatingSupply,
      totalSupply,
      sourceRaw: raw,
    };
  }

  /** Redis key: market:{provider}:{tokenId}. Returns null on miss or any error (fail-safe). */
  private async getCached(provider: MarketProvider, tokenId: string): Promise<UnifiedMarketResult | null> {
    const redis = getRedisClient();
    if (!redis) return null;
    const key = `${CACHE_KEY_PREFIX}${provider}:${tokenId}`;
    try {
      const raw = await redis.get(key);
      if (raw == null) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "provider" in parsed &&
        "price" in parsed &&
        "marketCap" in parsed &&
        "volume24h" in parsed &&
        "circulatingSupply" in parsed &&
        "totalSupply" in parsed
      ) {
        const p = parsed as UnifiedMarketResult;
        return {
          provider: p.provider,
          price: Number(p.price) || 0,
          marketCap: Number(p.marketCap) || 0,
          volume24h: Number(p.volume24h) || 0,
          circulatingSupply: Number(p.circulatingSupply) ?? 0,
          totalSupply: Number(p.totalSupply) ?? 0,
          sourceRaw: p.sourceRaw,
        };
      }
      return null;
    } catch (err) {
      logger.warn({ err, key }, "Redis cache get failed; falling back to direct fetch");
      return null;
    }
  }

  /** Stores in Redis with EX 300. No-op on error (fail-safe). */
  private async setCached(provider: MarketProvider, tokenId: string, data: UnifiedMarketResult): Promise<void> {
    const redis = getRedisClient();
    if (!redis) return;
    const key = `${CACHE_KEY_PREFIX}${provider}:${tokenId}`;
    try {
      await redis.set(key, JSON.stringify(data), "EX", CACHE_TTL_SEC);
    } catch (err) {
      logger.warn({ err, key }, "Redis cache set failed");
    }
  }

  /**
   * Fetches market data: tries CoinGecko first, then CoinPaprika. Uses 5-min cache per provider+id.
   * Validates ids with ^[a-z0-9-]+$. On 429 retries with backoff. Throws InvalidTokenIdError (400),
   * or MarketUnavailableError (503) when both providers fail.
   */
  async getMarketData(
    coingeckoId?: string,
    paprikaId?: string
  ): Promise<UnifiedMarketResult> {
    const cgId = coingeckoId?.trim();
    const papId = paprikaId?.trim();

    if (cgId && (await isProviderHealthy("coingecko"))) {
      this.validateTokenId(cgId);
      const cached = await this.getCached("coingecko", cgId);
      if (cached) return cached;
      try {
        const result = await this.retryWithBackoff(
          () => this.fetchFromCoinGecko(cgId),
          "coingecko"
        );
        await recordSuccess("coingecko");
        await this.setCached("coingecko", cgId, result);
        return result;
      } catch {
        // fall through to Paprika
      }
    }

    if (papId && (await isProviderHealthy("paprika"))) {
      this.validateTokenId(papId);
      const cached = await this.getCached("paprika", papId);
      if (cached) return cached;
      try {
        const result = await this.retryWithBackoff(
          () => this.fetchFromCoinPaprika(papId),
          "paprika"
        );
        await recordSuccess("paprika");
        await this.setCached("paprika", papId, result);
        return result;
      } catch {
        // fall through to 503
      }
    }

    throw new MarketUnavailableError();
  }
}
