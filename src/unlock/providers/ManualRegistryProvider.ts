/**
 * Manual registry provider: reads from unlock_events_external (DB).
 * Registry is the authoritative first source; external APIs are fallback only.
 * Chain-agnostic; supports manual overrides and ingested calendar data.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import { query } from "../../infrastructure/database/postgres.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

export const manualRegistryProvider: UnlockProvider = {
  name: "ManualRegistry",

  supports(_asset: AssetMetadata): boolean {
    return true;
  },

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const symbol = asset.symbol.toUpperCase().trim();
      const result = await query<{
        token_symbol: string;
        unlock_timestamp: string | number;
        unlock_amount: string | number | null;
        unlock_percent: string | number | null;
        source: string;
      }>(
        `SELECT token_symbol, unlock_timestamp, unlock_amount, unlock_percent, source
         FROM unlock_events_external
         WHERE UPPER(TRIM(token_symbol)) = UPPER(TRIM($1))
           AND unlock_timestamp > $2
         ORDER BY unlock_timestamp ASC
         LIMIT 500`,
        [symbol, nowSec]
      );

      const rows = result?.rows ?? [];
      const events: NormalizedUnlockEvent[] = rows.map((r: {
        token_symbol: string;
        unlock_timestamp: string | number;
        unlock_amount: string | number | null;
        unlock_percent: string | number | null;
        source: string;
      }) => {
        const ts = typeof r.unlock_timestamp === "number" ? r.unlock_timestamp : Number(r.unlock_timestamp);
        const nowSec = Math.floor(Date.now() / 1000);
        const unlock_timestamp = Number.isFinite(ts) ? Math.floor(ts) : nowSec;
        const rawAmount = r.unlock_amount;
        const unlock_amount =
          rawAmount != null && rawAmount !== ""
            ? (typeof rawAmount === "number" ? rawAmount : Number(rawAmount))
            : 0;
        const unlock_percent =
          r.unlock_percent != null
            ? typeof r.unlock_percent === "number"
              ? r.unlock_percent
              : Number(r.unlock_percent)
            : undefined;
        return {
          token_symbol: (r.token_symbol ?? symbol).toString().toUpperCase(),
          unlock_timestamp,
          unlock_amount: Number.isFinite(unlock_amount) ? Math.max(0, unlock_amount) : 0,
          unlock_percent: unlock_percent != null && Number.isFinite(unlock_percent) ? unlock_percent : undefined,
          source: (r.source ?? "ManualRegistry").toString(),
        };
      });

      logger.info(
        { token_symbol: symbol, registryEventsFound: events.length },
        "REGISTRY_LOOKUP_RESULT"
      );

      return {
        success: events.length > 0,
        source: "ManualRegistry",
        events,
        next_unlock_timestamp: events.length > 0 ? events[0].unlock_timestamp : null,
        confidence_score: 0.9,
      };
    } catch {
      return {
        success: false,
        source: "ManualRegistry",
        events: [],
        error: "exception",
      };
    }
  },
};
