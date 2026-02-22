/**
 * In-memory cache for supply snapshots. TTL 15 minutes.
 */

export interface SupplySnapshot {
  totalSupply: number;
  decimals: number;
}

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 500;

interface Entry {
  data: SupplySnapshot;
  ts: number;
}

const cache = new Map<string, Entry>();

function key(tokenAddress: string, chain: string): string {
  return `${chain}:${(tokenAddress || "").toLowerCase()}`;
}

export function getSupplyFromCache(tokenAddress: string, chain: string): SupplySnapshot | null {
  const e = cache.get(key(tokenAddress, chain));
  if (!e || Date.now() - e.ts > TTL_MS) return null;
  return e.data;
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
  cache.set(key(tokenAddress, chain), { data, ts: Date.now() });
}
