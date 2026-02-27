/**
 * DeFiLlama liquidity adapter. 3s timeout, no throws, deterministic.
 */

const REQUEST_TIMEOUT_MS = 3000;

export interface DefiLlamaLiquidityData {
  liquidityUsd: number | null;
}

async function safeFetchJson<T>(url: string, timeoutMs: number): Promise<T | null> {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);

    if (!res.ok) return null;

    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function toFinite(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch liquidity (volume * price) for a token from DeFiLlama. Returns null on failure.
 */
export async function fetchDefiLlamaLiquidity(
  chain: "ethereum" | "bsc" | "arbitrum" | "base",
  address: string
): Promise<DefiLlamaLiquidityData | null> {
  const addr = (address.startsWith("0x") ? address : "0x" + address).toLowerCase();
  const key = `${chain}:${addr}`;
  const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(key)}`;

  const raw = await safeFetchJson<{
    coins?: Record<string, { price?: unknown; volume?: unknown }>;
  }>(url, REQUEST_TIMEOUT_MS);

  if (raw == null || typeof raw !== "object" || raw.coins == null || typeof raw.coins !== "object") {
    return null;
  }

  const coin = raw.coins[key];
  if (coin == null || typeof coin !== "object") return null;

  const price = toFinite(coin.price);
  const volume = toFinite(coin.volume);
  if (price == null || volume == null || price <= 0) return null;

  const liquidityUsd = volume * price;
  if (!Number.isFinite(liquidityUsd) || liquidityUsd < 0) return null;

  return { liquidityUsd };
}
