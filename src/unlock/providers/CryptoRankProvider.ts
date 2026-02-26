/**
 * CryptoRank unlock provider. Chain-agnostic; uses V2 API with X-Api-Key.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import { config } from "../../core/config.js";
import logger from "../../core/logger.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";

const CRYPTORANK_BASE_URL = "https://api.cryptorank.io/v2";

function parseUnlockTimestamp(raw: { unlock_date?: string; date?: string; unlock_timestamp?: number; timestamp?: number }): number | null {
  const iso = raw.unlock_date ?? raw.date;
  if (typeof iso === "string" && iso.trim()) {
    const t = Date.parse(iso.trim());
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  const ts = raw.unlock_timestamp ?? raw.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  }
  return null;
}

export const cryptoRankProvider: UnlockProvider = {
  name: "CryptoRank",

  supports(_asset: AssetMetadata): boolean {
    return true;
  },

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    try {
      const apiKey = config.CRYPTORANK_API_KEY ?? process.env.CRYPTORANK_API_KEY;
      if (!apiKey || String(apiKey).trim() === "") {
        return {
          success: false,
          source: "CryptoRank",
          events: [],
          error: "missing_api_key",
        };
      }

      const url = `${CRYPTORANK_BASE_URL}/currencies/token-unlock`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Api-Key": String(apiKey).trim(),
          "Content-Type": "application/json",
        },
      });

      if (response.status === 403) {
        logger.warn(
          "CryptoRank token-unlock endpoint is not available on your API plan (403). Upgrade your CryptoRank plan or use manual registry (unlock_events_external) for unlock data."
        );
        return {
          success: false,
          source: "CryptoRank",
          events: [],
          error: "endpoint_not_in_plan",
        };
      }
      if (!response.ok) {
        return {
          success: false,
          source: "CryptoRank",
          events: [],
          error: `status_${response.status}`,
        };
      }

      interface CryptoRankRow {
        symbol?: string;
        unlock_date?: string;
        date?: string;
        amount?: number;
        percent?: number;
        unlock_timestamp?: number;
        timestamp?: number;
      }
      const json = (await response.json()) as { data?: CryptoRankRow[] };
      const records: CryptoRankRow[] = Array.isArray(json?.data) ? json.data : [];

      const nowSec = Math.floor(Date.now() / 1000);
      const symbolUpper = asset.symbol.toUpperCase();

      const events: NormalizedUnlockEvent[] = records
        .filter((r) => String(r?.symbol ?? "").toUpperCase() === symbolUpper)
        .map((r) => {
          const ts = parseUnlockTimestamp(r);
          const unlock_timestamp = ts ?? nowSec;
          const unlock_amount = typeof r.amount === "number" ? r.amount : 0;
          const unlock_percent = typeof r.percent === "number" ? r.percent : undefined;
          return {
            token_symbol: symbolUpper,
            unlock_timestamp,
            unlock_amount,
            unlock_percent,
            source: "CryptoRank",
          };
        })
        .filter((e) => e.unlock_timestamp > nowSec)
        .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

      return {
        success: events.length > 0,
        source: "CryptoRank",
        events,
        next_unlock_timestamp: events.length > 0 ? events[0].unlock_timestamp : null,
        confidence_score: 0.7,
      };
    } catch {
      return {
        success: false,
        source: "CryptoRank",
        events: [],
        error: "exception",
      };
    }
  },
};
