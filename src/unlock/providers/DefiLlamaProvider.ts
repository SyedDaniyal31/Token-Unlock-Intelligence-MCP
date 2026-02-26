/**
 * DefiLlama emissions API provider (free). Fetches unlock/emission schedules by protocol slug.
 * EVM-only. Fallback when ManualRegistry has no events.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

const BASE_URL = "https://api.llama.fi";
const EMISSIONS_PATH = "/emissions";
const MEMO_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FETCH_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 500;

/** Symbol → DefiLlama protocol slug when different from symbol. */
const SLUG_OVERRIDES: Record<string, string> = {
  RED: "redstone",
  REDSTONE: "redstone",
  ARB: "arbitrum",
  ARBITRUM: "arbitrum",
  OP: "optimism",
  OPTIMISM: "optimism",
  APT: "aptos",
  APTOS: "aptos",
  ENA: "ethena",
  ETHENA: "ethena",
};

interface MemoEntry {
  result: UnlockFetchResult;
  expiresAt: number;
}
const memo = new Map<string, MemoEntry>();

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

function getSlugsToTry(asset: AssetMetadata): string[] {
  const sym = asset.symbol.trim().toUpperCase();
  const override = SLUG_OVERRIDES[sym];
  if (override) return [override, sym.toLowerCase()];
  return [asset.symbol.trim().toLowerCase()];
}

function extractEventsFromPayload(
  data: unknown,
  symbol: string,
  nowSec: number
): NormalizedUnlockEvent[] {
  const events: NormalizedUnlockEvent[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      const ts = toUnixSeconds((item as Record<string, unknown>)?.timestamp ?? (item as Record<string, unknown>)?.date ?? (item as Record<string, unknown>)?.unlock_timestamp);
      if (ts == null || ts <= nowSec) continue;
      const amount = toAmount((item as Record<string, unknown>)?.amount ?? (item as Record<string, unknown>)?.quantity ?? (item as Record<string, unknown>)?.unlock_amount ?? (item as Record<string, unknown>)?.noOfTokens);
      if (amount <= 0) continue;
      events.push({ token_symbol: symbol, unlock_timestamp: ts, unlock_amount: amount, source: "DefiLlama" });
    }
    return events;
  }

  if (data != null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const schedules = obj.schedule ?? obj.emissions ?? obj.unlocks ?? obj.data ?? obj.events;
    if (Array.isArray(schedules)) {
      for (const item of schedules) {
        const raw = item as Record<string, unknown>;
        const ts = toUnixSeconds(raw?.timestamp ?? raw?.date ?? raw?.unlock_timestamp);
        if (ts == null || ts <= nowSec) continue;
        const amount = toAmount(raw?.amount ?? raw?.quantity ?? raw?.unlock_amount ?? raw?.tokens);
        if (amount <= 0) continue;
        events.push({ token_symbol: symbol, unlock_timestamp: ts, unlock_amount: amount, source: "DefiLlama" });
      }
    }
    if (events.length === 0 && Array.isArray(obj.events)) {
      for (const item of obj.events as Record<string, unknown>[]) {
        const ts = toUnixSeconds(item?.timestamp);
        if (ts == null || ts <= nowSec) continue;
        const noOfTokens = item?.noOfTokens;
        const amount = Array.isArray(noOfTokens) ? noOfTokens.reduce((s, n) => s + toAmount(n), 0) : toAmount(item?.amount ?? item?.tokens);
        if (amount <= 0) continue;
        events.push({ token_symbol: symbol, unlock_timestamp: ts, unlock_amount: amount, source: "DefiLlama" });
      }
    }
  }

  return events;
}

async function fetchWithTimeout(url: string, retried = false): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.status === 429 && !retried) {
      logger.warn("DEFILLAMA_RATE_LIMITED");
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return fetchWithTimeout(url, true);
    }
    return res;
  } catch {
    clearTimeout(timeout);
    throw new Error("DEFILLAMA_FETCH_TIMEOUT");
  }
}

export class DefiLlamaProvider implements UnlockProvider {
  readonly name = "DefiLlama";

  supports(asset: AssetMetadata): boolean {
    return asset.chain_type === "evm";
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    if (asset.chain_type !== "evm") {
      return { success: false, source: "DefiLlama", events: [], error: "non_evm" };
    }

    const memoKey = `${asset.chain}:${asset.symbol.trim().toUpperCase()}`;
    const cached = memo.get(memoKey);
    if (cached && Date.now() < cached.expiresAt) {
      return structuredClone(cached.result);
    }

    const symbol = asset.symbol.trim().toUpperCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const slugs = getSlugsToTry(asset);

    logger.info({ symbol: asset.symbol, slugs }, "DEFILLAMA_FETCH_START");

    for (const slug of slugs) {
      try {
        const res = await fetchWithTimeout(`${BASE_URL}${EMISSIONS_PATH}/${encodeURIComponent(slug)}`);
        if (res.status === 404) continue;
        if (res.status === 429) {
          return { success: false, source: "DefiLlama", events: [], error: "rate_limited", rate_limited: true };
        }
        if (!res.ok) {
          logger.warn({ slug, status: res.status }, "DEFILLAMA_FETCH_FAILED");
          continue;
        }
        const raw = await res.json();
        const events = extractEventsFromPayload(raw, symbol, nowSec)
          .filter((e) => e.unlock_timestamp > nowSec)
          .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

        if (events.length === 0) {
          logger.info({ symbol: asset.symbol, slug }, "DEFILLAMA_FETCH_EMPTY");
          continue;
        }

        logger.info({ symbol: asset.symbol, slug, eventsCount: events.length }, "DEFILLAMA_FETCH_SUCCESS");
        const result: UnlockFetchResult = {
          success: true,
          source: "DefiLlama",
          events,
          next_unlock_timestamp: events[0].unlock_timestamp,
          confidence_score: 0.7,
        };
        memo.set(memoKey, { result, expiresAt: Date.now() + MEMO_TTL_MS });
        return result;
      } catch (err) {
        logger.warn({ slug, err: err instanceof Error ? err.message : String(err) }, "DEFILLAMA_FETCH_FAILED");
        continue;
      }
    }

    // Fallback: full emissions list
    try {
      const res = await fetchWithTimeout(`${BASE_URL}${EMISSIONS_PATH}`);
      if (!res.ok) return { success: false, source: "DefiLlama", events: [], error: "not_found" };
      const list = await res.json();
      if (!Array.isArray(list)) return { success: false, source: "DefiLlama", events: [], error: "not_found" };

      const slugSet = new Set(slugs.map((s) => s.toLowerCase()));
      const symLower = asset.symbol.trim().toLowerCase();
      const protocol = (list as Record<string, unknown>[]).find((p) => {
        const protocolSlug = typeof p.protocolSlug === "string" ? p.protocolSlug.toLowerCase() : "";
        const name = typeof p.name === "string" ? p.name.toLowerCase() : "";
        const token = String(p.token ?? "");
        if (slugSet.has(protocolSlug)) return true;
        if (name.includes(symLower) || symLower.includes(protocolSlug)) return true;
        if (token.includes(symLower)) return true;
        return false;
      });

      if (protocol) {
        const events = extractEventsFromPayload(protocol, symbol, nowSec)
          .filter((e) => e.unlock_timestamp > nowSec)
          .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
        if (events.length > 0) {
          logger.info({ symbol: asset.symbol, protocolSlug: (protocol as Record<string, unknown>).protocolSlug }, "DEFILLAMA_FETCH_SUCCESS");
          const result: UnlockFetchResult = {
            success: true,
            source: "DefiLlama",
            events,
            next_unlock_timestamp: events[0].unlock_timestamp,
            confidence_score: 0.7,
          };
          memo.set(memoKey, { result, expiresAt: Date.now() + MEMO_TTL_MS });
          return result;
        }
      }
    } catch {
      // ignore
    }

    logger.info({ symbol: asset.symbol }, "DEFILLAMA_FETCH_EMPTY");
    const noData: UnlockFetchResult = { success: false, source: "DefiLlama", events: [], error: "not_found" };
    memo.set(memoKey, { result: noData, expiresAt: Date.now() + MEMO_TTL_MS });
    return noData;
  }
}

export const defiLlamaProvider = new DefiLlamaProvider();
