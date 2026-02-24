/**
 * External unlock ingestion: normalize and upsert external calendar data
 * into unlock_events_external. Safe for cron; does not throw fatal errors.
 */

import { query } from "../infrastructure/database/postgres.js";
import logger from "../core/logger.js";

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

// ---------------------------------------------------------------------------
// Normalize
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
// Fetch (mock)
// ---------------------------------------------------------------------------

// TODO: integrate TokenUnlocks / CryptoRank API

/**
 * Fetch external unlock data. Mock returns empty array; replace with real API.
 * Must not throw; return [] on any failure.
 */
async function fetchExternalUnlockData(): Promise<RawExternalUnlock[]> {
  try {
    // Mock: no hardcoded tokens or dates; real integration will call external API.
    return [];
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "external_unlock_fetch_failed");
    return [];
  }
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

const UPSERT_SQL = `
INSERT INTO unlock_events_external (
  token_symbol,
  chain_id,
  unlock_timestamp,
  amount,
  unlock_percent,
  category,
  source,
  confidence,
  inserted_at
) VALUES ($1, $2, to_timestamp($3::double precision), $4, $5, $6, $7, $8, to_timestamp($9::double precision))
ON CONFLICT (token_symbol, unlock_timestamp, source)
DO UPDATE SET
  amount = EXCLUDED.amount,
  unlock_percent = EXCLUDED.unlock_percent,
  category = EXCLUDED.category,
  confidence = EXCLUDED.confidence,
  updated_at = NOW()
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
 * Ingest external unlock schedules into unlock_events_external.
 * Fetches (mock) → normalizes → upserts. Safe for cron: logs errors and returns
 * without throwing. Does not hardcode tokens or dates.
 */
export async function ingestExternalUnlocks(): Promise<void> {
  try {
    const rawList = await fetchExternalUnlockData();
    if (!Array.isArray(rawList) || rawList.length === 0) {
      return;
    }

    const events: ExternalUnlockEvent[] = [];
    for (const raw of rawList) {
      if (raw == null || typeof raw !== "object") continue;
      try {
        const event = normalizeExternalUnlock(raw as RawExternalUnlock);
        if (event.token_symbol === "UNKNOWN") continue;
        events.push(event);
      } catch (e) {
        logger.warn({ err: e instanceof Error ? e.message : String(e) }, "external_unlock_normalize_skip");
      }
    }

    for (const event of events) {
      try {
        await upsertOne(event);
      } catch (e) {
        logger.warn(
          { err: e instanceof Error ? e.message : String(e), token_symbol: event.token_symbol, source: event.source },
          "external_unlock_upsert_skip"
        );
      }
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "ingestExternalUnlocks failed (non-fatal)"
    );
  }
}
