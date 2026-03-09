/**
 * Provider-based unlock engine: ManualRegistry → TokenUnlocks → DefiLlama → Messari → Mobula → DocsProvider.
 * Returns early only when a provider returns success with events. Rate limits (429, "rate limit",
 * "too many requests") are treated as temporary failures and the chain continues to the next provider;
 * DocsProvider always runs as final fallback. 12h cache (Redis when REDIS_URL set, else in-memory).
 */

import type { AssetMetadata } from "../core/assetResolver.js";
import type { UnlockFetchResult, UnlockProvider } from "./providers/UnlockProvider.js";
import { manualRegistryProvider } from "./providers/ManualRegistryProvider.js";
import { tokenUnlocksProvider } from "./providers/TokenUnlocksProvider.js";
import { defiLlamaProvider } from "./providers/DefiLlamaProvider.js";
import { messariProvider } from "./providers/MessariProvider.js";
import { mobulaProvider } from "./providers/MobulaProvider.js";
import { docsProvider } from "./providers/DocsProvider.js";
import { getRedisClient } from "../infrastructure/cache/RedisClient.js";
import logger from "../core/logger.js";

/** Priority order: ManualRegistry → TokenUnlocks → DefiLlama → Messari → Mobula → DocsProvider. */
const providers: UnlockProvider[] = [
  manualRegistryProvider,
  tokenUnlocksProvider,
  defiLlamaProvider,
  messariProvider,
  mobulaProvider,
  docsProvider,
];

const UNLOCK_CACHE_TTL_SEC = 12 * 60 * 60; // 12 hours
const UNLOCK_CACHE_TTL_MS = UNLOCK_CACHE_TTL_SEC * 1000;
const UNLOCK_CACHE_MAX_ENTRIES = 500;

interface UnlockCacheEntry {
  result: UnlockFetchResult;
  expiresAt: number;
}

const unlockCache = new Map<string, UnlockCacheEntry>();
const unlockCacheKeyOrder: string[] = [];

const REDIS_KEY_PREFIX = "unlock:";

function cacheKey(asset: AssetMetadata): string {
  return `${asset.chain}:${asset.symbol.trim().toUpperCase()}`;
}

function serializeResult(r: UnlockFetchResult): string {
  return JSON.stringify({
    success: r.success,
    source: r.source,
    events: r.events,
    next_unlock_timestamp: r.next_unlock_timestamp ?? null,
    confidence_score: r.confidence_score ?? null,
  });
}

function deserializeResult(json: string): UnlockFetchResult | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const events = Array.isArray(o.events) ? o.events : [];
    return {
      success: Boolean(o.success),
      source: typeof o.source === "string" ? o.source : "none",
      events: events.map((e: Record<string, unknown>) => ({
        token_symbol: String(e.token_symbol ?? ""),
        unlock_timestamp: Number(e.unlock_timestamp) || 0,
        unlock_amount: Number(e.unlock_amount) || 0,
        unlock_percent: e.unlock_percent != null ? Number(e.unlock_percent) : undefined,
        source: String(e.source ?? ""),
      })),
      next_unlock_timestamp: o.next_unlock_timestamp != null ? Number(o.next_unlock_timestamp) : null,
      confidence_score: o.confidence_score != null ? Number(o.confidence_score) : undefined,
    };
  } catch {
    return null;
  }
}

async function getCachedUnlockRedis(key: string): Promise<UnlockFetchResult | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(REDIS_KEY_PREFIX + key);
    if (raw == null) return null;
    return deserializeResult(raw);
  } catch {
    return null;
  }
}

function setCachedUnlockRedis(key: string, result: UnlockFetchResult): void {
  if (result.rate_limited === true) return;
  const redis = getRedisClient();
  if (!redis) return;
  const serialized = serializeResult(result);
  redis.setex(REDIS_KEY_PREFIX + key, UNLOCK_CACHE_TTL_SEC, serialized).catch(() => {});
}

function getCachedUnlock(key: string): UnlockFetchResult | null {
  const entry = unlockCache.get(key);
  if (entry == null || Date.now() >= entry.expiresAt) return null;
  return structuredClone(entry.result);
}

function setCachedUnlock(key: string, result: UnlockFetchResult): void {
  if (result.rate_limited === true) return;
  while (unlockCacheKeyOrder.length >= UNLOCK_CACHE_MAX_ENTRIES && unlockCacheKeyOrder.length > 0) {
    const evict = unlockCacheKeyOrder.shift();
    if (evict != null) unlockCache.delete(evict);
  }
  unlockCache.set(key, {
    result: structuredClone(result),
    expiresAt: Date.now() + UNLOCK_CACHE_TTL_MS,
  });
  if (!unlockCacheKeyOrder.includes(key)) unlockCacheKeyOrder.push(key);
}

function filterFutureAndSort(events: UnlockFetchResult["events"], nowSec: number): UnlockFetchResult["events"] {
  return events
    .filter((e) => e.unlock_timestamp > nowSec)
    .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
}

/** True when the result indicates a rate limit (temporary); treat as skip and continue to next provider. */
function isRateLimited(result: UnlockFetchResult): boolean {
  if (result.rate_limited === true) return true;
  const err = (result.error ?? "").toLowerCase();
  return (
    err.includes("rate limit") ||
    err.includes("429") ||
    err.includes("too many requests")
  );
}

/**
 * Resolve unlock data: 12h cache (Redis then in-memory), then providers in order.
 * Only returns early when a provider returns success with events. Rate limits are
 * treated as temporary failures and the chain continues (DocsProvider always runs as final fallback).
 */
export async function resolveUnlockData(asset: AssetMetadata): Promise<UnlockFetchResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const key = cacheKey(asset);

  const fromRedis = await getCachedUnlockRedis(key);
  if (fromRedis != null) return fromRedis;

  const fromMemory = getCachedUnlock(key);
  if (fromMemory != null) return fromMemory;

  let lastResult: UnlockFetchResult | null = null;
  try {
    for (const provider of providers) {
      if (!provider.supports(asset)) continue;

      const result = await provider.fetchUnlocks(asset);
      lastResult = result;

      if (result.success && result.events.length > 0) {
        const future = filterFutureAndSort(result.events, nowSec);
        const eventsToUse = future.length > 0 ? future : result.events;
        const nextTs = future.length > 0 ? future[0].unlock_timestamp : null;
        if (result.source === "ManualRegistry") {
          logger.info({ symbol: asset.symbol, futureCount: future.length, totalCount: result.events.length }, "MANUAL_REGISTRY_HIT");
        }
        const out: UnlockFetchResult = {
          success: true,
          source: result.source,
          events: eventsToUse,
          next_unlock_timestamp: nextTs,
          confidence_score: result.confidence_score,
        };
        setCachedUnlock(key, out);
        setCachedUnlockRedis(key, out);
        return out;
      }

      if (isRateLimited(result)) {
        logger.info(
          { symbol: asset.symbol, provider: provider.name, error: result.error },
          "providerRateLimited"
        );
        continue;
      }
    }
  } catch {
    // safe fallback
  }

  const noData: UnlockFetchResult = {
    success: false,
    source: lastResult?.source ?? "none",
    events: [],
    next_unlock_timestamp: null,
    confidence_score: 0,
    error: lastResult?.source === "DocsProvider" ? lastResult.error : undefined,
  };
  setCachedUnlock(key, noData);
  setCachedUnlockRedis(key, noData);
  return noData;
}
