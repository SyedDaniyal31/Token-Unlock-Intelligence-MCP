/**
 * Provider-based unlock engine: runs providers in order; first success with events wins.
 * Deterministic; safe fallback when no provider returns data.
 * Phase 1B: per-symbol (chain:symbol) in-memory cache, 90s TTL, to avoid redundant DefiLlama calls.
 */

import type { AssetMetadata } from "../core/assetResolver.js";
import type { UnlockFetchResult, UnlockProvider } from "./providers/UnlockProvider.js";
import { defiLlamaProvider } from "./providers/DefiLlamaProvider.js";
import { manualRegistryProvider } from "./providers/ManualRegistryProvider.js";

const providers: UnlockProvider[] = [defiLlamaProvider, manualRegistryProvider];

const UNLOCK_CACHE_TTL_MS = 90_000;
const UNLOCK_CACHE_MAX_ENTRIES = 200;

interface UnlockCacheEntry {
  result: UnlockFetchResult;
  expiresAt: number;
}

const unlockCache = new Map<string, UnlockCacheEntry>();
const unlockCacheKeyOrder: string[] = [];

function cacheKey(asset: AssetMetadata): string {
  return `${asset.chain}:${asset.symbol.trim().toUpperCase()}`;
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

/**
 * Resolve unlock data from the first provider that supports the asset and returns events.
 * Never throws; returns { success: false, source: "none", events: [], next_unlock_timestamp: null } when no data.
 * Uses in-memory cache (chain:symbol, 90s TTL) to avoid redundant provider calls within a short window.
 */
export async function resolveUnlockData(asset: AssetMetadata): Promise<UnlockFetchResult> {
  const nowSec = Math.floor(Date.now() / 1000);
  const key = cacheKey(asset);

  const cached = getCachedUnlock(key);
  if (cached != null) return cached;

  try {
    for (const provider of providers) {
      if (!provider.supports(asset)) continue;

      const result = await provider.fetchUnlocks(asset);

      if (result.rate_limited === true) return result;

      if (result.success && result.events.length > 0) {
        const future = filterFutureAndSort(result.events, nowSec);
        if (future.length === 0) continue;
        const out: UnlockFetchResult = {
          success: true,
          source: result.source,
          events: future,
          next_unlock_timestamp: future[0]?.unlock_timestamp ?? null,
          confidence_score: result.confidence_score,
        };
        setCachedUnlock(key, out);
        return out;
      }
    }
  } catch {
    // safe fallback
  }

  const noData: UnlockFetchResult = {
    success: false,
    source: "none",
    events: [],
    next_unlock_timestamp: null,
    confidence_score: 0,
  };
  setCachedUnlock(key, noData);
  return noData;
}
