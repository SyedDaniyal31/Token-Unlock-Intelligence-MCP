/**
 * Provider health state: after 5 failures, disable provider for 2 minutes (circuit breaker).
 * When Redis is available, uses INCR + EXPIRE for atomic failure counting and disable TTL
 * so health state is consistent across instances without read-modify-write races.
 */

import { getRedisClient } from "../infrastructure/cache/RedisClient.js";
import logger from "../core/logger.js";

export type ProviderName = "coingecko" | "paprika";

export interface ProviderState {
  failures: number;
  disabledUntil: number | null;
}

const DISABLE_SEC = 2 * 60; // 2 minutes for Redis EXPIRE
const FAILURE_THRESHOLD = 5;
const REDIS_KEY_PREFIX = "provider_health:";
const REDIS_DISABLED_SUFFIX = ":disabled";

const providerHealth: Record<ProviderName, ProviderState> = {
  coingecko: { failures: 0, disabledUntil: null },
  paprika: { failures: 0, disabledUntil: null },
};

function failuresKey(provider: ProviderName): string {
  return REDIS_KEY_PREFIX + provider + ":failures";
}

function disabledKey(provider: ProviderName): string {
  return REDIS_KEY_PREFIX + provider + REDIS_DISABLED_SUFFIX;
}

/** When Redis is used: INCR failures, then if >= threshold set disabled key with EXPIRE and reset failures. */
export async function isProviderHealthy(provider: ProviderName): Promise<boolean> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const exists = await redis.exists(disabledKey(provider));
      return exists === 0;
    } catch (err) {
      logger.warn({ err, provider }, "Redis provider health check failed; using in-memory");
    }
  }
  const state = providerHealth[provider];
  if (state.disabledUntil != null && Date.now() < state.disabledUntil) return false;
  if (state.disabledUntil != null) state.disabledUntil = null;
  return true;
}

/** Atomic: INCR failures; if count >= threshold, SET disabled EX DISABLE_SEC and SET failures 0. */
export async function recordFailure(provider: ProviderName): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = failuresKey(provider);
      const count = await redis.incr(key);
      if (count >= FAILURE_THRESHOLD) {
        await redis.set(disabledKey(provider), "1", "EX", DISABLE_SEC);
        await redis.set(key, "0");
      }
      return;
    } catch (err) {
      logger.warn({ err, provider }, "Redis provider health recordFailure failed; using in-memory");
    }
  }
  const state = providerHealth[provider];
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) {
    state.disabledUntil = Date.now() + DISABLE_SEC * 1000;
    state.failures = 0;
  }
}

/** Reset failure count so circuit can recover. */
export async function recordSuccess(provider: ProviderName): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(failuresKey(provider), "0");
      return;
    } catch (err) {
      logger.warn({ err, provider }, "Redis provider health recordSuccess failed; using in-memory");
    }
  }
  providerHealth[provider].failures = 0;
}
