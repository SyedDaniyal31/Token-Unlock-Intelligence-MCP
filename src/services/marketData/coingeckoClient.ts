/**
 * CoinGecko market data adapter. Safe fetch, 3s timeout, deterministic, no throws.
 */

const REQUEST_TIMEOUT_MS = 3000;
const COIN_LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface CoinGeckoMarketData {
  address: string | null;
  circulatingSupply: number | null;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  priceUsd: number | null;
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

let coinListCache: { data: Map<string, string[]>; expires: number } | null = null;

interface CoinListItem {
  id?: string;
  symbol?: string;
}

async function getCoinGeckoIdBySymbol(symbol: string): Promise<string[] | null> {
  const now = Date.now();
  if (coinListCache != null && now < coinListCache.expires) {
    const ids = coinListCache.data.get(symbol.toLowerCase().trim());
    return ids ?? null;
  }

  const list = await safeFetchJson<CoinListItem[]>(
    "https://api.coingecko.com/api/v3/coins/list",
    REQUEST_TIMEOUT_MS
  );
  if (!Array.isArray(list)) return null;

  const data = new Map<string, string[]>();
  for (const item of list) {
    const sym = item.symbol != null ? String(item.symbol).toLowerCase().trim() : "";
    const id = item.id != null ? String(item.id) : "";
    if (sym !== "" && id !== "") {
      const arr = data.get(sym) ?? [];
      arr.push(id);
      data.set(sym, arr);
    }
  }
  coinListCache = { data, expires: now + COIN_LIST_CACHE_TTL_MS };
  const ids = data.get(symbol.toLowerCase().trim());
  return ids ?? null;
}

const COINGECKO_CHAIN_KEYS: Record<string, string> = {
  ethereum: "ethereum",
  bsc: "binance-smart-chain",
  arbitrum: "arbitrum-one",
};

interface CoinDetailForRank {
  id: string;
  platforms?: Record<string, unknown>;
  market_data?: {
    market_cap?: { usd?: unknown };
    total_volume?: { usd?: unknown };
  };
}

function hasSupportedChainMatch(platforms: unknown, supportedChains: ("ethereum" | "bsc" | "arbitrum")[]): boolean {
  if (platforms == null || typeof platforms !== "object") return false;
  const obj = platforms as Record<string, unknown>;
  for (const chain of supportedChains) {
    const key = COINGECKO_CHAIN_KEYS[chain] ?? chain;
    const v = obj[key];
    if (typeof v === "string" && v.trim() !== "") return true;
  }
  return false;
}

function toFiniteForRank(x: unknown): number {
  if (typeof x === "number" && Number.isFinite(x) && x >= 0) return x;
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const MAX_CANDIDATES_EVALUATE = 5;

async function resolveBestCoinGeckoId(
  symbol: string,
  supportedChains: ("ethereum" | "bsc" | "arbitrum")[]
): Promise<string | null> {
  const candidates = await getCoinGeckoIdBySymbol(symbol);
  if (candidates == null || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sorted = [...candidates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const toEvaluate = sorted.slice(0, MAX_CANDIDATES_EVALUATE);

  const results: Array<{ id: string; supportedMatch: boolean; marketCap: number; volume: number }> = [];
  for (const id of toEvaluate) {
    const raw = await safeFetchJson<CoinDetailForRank>(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}`,
      REQUEST_TIMEOUT_MS
    );
    if (raw == null || typeof raw !== "object") {
      results.push({ id, supportedMatch: false, marketCap: 0, volume: 0 });
      continue;
    }
    const supportedMatch = hasSupportedChainMatch(raw.platforms, supportedChains);
    const md = raw.market_data;
    const marketCap =
      md != null && typeof md === "object" && md.market_cap != null && typeof md.market_cap === "object"
        ? toFiniteForRank((md.market_cap as { usd?: unknown }).usd)
        : 0;
    const volume =
      md != null && typeof md === "object" && md.total_volume != null && typeof md.total_volume === "object"
        ? toFiniteForRank((md.total_volume as { usd?: unknown }).usd)
        : 0;
    results.push({ id, supportedMatch, marketCap, volume });
  }

  results.sort((a, b) => {
    if (a.supportedMatch !== b.supportedMatch) return a.supportedMatch ? -1 : 1;
    if (a.marketCap !== b.marketCap) return b.marketCap - a.marketCap;
    if (a.volume !== b.volume) return b.volume - a.volume;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const best = results[0];
  return best != null ? best.id : sorted[0];
}

function toFiniteNumber(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function firstPlatformAddress(platforms: unknown): string | null {
  if (platforms == null || typeof platforms !== "object") return null;
  const obj = platforms as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return null;
}

export async function fetchCoinGeckoData(symbol: string): Promise<CoinGeckoMarketData | null> {
  const id = await resolveBestCoinGeckoId(symbol, ["ethereum", "bsc", "arbitrum"]);
  if (id == null || id === "") return null;

  const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}`;
  const raw = await safeFetchJson<{
    platforms?: Record<string, unknown>;
    market_data?: {
      circulating_supply?: unknown;
      market_cap?: { usd?: unknown };
      total_volume?: { usd?: unknown };
      current_price?: { usd?: unknown };
    };
  }>(url, REQUEST_TIMEOUT_MS);

  if (raw == null || typeof raw !== "object") return null;

  const md = raw.market_data;
  if (md == null || typeof md !== "object") return null;

  const circulatingSupply = toFiniteNumber(md.circulating_supply);
  const marketCapUsd = md.market_cap != null && typeof md.market_cap === "object"
    ? toFiniteNumber((md.market_cap as { usd?: unknown }).usd)
    : null;
  const volume24hUsd = md.total_volume != null && typeof md.total_volume === "object"
    ? toFiniteNumber((md.total_volume as { usd?: unknown }).usd)
    : null;
  const priceUsd = md.current_price != null && typeof md.current_price === "object"
    ? toFiniteNumber((md.current_price as { usd?: unknown }).usd)
    : null;

  const address = firstPlatformAddress(raw.platforms);

  return {
    address,
    circulatingSupply,
    marketCapUsd,
    volume24hUsd,
    priceUsd,
  };
}
