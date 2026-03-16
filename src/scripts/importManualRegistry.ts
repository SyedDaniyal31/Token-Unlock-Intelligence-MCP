/**
 * Full unlock calendar ingestion: import CSV into unlock_events_external.
 * Single transaction, batch inserts, ON CONFLICT DO UPDATE. No truncate or delete.
 *
 * Usage: npx ts-node src/scripts/importManualRegistry.ts <path-to.csv>
 *        node dist/scripts/importManualRegistry.js <path-to.csv>
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import pg from "pg";
import logger from "../core/logger.js";

const { Client } = pg;

const SOURCE = "manual_registry_bulk";
const BATCH_SIZE = 100;

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
  const normalized = s.endsWith(" UTC")
    ? s.replace(" UTC", "Z").replace(" ", "T")
    : s;
  const d = new Date(normalized);
  if (!Number.isFinite(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function toNum(x: unknown): number | null {
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = Number(String(x).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function parseRow(header: string[], line: string, lineNum: number): ParsedRow | null {
  const parts = line.split(",").map((p) => p.trim().replace(/^"|"$/g, ""));
  if (parts.length < 4) return null;
  const byHeader: Record<string, string> = {};
  header.forEach((h, i) => {
    byHeader[h.trim().toLowerCase()] = parts[i] ?? "";
  });
  const token_symbol = (byHeader["token_symbol"] ?? "").trim().toUpperCase();
  const dateStr = byHeader["date"] ?? "";
  const unlock_timestamp = parseUtcToUnixSeconds(dateStr);
  const unlock_amount = toNum(byHeader["unlock_amount"]);
  const unlock_percent = toNum(byHeader["unlock_percent"]);

  if (!token_symbol) return null;
  if (unlock_timestamp == null || unlock_timestamp <= 0) return null;
  if (unlock_amount == null || unlock_amount < 0) return null;

  return {
    token_symbol,
    unlock_timestamp,
    unlock_amount,
    unlock_percent: unlock_percent != null && unlock_percent >= 0 ? unlock_percent : null,
    source: SOURCE,
  };
}

function parseCsv(content: string): { rows: ParsedRow[]; skipped: number } {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], skipped: 0 };
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const row = parseRow(header, lines[i], i + 1);
    if (row) {
      rows.push(row);
    } else {
      skipped++;
      logger.warn({ line: i + 1, raw: lines[i] }, "MANUAL_REGISTRY_ROW_SKIPPED");
    }
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
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Usage: importManualRegistry.ts <path-to.csv>");
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), csvPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error("File not found:", resolvedPath);
    process.exit(1);
  }

  logger.info({ path: resolvedPath }, "MANUAL_REGISTRY_IMPORT_STARTED");

  const raw = fs.readFileSync(resolvedPath, "utf-8");
  const { rows: allRows, skipped } = parseCsv(raw);

  if (allRows.length === 0) {
    logger.info({ skipped }, "MANUAL_REGISTRY_IMPORT_SUCCESS");
    console.log("Rows processed: 0 (valid), skipped:", skipped);
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) {
    logger.error("DATABASE_URL is not set");
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
    logger.info({ rows_processed: processed, batches: Math.ceil(allRows.length / BATCH_SIZE), skipped }, "MANUAL_REGISTRY_IMPORT_SUCCESS");
    console.log("Rows processed (inserted + updated):", processed);
    console.log("Batches:", Math.ceil(allRows.length / BATCH_SIZE));
    if (skipped > 0) console.log("Skipped:", skipped);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, "MANUAL_REGISTRY_IMPORT_FAILED");
    console.error("Import failed:", message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
