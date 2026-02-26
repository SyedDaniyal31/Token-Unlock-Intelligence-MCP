/**
 * External unlock ingestion: normalize and upsert external calendar data
 * into unlock_events_external. Safe for cron; does not throw fatal errors.
 * CryptoRank API integration.
 */

import { query } from "../infrastructure/database/postgres.js";
import logger from "../core/logger.js";
import { config } from "../core/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExternalUnlockEvent {
  token_symbol: string;
  chain: string;
  unlock_timestamp: number;
  unlock_amount: number;
  unlock_percent: number;
  category: "team" | "investor" | "ecosystem" | "unknown";
  source: string;
  confidence: number;
  inserted_at: number;
}

/** Raw shape from external APIs (mock or TokenUnlocks / CryptoRank). */
export interface RawExternalUnlock {
  token_symbol?: string;
  symbol?: string;
  chain?: string;
  chain_id?: string;
  unlock_timestamp?: number;
  unlock_time?: number;
  timestamp?: number;
  unlock_amount?: number;
  amount?: number;
  unlock_percent?: number;
  percent?: number;
  category?: string;
  source?: string;
  confidence?: number;
  inserted_at?: number;
  [key: string]: unknown;
}

/** CryptoRank V2 API unlock item (CurrenciesTokenUnlockResponse.data[]). */
export interface CryptoRankUnlockRaw {
  symbol?: string;
  platform?: string;
  unlock_date?: string;
  date?: string;
  amount?: number;
  percent?: number;
  type?: string;
  [key: string]: unknown;
}

const CATEGORIES = new Set<string>(["team", "investor", "ecosystem", "unknown"]);

function toCategory(s: unknown): "team" | "investor" | "ecosystem" | "unknown" {
  const v = typeof s === "string" ? s.trim().toLowerCase() : "";
  return CATEGORIES.has(v) ? (v as "team" | "investor" | "ecosystem" | "unknown") : "unknown";
}

function toNum(x: unknown, fallback: number): number {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function toStr(x: unknown, fallback: string): string {
  if (typeof x === "string" && x.trim().length > 0) return x.trim();
  return fallback;
}

/** Map CryptoRank platform to chain slug (EVM → ethereum). */
function chainFromPlatform(platform: unknown): string {
  const p = typeof platform === "string" ? platform.trim().toLowerCase() : "";
  if (!p) return "ethereum";
  if (p.includes("ethereum") || p === "eth") return "ethereum";
  if (p.includes("arbitrum") || p === "arb") return "arbitrum";
  if (p.includes("bsc") || p.includes("bnb")) return "bsc";
  return "ethereum";
}

/** Parse ISO date or numeric timestamp to Unix seconds. */
function parseUnlockTimestamp(raw: CryptoRankUnlockRaw): number | null {
  const iso = raw.unlock_date ?? raw.date;
  if (typeof iso === "string" && iso.trim()) {
    const t = Date.parse(iso.trim());
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  const ts = toNum(raw.unlock_timestamp ?? raw.timestamp, NaN);
  if (Number.isFinite(ts)) {
    return ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Normalize (generic)
// ---------------------------------------------------------------------------

/**
 * Normalize a raw external unlock record into ExternalUnlockEvent.
 * Defensive: invalid or missing fields get safe defaults.
 */
export function normalizeExternalUnlock(raw: RawExternalUnlock): ExternalUnlockEvent {
  const nowSec = Math.floor(Date.now() / 1000);
  const symbol = toStr(raw.token_symbol ?? raw.symbol, "UNKNOWN");
  const chain = toStr(raw.chain ?? raw.chain_id, "ethereum").toLowerCase();
  const ts = toNum(raw.unlock_timestamp ?? raw.unlock_time ?? raw.timestamp, nowSec);
  const amount = Math.max(0, toNum(raw.unlock_amount ?? raw.amount, 0));
  const pct = Math.max(0, Math.min(100, toNum(raw.unlock_percent ?? raw.percent, 0)));
  const category = toCategory(raw.category);
  const source = toStr(raw.source, "external");
  const confidence = Math.max(0, Math.min(100, toNum(raw.confidence, 50)));
  const inserted_at = toNum(raw.inserted_at, nowSec);

  return {
    token_symbol: symbol,
    chain,
    unlock_timestamp: ts,
    unlock_amount: amount,
    unlock_percent: pct,
    category,
    source,
    confidence,
    inserted_at,
  };
}

// ---------------------------------------------------------------------------
// Normalize CryptoRank
// ---------------------------------------------------------------------------

const CRYPTORANK_CONFIDENCE = 80;

/**
 * Map CryptoRank unlock item to ExternalUnlockEvent. Returns null if event
 * should be skipped (past or unlock_percent === 0).
 */
export function normalizeCryptoRankUnlock(raw: CryptoRankUnlockRaw): ExternalUnlockEvent | null {
  const nowSec = Math.floor(Date.now() / 1000);
  const symbol = toStr(raw.symbol, "");
  if (!symbol) return null;

  const unlockTs = parseUnlockTimestamp(raw);
  if (unlockTs == null || unlockTs <= nowSec) return null;

  const unlockPercent = Math.max(0, Math.min(100, toNum(raw.percent, 0)));
  if (unlockPercent === 0) return null;

  const chain = chainFromPlatform(raw.platform);
  const unlockAmount = Math.max(0, toNum(raw.amount, 0));
  const category = toCategory(raw.type);

  return {
    token_symbol: symbol.toUpperCase(),
    chain,
    unlock_timestamp: unlockTs,
    unlock_amount: unlockAmount,
    unlock_percent: unlockPercent,
    category,
    source: "cryptorank",
    confidence: CRYPTORANK_CONFIDENCE,
    inserted_at: nowSec,
  };
}

// ---------------------------------------------------------------------------
// Fetch CryptoRank (V2 API)
// ---------------------------------------------------------------------------

const CRYPTORANK_BASE_URL = "https://api.cryptorank.io/v2";

/**
 * Fetch token unlock calendar from CryptoRank V2 API.
 * Uses X-Api-Key header (no query param). Returns [] on non-200 or parse error.
 */
async function fetchCryptoRankUnlocks(apiKey: string): Promise<CryptoRankUnlockRaw[]> {
  const url = `${CRYPTORANK_BASE_URL}/currencies/token-unlock`;
  console.log("CRYPTO RANK URL:", url);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Api-Key": apiKey,
        "Content-Type": "application/json",
      },
    });
  } catch (err) {
    console.error("CryptoRank fetch error (full stack):", err instanceof Error ? err.stack : err);
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "CryptoRank fetch failed");
    return [];
  }
  console.log("CryptoRank response status:", response.status);
  if (response.status === 404) {
    const text = await response.text();
    console.error("CryptoRank error body:", text);
    console.error("CryptoRank endpoint invalid — check API version or path");
    logger.warn({ status: 404 }, "CryptoRank unlock endpoint not found");
    return [];
  }
  if (!response.ok) {
    const text = await response.text();
    console.error("CryptoRank error body:", text);
    logger.warn({ status: response.status, statusText: response.statusText }, "CryptoRank unlock API non-200");
    return [];
  }
  let json: { status?: { usedCredits?: number }; data?: unknown };
  try {
    json = (await response.json()) as { status?: { usedCredits?: number }; data?: unknown };
  } catch (err) {
    console.error("CryptoRank JSON parse error:", err instanceof Error ? err.stack : err);
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "CryptoRank unlock API JSON parse failed");
    return [];
  }
  if (!json.data || !Array.isArray(json.data)) {
    console.error("Unexpected CryptoRank response shape:", Object.keys(json));
    return [];
  }
  const unlocks = json.data as CryptoRankUnlockRaw[];
  console.log("CryptoRank records received:", unlocks.length);
  return unlocks;
}

// ---------------------------------------------------------------------------
// Upsert (BIGINT schema: migration_external_unlocks)
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
INSERT INTO unlock_events_external (
  token_symbol,
  chain,
  unlock_timestamp,
  unlock_amount,
  unlock_percent,
  category,
  source,
  confidence,
  inserted_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (token_symbol, unlock_timestamp, source)
DO UPDATE SET
  unlock_amount = EXCLUDED.unlock_amount,
  unlock_percent = EXCLUDED.unlock_percent,
  confidence = EXCLUDED.confidence
`;

async function upsertOne(event: ExternalUnlockEvent): Promise<void> {
  await query(UPSERT_SQL, [
    event.token_symbol,
    event.chain,
    event.unlock_timestamp,
    event.unlock_amount,
    event.unlock_percent,
    event.category,
    event.source,
    event.confidence,
    event.inserted_at,
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ingest external unlock schedules from CryptoRank into unlock_events_external.
 * Safe for cron: never throws; logs errors. Runs after DB connection is established.
 */
export async function ingestExternalUnlocks(): Promise<void> {
  console.log("=== INGEST FUNCTION ENTERED ===");
  console.log("CRYPTORANK_API_KEY PRESENT:", !!process.env.CRYPTORANK_API_KEY);
  try {
    const apiKey = config.CRYPTORANK_API_KEY;
    if (!apiKey) {
      logger.warn("CRYPTORANK_API_KEY not configured. External unlock ingestion disabled.");
      return;
    }

    const rawList = await fetchCryptoRankUnlocks(apiKey);
    const totalFetched = Array.isArray(rawList) ? rawList.length : 0;
    if (totalFetched === 0) {
      return;
    }

    const events: ExternalUnlockEvent[] = [];
    for (const raw of rawList) {
      if (raw == null || typeof raw !== "object") continue;
      const unlock = raw as CryptoRankUnlockRaw & { token_symbol?: string };
      const hasSymbol = !!(unlock.symbol || unlock.token_symbol);
      const hasDate = !!(unlock.date || unlock.unlock_date);
      if (!hasSymbol || !hasDate) {
        console.warn("Skipping invalid unlock record", unlock);
        continue;
      }
      const event = normalizeCryptoRankUnlock(unlock);
      if (event != null) events.push(event);
    }

    let totalUpserted = 0;
    for (const event of events) {
      try {
        await upsertOne(event);
        totalUpserted += 1;
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), token_symbol: event.token_symbol, source: event.source },
          "external_unlock_upsert_skip"
        );
      }
    }

    logger.info(
      { totalFetched, totalInserted: totalUpserted, totalUpdated: 0 },
      "CryptoRank unlock ingestion completed"
    );
    console.log("CryptoRank ingestion completed successfully");
  } catch (err) {
    console.error("CryptoRank ingestion error (full stack):", err instanceof Error ? err.stack : err);
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "CryptoRank ingestion failed");
  }
}
