/**
 * Redis-backed market cache. Same logical interface as in-memory cache (async).
 * Uses SET key value EX 300. On Redis errors, logs and returns null / no-op; no throw.
 */

import type { NormalizedMarket } from "./CoinGeckoProvider.js";
import { getRedisClient } from "../infrastructure/cache/RedisClient.js";
import logger from "../core/logger.js";

const TTL_SEC = 300; // 5 minutes

export async function getFromCache(key: string): Promise<NormalizedMarket | null> {
  const redis = getRedisClient();
  if (!redis) return null;
  try {
    const raw = await redis.get(key);
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as NormalizedMarket;
    if (
      typeof parsed?.price !== "number" ||
      typeof parsed?.marketCap !== "number" ||
      typeof parsed?.volume24h !== "number" ||
      typeof parsed?.circulatingSupply !== "number"
    ) {
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn({ err, key }, "Redis market cache get failed");
    return null;
  }
}

export async function setCache(key: string, value: NormalizedMarket): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;
  try {
    const serialized = JSON.stringify(value);
    await redis.set(key, serialized, "EX", TTL_SEC);
  } catch (err) {
    logger.warn({ err, key }, "Redis market cache set failed");
  }
}
