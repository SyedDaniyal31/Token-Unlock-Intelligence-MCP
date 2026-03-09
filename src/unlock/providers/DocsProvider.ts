/**
 * DocsProvider: fallback when API providers fail. Fetches official project docs,
 * tokenomics pages, and GitBook-style docs; extracts vesting schedule via pattern
 * detection and returns normalized unlock events. Cache: 24 hours.
 */

import type { AssetMetadata } from "../../core/assetResolver.js";
import type { NormalizedUnlockEvent, UnlockFetchResult } from "./UnlockProvider.js";
import type { UnlockProvider } from "./UnlockProvider.js";
import logger from "../../core/logger.js";

export const DOCS_PARSE_FAILURE_REASON =
  "Unlock schedule could not be derived from APIs or documentation";

const DOCS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BODY_LENGTH = 500_000;

/** Known doc/tokenomics URLs per symbol (lowercase). Add more as needed. */
const TOKEN_DOC_URLS: Record<string, string[]> = {
  ena: [
    "https://docs.ethena.fi/ena/tokenomics",
    "https://ethena.fi/tokenomics",
    "https://docs.ethena.fi/tokenomics",
  ],
  hype: [
    "https://hyperliquid.xyz/docs/tokenomics",
    "https://docs.hyperliquid.xyz/tokenomics",
    "https://hyperliquid.xyz/tokenomics",
    "https://hyperliquid.gitbook.io/hyperliquid/tokenomics",
  ],
  arb: ["https://docs.arbitrum.foundation/tokenomics", "https://arbitrum.foundation/token"],
  op: ["https://docs.optimism.io/token", "https://optimism.io/tokenomics"],
  tia: ["https://docs.celestia.org/token", "https://celestia.org/tokenomics"],
  strk: ["https://docs.starknet.io/token", "https://starknet.io/tokenomics"],
  sui: ["https://docs.sui.io/tokenomics", "https://sui.io/tokenomics"],
};

const VESTING_PATTERNS = [
  /\bcliff\b/i,
  /\blinear\s+vesting\b/i,
  /\bmonthly\s+unlock\b/i,
  /\binvestor\s+vesting\b/i,
  /\bteam\s+vesting\b/i,
  /\bvesting\s+schedule\b/i,
  /\bunlock\s+schedule\b/i,
  /\b(allocation|distribution)\s+(breakdown|structure)\b/i,
  /\b(\d+)\s*%\s*(cliff|at\s+TGE|unlock)/i,
  /\b(\d+)\s*(year|month)\s*(cliff|linear|vesting)/i,
  /\bTGE\b/i,
  /\b(token\s+generation|token\s+unlock)/i,
  /\bvesting\b/i,
  /\bunlock\b/i,
];

/** Match ISO date or "Month DD, YYYY" or "DD Month YYYY". */
const DATE_PATTERNS = [
  /\b(20\d{2})-(\d{2})-(\d{2})\b/g,
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/gi,
  /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2})\b/gi,
];

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Extract numbers like "15 billion", "1.5B", "30%". */
function extractSupplyHints(text: string): { totalSupply?: number; percentUnlock?: number } {
  const out: { totalSupply?: number; percentUnlock?: number } = {};
  const billion = text.match(/(\d+(?:\.\d+)?)\s*billion\b/i) ?? text.match(/(\d+(?:\.\d+)?)\s*B\b/i);
  if (billion) {
    const n = parseFloat(billion[1]!);
    if (Number.isFinite(n)) out.totalSupply = n * 1e9;
  }
  const million = text.match(/(\d+(?:\.\d+)?)\s*million\b/i) ?? text.match(/(\d+(?:\.\d+)?)\s*M\b/i);
  if (million && out.totalSupply == null) {
    const n = parseFloat(million[1]!);
    if (Number.isFinite(n)) out.totalSupply = n * 1e6;
  }
  const pct = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:cliff|at\s+cliff|unlock|at\s+TGE)/i);
  if (pct) {
    const n = parseFloat(pct[1]!);
    if (Number.isFinite(n)) out.percentUnlock = n;
  }
  return out;
}

function parseDateFromMatch(m: RegExpMatchArray): number | null {
  const s = m[0]!;
  const iso = s.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (iso) {
    const y = parseInt(iso[1]!, 10);
    const mo = parseInt(iso[2]!, 10) - 1;
    const d = parseInt(iso[3]!, 10);
    const date = new Date(Date.UTC(y, mo, d));
    return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : null;
  }
  const parts = s.split(/\s+/);
  if (parts.length >= 3) {
    let month = -1;
    let day = -1;
    let year = -1;
    for (const p of parts) {
      const lower = p.replace(/,/g, "").toLowerCase();
      if (MONTH_NAMES[lower] !== undefined) month = MONTH_NAMES[lower]!;
      else if (/^\d{1,2}$/.test(p)) day = parseInt(p, 10);
      else if (/^20\d{2}$/.test(p)) year = parseInt(p, 10);
    }
    if (month >= 0 && day >= 0 && year >= 0) {
      const date = new Date(Date.UTC(year, month, day));
      return Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : null;
    }
  }
  return null;
}

/** Collect all date-like timestamps from text (past and future). */
function extractDates(text: string): number[] {
  const timestamps: number[] = [];
  for (const re of DATE_PATTERNS) {
    const copy = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = copy.exec(text)) !== null) {
      const ts = parseDateFromMatch(m);
      if (ts != null) timestamps.push(ts);
    }
  }
  return [...new Set(timestamps)].sort((a, b) => a - b);
}

/** Detect vesting-related phrases and return whether we have enough to synthesize events. */
function detectVestingPatterns(text: string): { matched: boolean; category: "team" | "investor" | "ecosystem" | "foundation" | "unknown" } {
  let matched = false;
  let category: "team" | "investor" | "ecosystem" | "foundation" | "unknown" = "unknown";
  const lower = text.toLowerCase();
  for (const re of VESTING_PATTERNS) {
    if (re.test(text)) matched = true;
  }
  if (/\bteam\b|\bfounder\b|\bcore\s+contributor\b/i.test(lower)) category = "team";
  else if (/\binvestor\b|\bprivate\s+sale\b/i.test(lower)) category = "investor";
  else if (/\becosystem\b|\bcommunity\b|\bairdrop\b/i.test(lower)) category = "ecosystem";
  else if (/\bfoundation\b/i.test(lower)) category = "foundation";
  return { matched, category };
}

/** Build synthetic unlock events from parsed hints and dates. */
function buildEventsFromHints(
  symbol: string,
  text: string,
  nowSec: number
): NormalizedUnlockEvent[] {
  const hints = extractSupplyHints(text);
  const dates = extractDates(text);
  const { matched, category } = detectVestingPatterns(text);
  if (!matched && dates.length === 0) return [];

  const totalSupply = hints.totalSupply ?? 0;
  const percentPerUnlock = hints.percentUnlock ?? 2.78; // ~1/36 for 3-year monthly

  const events: NormalizedUnlockEvent[] = [];
  const futureDates = dates.filter((ts) => ts > nowSec).slice(0, 24);
  if (futureDates.length > 0) {
    const amountPerEvent = totalSupply > 0
      ? (totalSupply * (percentPerUnlock / 100))
      : 0;
    for (const ts of futureDates) {
      events.push({
        token_symbol: symbol,
        unlock_timestamp: ts,
        unlock_amount: amountPerEvent,
        unlock_percent: percentPerUnlock,
        source: "DocsProvider",
      });
    }
  }

  if (events.length > 0) return events;

  // No future dates found but we have vesting language: assume next 12 months, monthly.
  if (matched) {
    const amountPerMonth = totalSupply > 0 ? (totalSupply * (percentPerUnlock / 100)) : 0;
    for (let i = 1; i <= 12; i++) {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() + i);
      d.setUTCDate(1);
      d.setUTCHours(12, 0, 0, 0);
      const ts = Math.floor(d.getTime() / 1000);
      if (ts > nowSec) {
        events.push({
          token_symbol: symbol,
          unlock_timestamp: ts,
          unlock_amount: amountPerMonth,
          unlock_percent: percentPerUnlock,
          source: "DocsProvider",
        });
      }
    }
  }

  return events.sort((a, b) => a.unlock_timestamp - b.unlock_timestamp);
}

async function fetchUrlAsText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "TokenUnlockIntelligence/1.0 (docs parser)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return "";
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("application/pdf")) return "";
    const html = await res.text();
    if (html.length > MAX_BODY_LENGTH) return html.slice(0, MAX_BODY_LENGTH);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  } catch {
    clearTimeout(timeout);
    return "";
  }
}

const docsCache = new Map<string, { result: UnlockFetchResult; expiresAt: number }>();

export class DocsProvider implements UnlockProvider {
  readonly name = "DocsProvider";

  supports(_asset: AssetMetadata): boolean {
    return true;
  }

  async fetchUnlocks(asset: AssetMetadata): Promise<UnlockFetchResult> {
    const symbol = asset.symbol.trim().toUpperCase();
    const key = `docs:${asset.chain}:${symbol}`;
    const cached = docsCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return structuredClone(cached.result);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const urls = TOKEN_DOC_URLS[symbol.toLowerCase()] ?? [];
    if (urls.length === 0) {
      const noData: UnlockFetchResult = {
        success: false,
        source: "DocsProvider",
        events: [],
        error: DOCS_PARSE_FAILURE_REASON,
      };
      docsCache.set(key, { result: noData, expiresAt: Date.now() + DOCS_CACHE_TTL_MS });
      return noData;
    }

    for (const url of urls) {
      try {
        const text = await fetchUrlAsText(url);
        if (!text || text.length < 200) continue;
        const events = buildEventsFromHints(symbol, text, nowSec);
        if (events.length > 0) {
          const future = events.filter((e) => e.unlock_timestamp > nowSec);
          const toUse = future.length > 0 ? future : events;
          const result: UnlockFetchResult = {
            success: true,
            source: "DocsProvider",
            events: toUse,
            next_unlock_timestamp: toUse.length > 0 ? toUse[0]!.unlock_timestamp : null,
            confidence_score: 0.5,
          };
          docsCache.set(key, { result, expiresAt: Date.now() + DOCS_CACHE_TTL_MS });
          logger.info({ symbol: asset.symbol, url, eventsCount: toUse.length }, "DOCSPROVIDER_FETCH_SUCCESS");
          return result;
        }
      } catch (err) {
        logger.debug({ symbol: asset.symbol, url, err: err instanceof Error ? err.message : String(err) }, "DOCSPROVIDER_FETCH_FAILED");
      }
    }

    const noData: UnlockFetchResult = {
      success: false,
      source: "DocsProvider",
      events: [],
      error: DOCS_PARSE_FAILURE_REASON,
    };
    docsCache.set(key, { result: noData, expiresAt: Date.now() + DOCS_CACHE_TTL_MS });
    logger.info({ symbol: asset.symbol }, "DOCSPROVIDER_PARSE_FAILED");
    return noData;
  }
}

export const docsProvider = new DocsProvider();
