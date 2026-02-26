/**
 * Tokenomist Pro API unlock provider. Authoritative unlock calendar.
 * Uses: Token List (resolve tokenID), Unlock Events v4, Daily Emission v2.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

const BASE_URL = "https://api.unlocks.app";
const TOKEN_LIST_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RESULT_MEMO_TTL_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_DELAY_MS = 500;

interface TokenListItem {
  id?: string;
  symbol?: string;
  name?: string;
  [key: string]: unknown;
}

const tokenListCache: { data: Map<string, string>; byName: Map<string, string>; expiresAt: number } = {
  data: new Map(),
  byName: new Map(),
  expiresAt: 0,
};

const resultMemo = new Map<string, { result: UnlockFetchResult; expiresAt: number }>();

function getApiKey(): string | null {
  const key = process.env.TOKENOMIST_API_KEY;
  return key && String(key).trim() ? String(key).trim() : null;
}

function parseUnixSeconds(isoOrNum: unknown): number | null {
  if (isoOrNum == null) return null;
  if (typeof isoOrNum === "number" && Number.isFinite(isoOrNum)) {
    return isoOrNum > 1e12 ? Math.floor(isoOrNum / 1000) : Math.floor(isoOrNum);
  }
  if (typeof isoOrNum === "string") {
    const t = Date.parse(isoOrNum);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  }
  return null;
}

async function fetchWithRetry(
  url: string,
  apiKey: string,
  retried = false
): Promise<Response> {
  const res = await fetch(url, {
    headers: { "x-api-key": apiKey },
  });
  if (res.status === 429 && !retried) {
    logger.warn("TOKENOMIST_RATE_LIMITED");
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return fetchWithRetry(url, apiKey, true);
  }
  return res;
}

async function getTokenList(apiKey: string): Promise<{ bySymbol: Map<string, string>; byName: Map<string, string> }> {
  const now = Date.now();
  if (now < tokenListCache.expiresAt) {
    return { bySymbol: tokenListCache.data, byName: tokenListCache.byName };
  }
  const res = await fetchWithRetry(`${BASE_URL}/v1/token/list`, apiKey);
  if (!res.ok) {
    tokenListCache.expiresAt = now + 60_000;
    return { bySymbol: new Map(), byName: new Map() };
  }
  const json = (await res.json()) as { data?: TokenListItem[]; [key: string]: unknown };
  const list: TokenListItem[] = Array.isArray(json?.data) ? json.data : [];
  const bySymbol = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const item of list) {
    const id = item?.id ?? item?.tokenId;
    if (typeof id !== "string" || !id) continue;
    const symbol = typeof item.symbol === "string" ? item.symbol.trim().toUpperCase() : "";
    const name = typeof item.name === "string" ? item.name.trim().toLowerCase() : "";
    if (symbol) bySymbol.set(symbol.toLowerCase(), id);
    if (name) byName.set(name, id);
  }
  tokenListCache.data = bySymbol;
  tokenListCache.byName = byName;
  tokenListCache.expiresAt = now + TOKEN_LIST_TTL_MS;
  return { bySymbol, byName };
}

function resolveTokenId(
  asset: AssetMetadata,
  bySymbol: Map<string, string>,
  byName: Map<string, string>
): string | null {
  const sym = asset.symbol.trim();
  const idBySymbol = sym ? bySymbol.get(sym.toLowerCase()) : null;
  if (idBySymbol) return idBySymbol;
  const nameLower = sym.toLowerCase();
  return byName.get(nameLower) ?? null;
}

export class TokenomistProvider implements UnlockProvider {
  readonly name = "Tokenomist";

  supports(asset: AssetMetadata): boolean {
    return !!getApiKey();
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, source: "Tokenomist", events: [], error: "no_api_key" };
    }

    const memoKey = `tokenomist:${asset.chain}:${asset.symbol.trim().toUpperCase()}`;
    const memo = resultMemo.get(memoKey);
    if (memo && Date.now() < memo.expiresAt) {
      return structuredClone(memo.result);
    }

    logger.info({ symbol: asset.symbol }, "TOKENOMIST_FETCH_START");

    try {
      const { bySymbol, byName } = await getTokenList(apiKey);
      const tokenId = resolveTokenId(asset, bySymbol, byName);
      if (!tokenId) {
        logger.info({ symbol: asset.symbol }, "TOKENOMIST_FETCH_EMPTY");
        const out: UnlockFetchResult = {
          success: false,
          source: "Tokenomist",
          events: [],
          error: "token_not_in_list",
        };
        resultMemo.set(memoKey, { result: out, expiresAt: Date.now() + RESULT_MEMO_TTL_MS });
        return out;
      }

      const eventsUrl = `${BASE_URL}/v4/unlock/events?tokenId=${encodeURIComponent(tokenId)}`;
      const eventsRes = await fetchWithRetry(eventsUrl, apiKey);
      if (eventsRes.status === 429) {
        return {
          success: false,
          source: "Tokenomist",
          events: [],
          error: "rate_limited",
          rate_limited: true,
        };
      }

      if (!eventsRes.ok) {
        logger.warn({ symbol: asset.symbol, status: eventsRes.status }, "TOKENOMIST_FETCH_FAILED");
        const out: UnlockFetchResult = {
          success: false,
          source: "Tokenomist",
          events: [],
          error: `status_${eventsRes.status}`,
        };
        return out;
      }

      const eventsJson = (await eventsRes.json()) as {
        data?: Array<{
          unlockDate?: string;
          cliffUnlocks?: { cliffAmount?: number };
          [key: string]: unknown;
        }>;
        [key: string]: unknown;
      };
      const dataArr = Array.isArray(eventsJson?.data) ? eventsJson.data : [];
      const nowSec = Math.floor(Date.now() / 1000);
      const symbol = asset.symbol.trim().toUpperCase();
      const events: NormalizedUnlockEvent[] = [];

      for (const row of dataArr) {
        const ts = parseUnixSeconds(row?.unlockDate);
        if (ts == null || ts <= nowSec) continue;
        const amount = Number(row?.cliffUnlocks?.cliffAmount ?? 0);
        if (!Number.isFinite(amount) || amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "Tokenomist",
        });
      }

      const sorted = events
        .filter((e) => e.unlock_timestamp > nowSec)
        .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

      let daily_emission_series: number[] | undefined;
      let next_30d_emission_total: number | undefined;
      let next_90d_emission_total: number | undefined;

      try {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 90);
        const emissionUrl = `${BASE_URL}/v2/daily-emission?tokenId=${encodeURIComponent(tokenId)}&start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}`;
        const emissionRes = await fetchWithRetry(emissionUrl, apiKey);
        if (emissionRes.ok) {
          const emissionJson = (await emissionRes.json()) as {
            data?: Array<{ amount?: number; value?: number; [key: string]: unknown }>;
            [key: string]: unknown;
          };
          const series = Array.isArray(emissionJson?.data)
            ? emissionJson.data.map((d) => Number(d?.amount ?? d?.value ?? 0)).filter(Number.isFinite)
            : [];
          if (series.length > 0) {
            daily_emission_series = series;
            const len = series.length;
            next_30d_emission_total = series.slice(-Math.min(30, len)).reduce((a, b) => a + b, 0);
            next_90d_emission_total = len >= 90 ? series.slice(-90).reduce((a, b) => a + b, 0) : series.reduce((a, b) => a + b, 0);
          }
        }
      } catch {
        // optional emission data; do not fail
      }

      const result: UnlockFetchResult = {
        success: true,
        source: "Tokenomist",
        events: sorted,
        next_unlock_timestamp: sorted.length > 0 ? sorted[0].unlock_timestamp : null,
        confidence_score: 0.95,
        daily_emission_series,
        next_30d_emission_total,
        next_90d_emission_total,
      };

      if (sorted.length === 0) {
        logger.info({ symbol: asset.symbol }, "TOKENOMIST_FETCH_EMPTY");
      } else {
        logger.info({ symbol: asset.symbol, eventsCount: sorted.length }, "TOKENOMIST_FETCH_SUCCESS");
      }

      resultMemo.set(memoKey, { result, expiresAt: Date.now() + RESULT_MEMO_TTL_MS });
      return result;
    } catch (err) {
      logger.warn(
        { symbol: asset.symbol, err: err instanceof Error ? err.message : String(err) },
        "TOKENOMIST_FETCH_FAILED"
      );
      return {
        success: false,
        source: "Tokenomist",
        events: [],
        error: "exception",
      };
    }
  }
}

export const tokenomistProvider = new TokenomistProvider();
