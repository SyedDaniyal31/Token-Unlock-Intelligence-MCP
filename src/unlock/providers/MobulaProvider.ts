/**
 * Mobula API metadata provider: secondary unlock source via release_schedule.
 * Minimal integration; no scoring changes.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

const BASE_URL = "https://api.mobula.io/api/1";
const MEMO_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface MemoEntry {
  result: UnlockFetchResult;
  expiresAt: number;
}
const memo = new Map<string, MemoEntry>();

function getApiKey(): string | null {
  const key = process.env.MOBULA_API_KEY;
  return key && String(key).trim() ? String(key).trim() : null;
}

function toUnixSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    const num = Number(value);
    if (Number.isFinite(num)) return num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
  }
  return null;
}

function toAmount(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export class MobulaProvider implements UnlockProvider {
  readonly name = "Mobula";

  supports(_asset: AssetMetadata): boolean {
    return !!getApiKey();
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, source: "Mobula", events: [], error: "no_api_key" };
    }

    const memoKey = `mobula:${asset.chain}:${asset.symbol.trim().toUpperCase()}`;
    const cached = memo.get(memoKey);
    if (cached && Date.now() < cached.expiresAt) {
      return structuredClone(cached.result);
    }

    const symbol = asset.symbol.trim().toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);

    logger.info({ symbol: asset.symbol }, "MOBULA_FETCH_START");

    try {
      const url = `${BASE_URL}/metadata?asset=${encodeURIComponent(asset.symbol.trim())}`;
      const res = await fetch(url, {
        headers: { Authorization: apiKey },
      });

      if (!res.ok) {
        logger.warn({ symbol: asset.symbol, status: res.status }, "MOBULA_FETCH_FAILED");
        const out: UnlockFetchResult = {
          success: false,
          source: "Mobula",
          events: [],
          error: `status_${res.status}`,
        };
        memo.set(memoKey, { result: out, expiresAt: Date.now() + MEMO_TTL_MS });
        return out;
      }

      const json = (await res.json()) as {
        data?: {
          release_schedule?: Array<{
            date?: string;
            timestamp?: number;
            unlock_date?: string;
            time?: number;
            amount?: number;
            quantity?: number;
            unlock_amount?: number;
            [key: string]: unknown;
          }>;
        };
        [key: string]: unknown;
      };

      const schedule = json?.data?.release_schedule;
      if (!Array.isArray(schedule) || schedule.length === 0) {
        logger.info({ symbol: asset.symbol }, "MOBULA_FETCH_EMPTY");
        const out: UnlockFetchResult = {
          success: true,
          source: "Mobula",
          events: [],
          next_unlock_timestamp: null,
          confidence_score: 0.75,
        };
        memo.set(memoKey, { result: out, expiresAt: Date.now() + MEMO_TTL_MS });
        return out;
      }

      const events: NormalizedUnlockEvent[] = [];
      for (const row of schedule) {
        const ts = toUnixSeconds(row?.timestamp ?? row?.time ?? row?.date ?? row?.unlock_date);
        if (ts == null || ts <= nowSec) continue;
        const amount = toAmount(row?.amount ?? row?.quantity ?? row?.unlock_amount);
        if (amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "Mobula",
        });
      }

      const sorted = events
        .filter((e) => e.unlock_timestamp > nowSec)
        .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

      if (sorted.length === 0) {
        logger.info({ symbol: asset.symbol }, "MOBULA_FETCH_EMPTY");
      } else {
        logger.info({ symbol: asset.symbol, eventsCount: sorted.length }, "MOBULA_FETCH_SUCCESS");
      }

      const result: UnlockFetchResult = {
        success: true,
        source: "Mobula",
        events: sorted,
        next_unlock_timestamp: sorted.length > 0 ? sorted[0].unlock_timestamp : null,
        confidence_score: 0.75,
      };
      memo.set(memoKey, { result, expiresAt: Date.now() + MEMO_TTL_MS });
      return result;
    } catch (err) {
      logger.warn(
        { symbol: asset.symbol, err: err instanceof Error ? err.message : String(err) },
        "MOBULA_FETCH_FAILED"
      );
      const out: UnlockFetchResult = {
        success: false,
        source: "Mobula",
        events: [],
        error: "exception",
      };
      memo.set(memoKey, { result: out, expiresAt: Date.now() + MEMO_TTL_MS });
      return out;
    }
  }
}

export const mobulaProvider = new MobulaProvider();
