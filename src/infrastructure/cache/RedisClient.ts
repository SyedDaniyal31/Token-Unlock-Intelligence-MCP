/**
 * Redis client for distributed cache. Uses REDIS_URL from env.
 * When REDIS_URL is missing, client is null and callers fall back to in-memory.
 */

import Redis from "ioredis";
import logger from "../../core/logger.js";

let client: Redis | null = null;
let initDone = false;

function getRedisUrl(): string | undefined {
  const url = process.env.REDIS_URL;
  return typeof url === "string" && url.trim().length > 0 ? url.trim() : undefined;
}

/**
 * Returns a Redis client when REDIS_URL is set; otherwise null.
 * Logs a warning once when REDIS_URL is missing. Never throws.
 */
export function getRedisClient(): Redis | null {
  if (initDone) return client;
  initDone = true;
  const url = getRedisUrl();
  if (!url) {
    logger.warn("REDIS_URL not set; using in-memory cache only");
    return null;
  }
  try {
    client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times <= 3) return Math.min(times * 500, 2000);
        return null;
      },
      lazyConnect: true,
    });
    client.on("error", (err) => {
      logger.warn({ err }, "Redis connection error");
    });
  } catch (err) {
    logger.warn({ err }, "Redis init failed; using in-memory cache");
    client = null;
  }
  return client;
}
