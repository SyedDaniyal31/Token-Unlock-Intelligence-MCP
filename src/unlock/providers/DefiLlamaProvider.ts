/**
 * DefiLlama emissions API provider: fetches unlock/emission schedules by protocol slug.
 * EVM-only; primary unlock source when protocol is listed on DefiLlama.
 * When per-slug returns 404, falls back to full /emissions list and resolves by protocolSlug/name (e.g. RedStone).
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

const DEFILLAMA_EMISSIONS_BASE = "https://api.llama.fi/emissions";

/** Symbol → DefiLlama protocol slug(s) to try. RedStone ticker is RED but DefiLlama slug is redstone. */
const SYMBOL_TO_SLUGS: Record<string, string[]> = {
  RED: ["redstone", "red"],
  REDSTONE: ["redstone"],
};

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

/** Slugs to try for this asset (override for known symbol/slug mismatches). */
function getSlugsToTry(asset: AssetMetadata): string[] {
  const sym = asset.symbol.trim().toUpperCase();
  const override = SYMBOL_TO_SLUGS[sym];
  if (override?.length) return override;
  const fallback = asset.symbol.trim().toLowerCase();
  return fallback ? [fallback] : [];
}

/** Extract unlock events from DefiLlama emissions response (array or object with schedule). */
function extractEvents(
  data: unknown,
  symbol: string,
  nowSec: number
): NormalizedUnlockEvent[] {
  const events: NormalizedUnlockEvent[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      const ts = toUnixSeconds(item?.timestamp ?? item?.date ?? item?.unlock_timestamp ?? item?.time);
      if (ts == null || ts <= nowSec) continue;
      const amount = toAmount(item?.amount ?? item?.quantity ?? item?.unlock_amount ?? item?.tokens);
      if (amount <= 0) continue;
      events.push({
        token_symbol: symbol,
        unlock_timestamp: ts,
        unlock_amount: amount,
        source: "DefiLlama",
      });
    }
    return events;
  }

  if (data != null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const schedules = obj.schedule ?? obj.emissions ?? obj.unlocks ?? obj.data ?? obj.events;
    if (Array.isArray(schedules)) {
      for (const item of schedules) {
        const ts = toUnixSeconds(
          (item as Record<string, unknown>)?.timestamp ??
            (item as Record<string, unknown>)?.date ??
            (item as Record<string, unknown>)?.unlock_timestamp ??
            (item as Record<string, unknown>)?.time
        );
        if (ts == null || ts <= nowSec) continue;
        const raw = item as Record<string, unknown>;
        const amount = toAmount(raw?.amount ?? raw?.quantity ?? raw?.unlock_amount ?? raw?.tokens);
        if (amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "DefiLlama",
        });
      }
    }
    // Full-list format: noOfTokens array
    if (events.length === 0 && Array.isArray(obj.events)) {
      for (const item of obj.events as Record<string, unknown>[]) {
        const ts = toUnixSeconds(item?.timestamp);
        if (ts == null || ts <= nowSec) continue;
        const noOfTokens = item?.noOfTokens;
        const amount = Array.isArray(noOfTokens)
          ? noOfTokens.reduce((s, n) => s + toAmount(n), 0)
          : toAmount(item?.amount ?? item?.tokens);
        if (amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "DefiLlama",
        });
      }
    }
    // Single-level object: keys as timestamps or dates
    if (events.length === 0 && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (v == null || Array.isArray(v) || typeof v === "object") continue;
        const ts = toUnixSeconds(k) ?? toUnixSeconds(v);
        if (ts == null || ts <= nowSec) continue;
        const amount = toAmount(typeof v === "number" ? v : v);
        if (amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "DefiLlama",
        });
      }
    }
  }

  return events;
}

export class DefiLlamaProvider implements UnlockProvider {
  readonly name = "DefiLlama";

  supports(asset: AssetMetadata): boolean {
    return asset.chain_type === "evm";
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    if (asset.chain_type !== "evm") {
      return {
        success: false,
        source: "DefiLlama",
        events: [],
        error: "non_evm",
      };
    }

    const slugs = getSlugsToTry(asset);
    if (slugs.length === 0) {
      return { success: false, source: "DefiLlama", events: [], error: "no_symbol" };
    }

    const symbol = asset.symbol.trim().toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);

    for (const slug of slugs) {
      logger.info({ slug, symbol: asset.symbol }, "DEFILLAMA_FETCH_START");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let response: Response;
      try {
        response = await fetch(`${DEFILLAMA_EMISSIONS_BASE}/${encodeURIComponent(slug)}`, {
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        logger.warn({ slug }, "DEFILLAMA_FETCH_TIMEOUT_OR_ERROR");
        continue;
      }
      clearTimeout(timeout);

      if (response.status === 404) {
        logger.info({ slug }, "DEFILLAMA_404_TRY_NEXT_OR_FULL_LIST");
        continue;
      }

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After") ?? undefined;
        logger.warn({ slug, retryAfter }, "DEFILLAMA_RATE_LIMITED");
        return {
          success: false,
          source: "DefiLlama",
          events: [],
          error: "rate_limited",
          rate_limited: true,
        };
      }

      if (!response.ok) {
        logger.warn({ slug, status: response.status }, "DEFILLAMA_FETCH_FAILED");
        continue;
      }

      try {
        const raw = await response.json();
        const events = extractEvents(raw, symbol, nowSec)
          .filter((e) => e.unlock_timestamp > nowSec)
          .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

        if (events.length === 0) {
          logger.warn({ symbol: asset.symbol, slug }, "DEFILLAMA_PROVIDER_NO_DATA");
          continue;
        }

        logger.info({ symbol: asset.symbol, slug }, "DEFILLAMA_PROVIDER_SUCCESS");
        return {
          success: true,
          source: "DefiLlama",
          events,
          next_unlock_timestamp: events[0].unlock_timestamp,
        };
      } catch (err) {
        logger.warn(
          { slug, err: err instanceof Error ? err.message : String(err) },
          "DEFILLAMA_FETCH_FAILED"
        );
        continue;
      }
    }

    // All slugs 404'd: try full emissions list and resolve by protocolSlug/name (e.g. RedStone)
    const fromFull = await this.fetchFromFullList(asset, slugs, symbol, nowSec);
    if (fromFull) return fromFull;

    logger.warn({ symbol: asset.symbol, slugs }, "DEFILLAMA_PROVIDER_NO_DATA");
    return {
      success: false,
      source: "DefiLlama",
      events: [],
      error: "not_found",
    };
  }

  /**
   * Fallback: fetch full /emissions list and find protocol by protocolSlug or name.
   * Handles tokens like RedStone where per-slug endpoint returns 404 but data exists in the list.
   */
  private async fetchFromFullList(
    asset: AssetMetadata,
    slugsTried: string[],
    symbol: string,
    nowSec: number
  ): Promise<UnlockFetchResult | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let raw: unknown;
    try {
      const res = await fetch(`${DEFILLAMA_EMISSIONS_BASE}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        if (res.status === 402 || res.status === 403) {
          logger.info("DEFILLAMA_FULL_LIST_RESTRICTED");
        }
        return null;
      }
      raw = await res.json();
    } catch {
      clearTimeout(timeout);
      return null;
    }

    if (!Array.isArray(raw)) return null;

    const slugSet = new Set(slugsTried.map((s) => s.toLowerCase()));
    const nameLower = asset.symbol.trim().toLowerCase();
    const protocol = (raw as Record<string, unknown>[]).find((p) => {
      const protocolSlug = typeof p.protocolSlug === "string" ? p.protocolSlug.toLowerCase() : "";
      const name = typeof p.name === "string" ? p.name.toLowerCase() : "";
      if (slugSet.has(protocolSlug)) return true;
      if (protocolSlug === nameLower || name.includes(nameLower) || nameLower.includes(protocolSlug)) return true;
      const token = String(p.token ?? "");
      if (token.includes(nameLower) || token.includes(asset.symbol.trim())) return true;
      return false;
    });

    if (protocol == null || typeof protocol !== "object") return null;

    const events = extractEvents(protocol, symbol, nowSec)
      .filter((e) => e.unlock_timestamp > nowSec)
      .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

    if (events.length === 0) return null;

    logger.info({ symbol: asset.symbol, protocolSlug: (protocol as Record<string, unknown>).protocolSlug }, "DEFILLAMA_PROVIDER_SUCCESS_FULL_LIST");
    return {
      success: true,
      source: "DefiLlama",
      events,
      next_unlock_timestamp: events[0].unlock_timestamp,
    };
  }
}

export const defiLlamaProvider = new DefiLlamaProvider();
