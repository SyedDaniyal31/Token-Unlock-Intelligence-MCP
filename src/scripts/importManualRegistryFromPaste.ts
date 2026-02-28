/**
 * Import manual registry unlock data from pasted CSV content.
 * Paste your CSV into RAW_CSV below, then run: npm run import:registry:paste
 *
 * Expected columns: Ticker, Unlock Tokens, Token Unlock %, Unlock date
 * Additive UPSERT only; no truncate or delete.
 */

import "dotenv/config";
import pg from "pg";

const { Client } = pg;

const SOURCE = "manual_registry_bulk";
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// Paste your CSV content between the backticks (replace the example rows).
// Header must be: Ticker, Unlock Tokens, Token Unlock %, Unlock date
// ---------------------------------------------------------------------------
const RAW_CSV = `
Ticker,Unlock Tokens,Token Unlock %,Unlock date
ARB,1000000,1.5,2025-03-01 12:00:00 UTC
OP,500000,0.8,2025-03-15 00:00:00 UTC
`;

interface ParsedRow {
  token_symbol: string;
  unlock_timestamp: number;
  unlock_amount: number;
  unlock_percent: number | null;
  source: string;
}

function parseUtcToUnixSeconds(dateStr: string): number | null {
  const s = (dateStr ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function toNum(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(String(x).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/** Simple CSV parse: split by comma, strip optional quotes per cell. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      result.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else if (c !== "\n" && c !== "\r") {
      current += c;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ""));
  return result;
}

function parseCsv(content: string): { rows: ParsedRow[]; skipped: number } {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return { rows: [], skipped: 0 };

  const headerRow = parseCsvLine(lines[0]);
  const headerNorm = headerRow.map((h) => h.trim().toLowerCase());
  const byName: Record<string, number> = {};
  headerNorm.forEach((h, i) => {
    if (byName[h] === undefined) byName[h] = i;
  });

  const tickerIdx =
    byName["ticker"] ?? byName["token_symbol"] ?? 0;
  const unlockTokensIdx =
    byName["unlock tokens"] ?? byName["unlock_amount"] ?? 3;
  const unlockPctIdx =
    byName["token unlock %"] ?? byName["unlock_percent"] ?? 4;
  const unlockDateIdx =
    byName["unlock date"] ?? byName["date"] ?? Math.max(0, headerNorm.length - 1);

  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const ticker = (parts[tickerIdx] ?? "").trim().toUpperCase();
    const unlockAmount = toNum(parts[unlockTokensIdx]);
    const unlockPercent = toNum(parts[unlockPctIdx]);
    const dateStr = parts[unlockDateIdx] ?? "";
    const unlock_timestamp = parseUtcToUnixSeconds(dateStr);

    if (!ticker) {
      skipped++;
      console.warn("MANUAL_REGISTRY_ROW_SKIPPED", { line: i + 1, raw: lines[i] });
      continue;
    }
    if (unlock_timestamp == null || unlock_timestamp <= 0) {
      skipped++;
      console.warn("MANUAL_REGISTRY_ROW_SKIPPED", { line: i + 1, raw: lines[i] });
      continue;
    }
    if (unlockAmount == null || unlockAmount <= 0) {
      skipped++;
      console.warn("MANUAL_REGISTRY_ROW_SKIPPED", { line: i + 1, raw: lines[i] });
      continue;
    }

    rows.push({
      token_symbol: ticker,
      unlock_timestamp,
      unlock_amount: unlockAmount,
      unlock_percent: unlockPercent != null && unlockPercent >= 0 ? unlockPercent : null,
      source: SOURCE,
    });
  }
  return { rows, skipped };
}

function buildBatchValues(batch: ParsedRow[]): { sql: string; values: unknown[] } {
  const placeholders: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const r of batch) {
    placeholders.push(
      `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, NOW())`
    );
    values.push(r.token_symbol, r.unlock_timestamp, r.unlock_amount, r.unlock_percent, r.source);
    idx += 5;
  }
  const sql = `
    INSERT INTO unlock_events_external (
      token_symbol,
      unlock_timestamp,
      unlock_amount,
      unlock_percent,
      source,
      created_at
    )
    VALUES ${placeholders.join(",\n")}
    ON CONFLICT (token_symbol, unlock_timestamp)
    DO UPDATE SET
      unlock_amount = EXCLUDED.unlock_amount,
      unlock_percent = EXCLUDED.unlock_percent,
      source = EXCLUDED.source
  `;
  return { sql, values };
}

async function run(): Promise<void> {
  console.log("MANUAL_REGISTRY_IMPORT_STARTED");

  const { rows: allRows, skipped } = parseCsv(RAW_CSV);

  if (allRows.length === 0) {
    console.log("MANUAL_REGISTRY_IMPORT_SUCCESS", { rows_processed: 0, skipped });
    console.log("Rows processed: 0, skipped:", skipped);
    process.exit(0);
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("MANUAL_REGISTRY_IMPORT_FAILED: DATABASE_URL is not set");
    process.exit(1);
  }

  const client = new Client({
    connectionString: connectionString.trim(),
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    await client.query("BEGIN");

    let processed = 0;
    for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
      const batch = allRows.slice(i, i + BATCH_SIZE);
      const { sql, values } = buildBatchValues(batch);
      await client.query(sql, values);
      processed += batch.length;
    }

    await client.query("COMMIT");
    console.log("MANUAL_REGISTRY_IMPORT_SUCCESS", {
      rows_processed: processed,
      batches: Math.ceil(allRows.length / BATCH_SIZE),
      skipped,
    });
    console.log("Rows processed (inserted + updated):", processed);
    console.log("Batches:", Math.ceil(allRows.length / BATCH_SIZE));
    if (skipped > 0) console.log("Skipped:", skipped);
    process.exit(0);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error("MANUAL_REGISTRY_IMPORT_FAILED", message);
    console.error("Import failed:", message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
