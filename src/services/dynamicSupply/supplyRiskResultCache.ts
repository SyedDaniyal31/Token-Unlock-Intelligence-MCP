/**
 * Deterministic result cache for supply risk analysis.
 * Stable cache key from request params; TTL 5–15 min. Identical input → identical output during TTL.
 */

const TTL_MS_MIN = 5 * 60 * 1000;
const TTL_MS_MAX = 15 * 60 * 1000;
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 300;

interface CacheEntry<T> {
  value: T;
  expiry: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function stableStringify(obj: unknown): string {
  if (obj === null) return "null";
  if (obj === undefined) return "undefined";
  if (typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((obj as Record<string, unknown>)[k])).join(",") + "}";
}

/**
 * Canonical params for cache key: only fields that affect the result.
 */
export interface SupplyRiskCacheParams {
  token_symbol: string;
  token_address?: string;
  chain?: string;
  timeframe_days?: number;
  simulation_params?: { price_shock_pct?: number; volume_shock_pct?: number; unlock_multiplier?: number };
}

export function canonicalCacheKey(params: SupplyRiskCacheParams): string {
  const canonical = {
    token_symbol: (params.token_symbol ?? "").trim().toUpperCase(),
    token_address: (params.token_address ?? "").trim().toLowerCase(),
    chain: (params.chain ?? "").toLowerCase(),
    timeframe_days: typeof params.timeframe_days === "number" && Number.isFinite(params.timeframe_days) ? params.timeframe_days : undefined,
    simulation_params:
      params.simulation_params && Object.keys(params.simulation_params).length > 0
        ? params.simulation_params
        : undefined,
  };
  return stableStringify(canonical);
}

/**
 * Get cached result if key exists and not expired. Returns undefined on miss.
 */
export function getCachedResult<T>(key: string): T | undefined {
  const entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry || Date.now() > entry.expiry) {
    if (entry) cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store result with TTL. Evicts oldest if at capacity (simple FIFO on first key).
 */
export function setCachedResult<T>(key: string, value: T, ttlMs: number = TTL_MS): void {
  const ttl = Math.max(TTL_MS_MIN, Math.min(TTL_MS_MAX, ttlMs));
  if (cache.size >= MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key, { value, expiry: Date.now() + ttl });
}
