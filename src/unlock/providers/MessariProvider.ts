/**
 * Messari token unlocks / vesting API provider.
 * Uses vesting-schedule or profile endpoint when MESSARI_API_KEY is set.
 * Fallback after DefiLlama in priority order.
 */

import { config } from "../../core/config.js";
import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

const BASE_URL = "https://data.messari.io";
const FETCH_TIMEOUT_MS = 10_000;

/** Symbol -> Messari asset slug (lowercase). */
const SLUG_OVERRIDES: Record<string, string> = {
  ARB: "arbitrum",
  ARBITRUM: "arbitrum",
  OP: "optimism",
  OPTIMISM: "optimism",
  ENA: "ethena",
  ETHENA: "ethena",
  TIA: "celestia",
  CELESTIA: "celestia",
  STRK: "starknet",
  STARKNET: "starknet",
  SUI: "sui",
  APT: "aptos",
  APTOS: "aptos",
  HYPE: "hype",
};

function getApiKey(): string | null {
  return config.MESSARI_API_KEY;
}

function getSlugsToTry(asset: AssetMetadata): string[] {
  const sym = asset.symbol.trim().toUpperCase();
  const override = SLUG_OVERRIDES[sym];
  if (override) return [override, asset.symbol.trim().toLowerCase()];
  return [asset.symbol.trim().toLowerCase()];
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

function toAmount(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/** Parse Messari vesting or profile response into normalized events. */
function parseMessariResponse(data: unknown, symbol: string, nowSec: number): NormalizedUnlockEvent[] {
  const events: NormalizedUnlockEvent[] = [];
  if (data == null || typeof data !== "object") return events;

  const obj = data as Record<string, unknown>;
  // token-unlocks vesting-schedule style: time_series with date + native_tokens_unlocked or similar
  const series = obj.time_series ?? obj.data ?? obj.schedule ?? obj.unlocks ?? obj.events;
  if (Array.isArray(series)) {
    for (const item of series as Record<string, unknown>[]) {
      const ts = toUnixSeconds(item.date ?? item.timestamp ?? item.unlock_date ?? item.time);
      if (ts == null || ts <= nowSec) continue;
      const amount = toAmount(
        item.native_tokens_unlocked ?? item.amount ?? item.unlock_amount ?? item.tokens ?? item.quantity
      );
      if (amount <= 0) continue;
      events.push({
        token_symbol: symbol,
        unlock_timestamp: ts,
        unlock_amount: amount,
        source: "Messari",
      });
    }
    return events;
  }

  // Profile tokenomics style: profile.data.tokenomics.lockup_schedule or similar
  const profileData = obj.data as Record<string, unknown> | undefined;
  const tokenomics = (obj.tokenomics ?? profileData?.tokenomics) as Record<string, unknown> | null | undefined;
  if (tokenomics != null && typeof tokenomics === "object") {
    const schedule = (tokenomics as Record<string, unknown>).lockup_schedule
      ?? (tokenomics as Record<string, unknown>).unlock_schedule
      ?? (tokenomics as Record<string, unknown>).schedule;
    if (Array.isArray(schedule)) {
      for (const row of schedule as Record<string, unknown>[]) {
        const ts = toUnixSeconds(row.unlock_date ?? row.date ?? row.timestamp);
        if (ts == null || ts <= nowSec) continue;
        const amount = toAmount(row.amount ?? row.unlock_amount ?? row.tokens);
        if (amount <= 0) continue;
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amount,
          source: "Messari",
        });
      }
    }
  }

  return events;
}

export class MessariProvider implements UnlockProvider {
  readonly name = "Messari";

  supports(_asset: AssetMetadata): boolean {
    return !!getApiKey();
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, source: "Messari", events: [], error: "no_api_key" };
    }

    const symbol = asset.symbol.trim().toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const slugs = getSlugsToTry(asset);

    for (const slug of slugs) {
      try {
        // Try token-unlocks vesting-schedule first
        const vestingUrl = `${BASE_URL}/token-unlocks/v1/assets/${encodeURIComponent(slug)}/vesting-schedule`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(vestingUrl, {
          headers: { "x-messari-api-key": apiKey },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 404) continue;
        if (res.status === 429) {
          return { success: false, source: "Messari", events: [], error: "rate_limited", rate_limited: true };
        }
        if (!res.ok) {
          logger.debug({ slug, status: res.status }, "MESSARI_VESTING_FETCH_FAILED");
          continue;
        }

        const raw = await res.json();
        const events = parseMessariResponse(raw, symbol, nowSec)
          .filter((e) => e.unlock_timestamp > nowSec)
          .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

        if (events.length > 0) {
          logger.info({ symbol: asset.symbol, slug, eventsCount: events.length }, "MESSARI_FETCH_SUCCESS");
          return {
            success: true,
            source: "Messari",
            events,
            next_unlock_timestamp: events[0].unlock_timestamp,
            confidence_score: 0.75,
          };
        }
      } catch {
        // try next slug or profile
      }

      // Fallback: profile endpoint for tokenomics
      try {
        const profileUrl = `${BASE_URL}/api/v1/assets/${encodeURIComponent(slug)}/profile`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(profileUrl, {
          headers: { "x-messari-api-key": apiKey },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (res.status === 404 || !res.ok) continue;
        const raw = await res.json();
        const data = (raw as { data?: unknown }).data ?? raw;
        const events = parseMessariResponse(data, symbol, nowSec)
          .filter((e) => e.unlock_timestamp > nowSec)
          .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

        if (events.length > 0) {
          logger.info({ symbol: asset.symbol, slug, eventsCount: events.length }, "MESSARI_FETCH_SUCCESS");
          return {
            success: true,
            source: "Messari",
            events,
            next_unlock_timestamp: events[0].unlock_timestamp,
            confidence_score: 0.7,
          };
        }
      } catch {
        // next slug
      }
    }

    logger.info({ symbol: asset.symbol }, "MESSARI_FETCH_EMPTY");
    return { success: false, source: "Messari", events: [], error: "not_found" };
  }
}

export const messariProvider = new MessariProvider();
