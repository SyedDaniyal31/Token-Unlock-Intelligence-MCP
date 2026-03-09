/**
 * TokenUnlocks / Tokenomist (api.unlocks.app) unlock provider.
 * Uses Token List API v2 to resolve symbol -> tokenId, then Unlock Events API v4 for cliff unlocks.
 * Priority source when TOKENUNLOCKS_API_KEY is set.
 */

import { config } from "../../core/config.js";
import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

const BASE_URL = "https://api.unlocks.app";
const TOKEN_LIST_PATH = "/v2/token/list";
const UNLOCK_EVENTS_PATH = "/v4/unlock/events";
const MEMO_TTL_MS = 60 * 60 * 1000; // 1 hour for token list
const FETCH_TIMEOUT_MS = 10_000;

interface TokenListEntry {
  id: string;
  symbol?: string;
  name?: string;
}

interface UnlockEventItem {
  unlockDate?: string;
  cliffUnlocks?: {
    cliffAmount?: number;
    allocationBreakdown?: Array<{ unlockDate?: string; cliffAmount?: number; standardAllocationName?: string }>;
  };
}

const tokenListMemo: { data: TokenListEntry[]; expiresAt: number } = { data: [], expiresAt: 0 };

function getApiKey(): string | null {
  return config.TOKENUNLOCKS_API_KEY;
}

function toUnixSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  return null;
}

async function fetchTokenList(): Promise<TokenListEntry[]> {
  if (Date.now() < tokenListMemo.expiresAt && tokenListMemo.data.length > 0) {
    return tokenListMemo.data;
  }
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}${TOKEN_LIST_PATH}`, {
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: TokenListEntry[]; status?: boolean };
    const list = Array.isArray(json?.data) ? json.data : [];
    tokenListMemo.data = list;
    tokenListMemo.expiresAt = Date.now() + MEMO_TTL_MS;
    return list;
  } catch {
    clearTimeout(timeout);
    return tokenListMemo.data.length > 0 ? tokenListMemo.data : [];
  }
}

function resolveTokenId(symbol: string, list: TokenListEntry[]): string | null {
  const upper = symbol.trim().toUpperCase();
  const exact = list.find((t) => (t.symbol ?? "").toUpperCase() === upper);
  if (exact) return exact.id;
  const lower = symbol.trim().toLowerCase();
  const byId = list.find((t) => t.id === lower || t.id === symbol.trim());
  if (byId) return byId.id;
  return null;
}

export class TokenUnlocksProvider implements UnlockProvider {
  readonly name = "TokenUnlocks";

  supports(_asset: AssetMetadata): boolean {
    return !!getApiKey();
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, source: "TokenUnlocks", events: [], error: "no_api_key" };
    }

    const symbol = asset.symbol.trim().toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);

    try {
      const list = await fetchTokenList();
      const tokenId = resolveTokenId(asset.symbol, list);
      if (!tokenId) {
        logger.info({ symbol: asset.symbol }, "TOKENUNLOCKS_TOKEN_NOT_IN_LIST");
        return { success: false, source: "TokenUnlocks", events: [], error: "token_not_found" };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${BASE_URL}${UNLOCK_EVENTS_PATH}?tokenId=${encodeURIComponent(tokenId)}`, {
        headers: { "x-api-key": apiKey },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.status === 404) return { success: false, source: "TokenUnlocks", events: [], error: "not_found" };
      if (res.status === 429) return { success: false, source: "TokenUnlocks", events: [], error: "rate_limited", rate_limited: true };
      if (!res.ok) {
        logger.warn({ symbol: asset.symbol, status: res.status }, "TOKENUNLOCKS_FETCH_FAILED");
        return { success: false, source: "TokenUnlocks", events: [], error: `status_${res.status}` };
      }

      const json = (await res.json()) as { data?: UnlockEventItem[]; status?: boolean };
      const items = Array.isArray(json?.data) ? json.data : [];
      const events: NormalizedUnlockEvent[] = [];

      for (const item of items) {
        const ts = toUnixSeconds(item.unlockDate);
        if (ts == null || ts <= nowSec) continue;
        const cliff = item.cliffUnlocks;
        let amount = 0;
        if (cliff != null) {
          if (Number.isFinite(cliff.cliffAmount)) amount = cliff.cliffAmount!;
          else if (Array.isArray(cliff.allocationBreakdown)) {
            amount = cliff.allocationBreakdown.reduce((s, a) => s + (Number(a.cliffAmount) || 0), 0);
          }
        }
        if (amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "TokenUnlocks",
        });
      }

      const sorted = events.sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
      if (sorted.length === 0) {
        logger.info({ symbol: asset.symbol, tokenId }, "TOKENUNLOCKS_FETCH_EMPTY");
        return { success: false, source: "TokenUnlocks", events: [], error: "no_future_events" };
      }

      logger.info({ symbol: asset.symbol, tokenId, eventsCount: sorted.length }, "TOKENUNLOCKS_FETCH_SUCCESS");
      return {
        success: true,
        source: "TokenUnlocks",
        events: sorted,
        next_unlock_timestamp: sorted[0].unlock_timestamp,
        confidence_score: 0.9,
      };
    } catch (err) {
      logger.warn(
        { symbol: asset.symbol, err: err instanceof Error ? err.message : String(err) },
        "TOKENUNLOCKS_FETCH_FAILED"
      );
      return { success: false, source: "TokenUnlocks", events: [], error: "exception" };
    }
  }
}

export const tokenUnlocksProvider = new TokenUnlocksProvider();
