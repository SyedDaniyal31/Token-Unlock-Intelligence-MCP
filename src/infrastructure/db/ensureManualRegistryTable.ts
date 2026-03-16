/**
 * Bootstrap check for unlock_events_external (manual registry) table structure.
 * Runs after migrations. Logs MANUAL_REGISTRY_* events. Additive verification only.
 */

import { query } from "../database/postgres.js";
import logger from "../../core/logger.js";

const TABLE_NAME = "unlock_events_external";
const REQUIRED_COLUMNS = ["token_symbol", "unlock_timestamp", "unlock_amount", "unlock_percent", "source", "created_at"];
const EXPECTED_INDEXES = ["idx_unlock_unique", "idx_unlock_symbol"];

export async function ensureManualRegistryTableChecked(): Promise<void> {
  logger.info("MANUAL_REGISTRY_TABLE_CHECK_STARTED");

  try {
    const tableExists = await query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [TABLE_NAME]
    );
    const exists = tableExists?.rows?.[0]?.exists === true;

    if (!exists) {
      logger.warn({ table: TABLE_NAME }, "MANUAL_REGISTRY_TABLE_MISSING");
      return;
    }

    const columns = await query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [TABLE_NAME]
    );
    const columnSet = new Set((columns?.rows ?? []).map((r) => r.column_name));
    const missing = REQUIRED_COLUMNS.filter((c) => !columnSet.has(c));

    if (missing.length > 0) {
      logger.warn({ table: TABLE_NAME, missing_columns: missing }, "MANUAL_REGISTRY_TABLE_MISSING_COLUMNS");
      return;
    }

    for (const row of columns?.rows ?? []) {
      if (row.column_name === "unlock_timestamp" && row.data_type !== "bigint") {
        logger.warn(
          { table: TABLE_NAME, column: row.column_name, expected: "bigint", actual: row.data_type },
          "MANUAL_REGISTRY_COLUMN_TYPE_MISMATCH"
        );
      }
      if (row.column_name === "unlock_amount" && row.data_type !== "numeric" && row.data_type !== "decimal") {
        logger.warn(
          { table: TABLE_NAME, column: row.column_name, expected: "numeric", actual: row.data_type },
          "MANUAL_REGISTRY_COLUMN_TYPE_MISMATCH"
        );
      }
    }

    logger.info({ table: TABLE_NAME }, "MANUAL_REGISTRY_TABLE_OK");

    const hasExtraColumns = REQUIRED_COLUMNS.some((c) => !columnSet.has(c)) === false &&
      (columns?.rows?.length ?? 0) > REQUIRED_COLUMNS.length;
    if (hasExtraColumns) {
      logger.info({ table: TABLE_NAME }, "MANUAL_REGISTRY_TABLE_UPDATED");
    }

    const indexes = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
      [TABLE_NAME]
    );
    const indexSet = new Set((indexes?.rows ?? []).map((r) => r.indexname));
    for (const idx of EXPECTED_INDEXES) {
      if (indexSet.has(idx)) {
        logger.info({ index: idx, table: TABLE_NAME }, "MANUAL_REGISTRY_INDEX_CREATED");
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), table: TABLE_NAME }, "MANUAL_REGISTRY_TABLE_CHECK_FAILED");
  }
}

const STARTUP_VALIDATION_SYMBOLS = ["HYPE", "ENA", "ARB", "JUP", "W", "TIA", "SUI"];

/**
 * Log unlock_events_external row counts for key symbols (startup validation),
 * along with a global total row count.
 */
export async function logRegistrySymbolCounts(): Promise<void> {
  try {
    const totalRes = await query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM unlock_events_external`
    );
    const totalCount = totalRes?.rows?.[0]?.count ?? "0";
    logger.info(
      { table: TABLE_NAME, totalRows: Number(totalCount) },
      "REGISTRY_TOTAL_ROW_COUNT"
    );

    for (const symbol of STARTUP_VALIDATION_SYMBOLS) {
      const r = await query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM unlock_events_external WHERE UPPER(TRIM(token_symbol)) = $1`,
        [symbol]
      );
      const count = r?.rows?.[0]?.count ?? "0";
      logger.info({ symbol, registryEventCount: Number(count) }, "REGISTRY_STARTUP_VALIDATION");
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "REGISTRY_STARTUP_VALIDATION_FAILED");
  }
}
