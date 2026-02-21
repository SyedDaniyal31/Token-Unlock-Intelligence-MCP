/**
 * Unified market cache: Redis when REDIS_URL is set, with in-memory fallback on error or missing Redis.
 * Same interface as before; get/set are now async. TTL 5 minutes.
 */

import type { NormalizedMarket } from "./CoinGeckoProvider.js";
import * as RedisCache from "./RedisMarketCache.js";
import { getRedisClient } from "../infrastructure/cache/RedisClient.js";
import logger from "../core/logger.js";

const TTL_MS = 300_000; // 5 minutes

interface CacheEntry {
  data: NormalizedMarket;
  expiresAt: number;
}

const memory = new Map<string, CacheEntry>();

function getFromMemory(key: string): NormalizedMarket | null {
  const entry = memory.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    memory.delete(key);
    return null;
  }
  return entry.data;
}

function setMemory(key: string, data: NormalizedMarket): void {
  memory.set(key, {
    data,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Gets from Redis when available; on error or miss falls back to in-memory. Never throws.
 */
export async function getFromCache(key: string): Promise<NormalizedMarket | null> {
  if (getRedisClient()) {
    try {
      const v = await RedisCache.getFromCache(key);
      if (v != null) return v;
    } catch (err) {
      logger.warn({ err, key }, "Redis cache get failed; using in-memory");
    }
  }
  return getFromMemory(key);
}

/**
 * Writes to Redis when available (errors logged, not thrown); always writes to in-memory backup.
 */
export async function setCache(key: string, data: NormalizedMarket): Promise<void> {
  if (getRedisClient()) {
    try {
      await RedisCache.setCache(key, data);
    } catch (err) {
      logger.warn({ err, key }, "Redis cache set failed; using in-memory only");
    }
  }
  setMemory(key, data);
}
