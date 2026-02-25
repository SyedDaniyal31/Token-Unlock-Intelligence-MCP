/**
 * Unified Unlock Intelligence resolver: aggregates unlock data from multiple sources
 * in strict priority order. Pure resolution only — no SSI, inference, or engine logic.
 */

import { getScheduleByTokenCaseInsensitive, getUnlockEventsInRange } from "../ingestion/unlockRegistry.js";
import { query } from "../infrastructure/database/postgres.js";
import { runUnlockScanner } from "../services/unlockScanner/unlockScanner.js";
import { getCurrentBlock, getBlockTimestamp } from "../services/unlockScanner/chainClient.js";
import { SUPPORTED_CHAINS } from "../utils/tokenResolver.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UnlockEvent {
  /** Unique id if available (registry/external row id). */
  id?: string;
  token_symbol?: string;
  token_address?: string;
  /** Unlock timestamp in Unix seconds. */
  unlock_timestamp: number;
  /** Raw amount string (e.g. wei or human). */
  amount?: string;
  chain_id?: string;
}

export interface ResolveUnifiedUnlockIntelligenceInput {
  tokenAddress?: string;
  tokenSymbol?: string;
  chain: string;
}

export interface ResolveUnifiedUnlockIntelligenceOutput {
  source: "registry" | "external_calendar" | "scanner" | "inferred";
  unlockEvents: UnlockEvent[] | null;
  nextUnlockTimestamp: number | null;
  unlockPressureRatio?: number;
  confidenceScore?: number;
}

/** Chains supported by registry and scanner (same as tokenResolver). */
const REGISTRY_AND_SCANNER_CHAINS = new Set<string>(SUPPORTED_CHAINS);

/** Normalize chain to scanner/registry slug. */
function normalizeChain(chain: string): string {
  const s = (chain ?? "").trim().toLowerCase();
  if (s === "eth") return "ethereum";
  return s;
}

/** Return current time in Unix seconds; use block timestamp when available. */
async function getNowSeconds(chain: string): Promise<number> {
  const norm = normalizeChain(chain);
  if (!REGISTRY_AND_SCANNER_CHAINS.has(norm)) {
    return Math.floor(Date.now() / 1000);
  }
  try {
    const block = await getCurrentBlock(norm as "ethereum" | "bsc" | "arbitrum");
    if (block > 0) {
      const ts = await getBlockTimestamp(norm as "ethereum" | "bsc" | "arbitrum", block);
      if (ts > 0) return ts;
    }
  } catch {
    // fallback to system time
  }
  return Math.floor(Date.now() / 1000);
}

/** Pick nearest future unlock from events; return null if none. */
function nearestFutureUnlock(events: UnlockEvent[], nowSec: number): number | null {
  const future = events
    .map((e) => e.unlock_timestamp)
    .filter((t) => typeof t === "number" && Number.isFinite(t) && t > nowSec);
  if (future.length === 0) return null;
  return Math.min(...future);
}

// ---------------------------------------------------------------------------
// 1. Registry
// ---------------------------------------------------------------------------

async function tryRegistry(
  tokenSymbol: string,
  chain: string,
  nowSec: number
): Promise<ResolveUnifiedUnlockIntelligenceOutput | null> {
  const norm = normalizeChain(chain);
  if (!REGISTRY_AND_SCANNER_CHAINS.has(norm)) return null;

  const schedule = await getScheduleByTokenCaseInsensitive(tokenSymbol, norm);
  if (!schedule) return null;

  const twoYearsMs = 2 * 365 * 24 * 60 * 60 * 1000;
  const since = new Date(nowSec * 1000);
  const until = new Date(nowSec * 1000 + twoYearsMs);
  let eventRows: { id: string; token_symbol: string; amount: string; timestamp: Date | null; chain_id: string | null }[];
  try {
    eventRows = await getUnlockEventsInRange(tokenSymbol, since, until, norm);
  } catch {
    eventRows = [];
  }

  const unlockEvents: UnlockEvent[] = eventRows
    .filter((r) => r.timestamp != null)
    .map((r) => ({
      id: r.id,
      token_symbol: r.token_symbol,
      amount: r.amount,
      unlock_timestamp: Math.floor((r.timestamp as Date).getTime() / 1000),
      chain_id: r.chain_id ?? undefined,
    }))
    .filter((e) => e.unlock_timestamp > nowSec)
    .sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);

  let nextUnlockTimestamp: number | null = nearestFutureUnlock(unlockEvents, nowSec);
  if (schedule.vesting_end) {
    const vestingEndSec = Math.floor(new Date(schedule.vesting_end).getTime() / 1000);
    if (vestingEndSec > nowSec) {
      nextUnlockTimestamp =
        nextUnlockTimestamp == null
          ? vestingEndSec
          : Math.min(nextUnlockTimestamp, vestingEndSec);
    }
  }

  return {
    source: "registry",
    unlockEvents: unlockEvents.length > 0 ? unlockEvents : null,
    nextUnlockTimestamp,
    confidenceScore: 100,
  };
}

// ---------------------------------------------------------------------------
// 2. External calendar (unlock_events_external)
// ---------------------------------------------------------------------------

/** Assumed schema: id?, token_symbol, token_address, chain_id, unlock_timestamp (timestamptz), amount. */
const EXTERNAL_TABLE = "unlock_events_external";

async function tryExternalCalendar(
  tokenSymbol: string | undefined,
  tokenAddress: string | undefined,
  chain: string,
  nowSec: number
): Promise<ResolveUnifiedUnlockIntelligenceOutput | null> {
  if (!tokenSymbol && !tokenAddress) return null;
  const norm = normalizeChain(chain);

  try {
    const sql = `
      SELECT id, token_symbol, chain AS chain_id, unlock_timestamp AS unlock_ts_sec, unlock_amount AS amount
      FROM ${EXTERNAL_TABLE}
      WHERE COALESCE(chain, 'ethereum') = $2
        AND ($1::text IS NULL OR TRIM($1) = '' OR UPPER(TRIM(token_symbol)) = UPPER(TRIM($1)))
        AND unlock_timestamp > $4
      ORDER BY unlock_timestamp ASC
      LIMIT 500
    `;
    const result = await query<{
      id: number | string;
      token_symbol: string | null;
      chain_id: string | null;
      unlock_ts_sec: string | number | null;
      amount: string | number | null;
    }>(sql, [tokenSymbol ?? null, norm, tokenAddress ?? null, nowSec]);

    const rows = result?.rows ?? [];
    const unlockEvents: UnlockEvent[] = rows
      .filter((r) => {
        const sec = r.unlock_ts_sec != null ? Number(r.unlock_ts_sec) : NaN;
        return Number.isFinite(sec) && sec > nowSec;
      })
      .map((r) => ({
        id: r.id != null ? String(r.id) : undefined,
        token_symbol: r.token_symbol ?? undefined,
        unlock_timestamp: Math.floor(Number(r.unlock_ts_sec)),
        amount: r.amount != null ? String(r.amount) : undefined,
        chain_id: r.chain_id ?? undefined,
      }));

    const nextUnlockTimestamp = nearestFutureUnlock(unlockEvents, nowSec);
    if (unlockEvents.length === 0 && nextUnlockTimestamp == null) return null;

    return {
      source: "external_calendar",
      unlockEvents: unlockEvents.length > 0 ? unlockEvents : null,
      nextUnlockTimestamp,
      confidenceScore: 85,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. On-chain scanner
// ---------------------------------------------------------------------------

async function tryScanner(
  tokenAddress: string,
  chain: string,
  nowSec: number
): Promise<ResolveUnifiedUnlockIntelligenceOutput | null> {
  const norm = normalizeChain(chain);
  if (!REGISTRY_AND_SCANNER_CHAINS.has(norm)) return null;

  const addr = tokenAddress.startsWith("0x") ? tokenAddress : "0x" + tokenAddress;
  const executionNowMs = nowSec * 1000;
  const deadlineMs = executionNowMs + 15_000;

  const scannerResult = await runUnlockScanner(
    {
      chain: norm as "ethereum" | "bsc" | "arbitrum",
      tokenAddress: addr,
      circulatingSupply: 1,
      volume30dUsd: 0,
      executionNowMs,
      deadlineMs,
    },
    { deadline: deadlineMs }
  );

  if (scannerResult == null) return null;

  return {
    source: "scanner",
    unlockEvents: null,
    nextUnlockTimestamp: null,
    unlockPressureRatio:
      typeof scannerResult.unlockPressureRatio === "number" && Number.isFinite(scannerResult.unlockPressureRatio)
        ? scannerResult.unlockPressureRatio
        : undefined,
    confidenceScore: 70,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve unlock intelligence from multiple sources in strict priority order:
 * 1. Registry (DB schedule + unlock_events)
 * 2. External calendar (unlock_events_external)
 * 3. On-chain scanner
 * 4. Fallback: inferred (no events)
 *
 * Only future unlocks (unlock_timestamp > currentBlockTimestamp or system time) are considered.
 * Next unlock is the nearest future unlock. Null-safe structure always returned.
 */
export async function resolveUnifiedUnlockIntelligence(
  input: ResolveUnifiedUnlockIntelligenceInput
): Promise<ResolveUnifiedUnlockIntelligenceOutput> {
  const chain = (input?.chain ?? "").trim() || "ethereum";
  const tokenSymbol = (input?.tokenSymbol ?? "").trim() || undefined;
  const tokenAddress = (input?.tokenAddress ?? "").trim() || undefined;

  if (!tokenSymbol && !tokenAddress) {
    return {
      source: "inferred",
      unlockEvents: null,
      nextUnlockTimestamp: null,
    };
  }

  const nowSec = await getNowSeconds(chain);

  // 1. Registry (requires symbol; unsupported chain skipped)
  if (tokenSymbol) {
    const registryResult = await tryRegistry(tokenSymbol, chain, nowSec);
    if (registryResult != null) return registryResult;
  }

  // 2. External calendar (symbol or address)
  const externalResult = await tryExternalCalendar(tokenSymbol, tokenAddress, chain, nowSec);
  if (externalResult != null) return externalResult;

  // 3. Scanner (requires tokenAddress; unsupported chain skipped)
  if (tokenAddress) {
    const scannerResult = await tryScanner(tokenAddress, chain, nowSec);
    if (scannerResult != null) return scannerResult;
  }

  // 4. Fallback
  return {
    source: "inferred",
    unlockEvents: null,
    nextUnlockTimestamp: null,
  };
}
