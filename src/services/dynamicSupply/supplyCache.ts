/**
 * In-memory cache for supply snapshots. TTL 15 minutes.
 * Returns snapshot and timestamp for data freshness reporting.
 */

export interface SupplySnapshot {
  totalSupply: number;
  decimals: number;
}

export interface SupplyCacheEntry {
  data: SupplySnapshot;
  /** Unix seconds when snapshot was stored. */
  timestamp: number;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map<string, SupplyCacheEntry>();

function key(tokenAddress: string, chain: string): string {
  return `${chain}:${(tokenAddress || "").toLowerCase()}`;
}

export function getSupplyFromCache(tokenAddress: string, chain: string): SupplySnapshot | null {
  const e = cache.get(key(tokenAddress, chain));
  if (!e || Date.now() - e.timestamp * 1000 > TTL_MS) return null;
  return e.data;
}

/** Returns cached snapshot and its Unix-second timestamp if within TTL; null otherwise. */
export function getSupplyFromCacheWithTimestamp(
  tokenAddress: string,
  chain: string
): SupplyCacheEntry | null {
  const e = cache.get(key(tokenAddress, chain));
  if (!e || Date.now() - e.timestamp * 1000 > TTL_MS) return null;
  return e;
}

export function setSupplyInCache(
  tokenAddress: string,
  chain: string,
  data: SupplySnapshot
): void {
  if (cache.size >= MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  cache.set(key(tokenAddress, chain), { data, timestamp: Math.floor(Date.now() / 1000) });
}
