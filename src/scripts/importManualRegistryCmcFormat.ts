/**
 * Import manual_registry.csv (CoinMarketCap-style format) into unlock_events_external.
 * Format: project_name, token_symbol, circulating_supply, unlock_amount, unlock_percent, unlock_date
 *
 * Usage: npx ts-node src/scripts/importManualRegistryCmcFormat.ts [path-to.csv]
 *        node dist/scripts/importManualRegistryCmcFormat.js [path-to.csv]
 * Default path: src/scripts/manual_registry.csv
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import logger from "../core/logger.js";

const { Client } = pg;

const SOURCE = "manual_registry_cmc";
const BATCH_SIZE = 100;
const DEFAULT_CSV = "src/scripts/manual_registry.csv";

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
  const str = String(x).replace(/,/g, "").trim();
  if (str.toLowerCase().includes("e")) {
    const n = parseFloat(str);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse CMC-style CSV: project_name, token_symbol, circulating_supply, unlock_amount, unlock_percent, unlock_date
 * Column indices: 0=project, 1=token_symbol, 2=circulating_supply, 3=unlock_amount, 4=unlock_percent, 5=date
 */
function parseCmcCsv(content: string): { rows: ParsedRow[]; skipped: number } {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], skipped: 0 };

  const rows: ParsedRow[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
    const token_symbol = (parts[1] ?? "").trim().toUpperCase().replace(/^\$/, "");
    const unlock_amount = toNum(parts[3]);
    const unlock_percent = toNum(parts[4]);
    const dateStr = parts[5] ?? "";
    const unlock_timestamp = parseUtcToUnixSeconds(dateStr);

    if (!token_symbol) {
      skipped++;
      continue;
    }
    if (unlock_timestamp == null || unlock_timestamp <= 0) {
      skipped++;
      continue;
    }
    if (unlock_amount == null || unlock_amount < 0) {
      skipped++;
      continue;
    }

    rows.push({
      token_symbol,
      unlock_timestamp,
      unlock_amount,
      unlock_percent: unlock_percent != null && unlock_percent >= 0 ? unlock_percent : null,
      source: SOURCE,
    });
  }

  // Deduplicate by (token_symbol, unlock_timestamp) to avoid "ON CONFLICT DO UPDATE cannot affect row a second time"
  const uniqueMap = new Map<string, ParsedRow>();
  for (const row of rows) {
    const key = `${row.token_symbol}_${row.unlock_timestamp}`;
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, row);
    }
  }
  const deduplicatedRows = Array.from(uniqueMap.values());
  const duplicatesRemoved = rows.length - deduplicatedRows.length;
  if (duplicatesRemoved > 0) {
    logger.info({ count: duplicatesRemoved }, "MANUAL_REGISTRY_DUPLICATES_REMOVED");
  }
  return { rows: deduplicatedRows, skipped };
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

/**
 * Import manual_registry.csv into unlock_events_external. Callable from bootstrap.
 * @param csvPath - Path to CSV (default: dist/scripts/manual_registry.csv when run from app)
 * @returns Number of rows processed, or 0 if file missing or no DB
 */
export async function importManualRegistryFromCmcCsv(csvPath?: string): Promise<number> {
  const resolvedPath = csvPath
    ? path.resolve(csvPath)
    : path.resolve(process.cwd(), DEFAULT_CSV);

  if (!fs.existsSync(resolvedPath)) {
    logger.debug({ path: resolvedPath }, "MANUAL_REGISTRY_CMC_CSV_NOT_FOUND");
    return 0;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) {
    logger.debug("MANUAL_REGISTRY_CMC_IMPORT_SKIP_NO_DATABASE");
    return 0;
  }

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  const { rows: allRows, skipped } = parseCmcCsv(raw);

  if (allRows.length === 0) {
    logger.info({ skipped }, "MANUAL_REGISTRY_CMC_IMPORT_SUCCESS");
    return 0;
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
    logger.info(
      { rows_processed: processed, batches: Math.ceil(allRows.length / BATCH_SIZE), skipped },
      "MANUAL_REGISTRY_CMC_IMPORT_SUCCESS"
    );
    return processed;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MANUAL_REGISTRY_CMC_IMPORT_FAILED");
    return 0; // Do not throw; allow server to continue startup
  } finally {
    await client.end();
  }
}

async function run(): Promise<void> {
  const csvPath = process.argv[2] ?? path.join(process.cwd(), DEFAULT_CSV);
  const resolvedPath = path.resolve(process.cwd(), csvPath);

  if (!fs.existsSync(resolvedPath)) {
    console.error("File not found:", resolvedPath);
    return;
  }

  logger.info({ path: resolvedPath }, "MANUAL_REGISTRY_CMC_IMPORT_STARTED");
  console.log("Importing from:", resolvedPath);

  try {
    const processed = await importManualRegistryFromCmcCsv(resolvedPath);
    console.log("Rows processed (inserted + updated):", processed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Import failed:", message);
    // Do not exit(1); allow process to finish without crashing
  }
}

run();
