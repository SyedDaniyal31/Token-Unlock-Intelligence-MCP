/**
 * Railway-ready migration runner. Runs on startup before the app serves traffic.
 * Uses pg client directly (no pool) so DB is initialized before app uses it.
 * All migrations are idempotent (IF NOT EXISTS / IF EXISTS where applicable).
 */

import pg from "pg";
import * as fs from "fs";
import * as path from "path";
import logger from "../../core/logger.js";

const { Client } = pg;

const MIGRATION_ORDER: string[] = [
  "sql/schema_unlock_ingestion.sql",
  "sql/schema_unlock_analysis.sql",
  "sql/migration_cluster_flow_engine.sql",
  "sql/migration_vesting_intelligence.sql",
  "sql/migration_vesting_predictive.sql",
  "sql/migration_indexes_performance.sql",
  "sql/migration_multichain.sql",
  "sql/migration_flow_high_velocity_suspected.sql",
  "sql/migration_manual_registry_structure.sql",
  // Market provider IDs and indexes (after unlock_schedules exists; idempotent ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
  "sql/migration_market_ids.sql",
  "sql/migration_market_indexes.sql",
];

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || String(url).trim().length === 0) {
    throw new Error("DATABASE_URL is not set");
  }
  return String(url).trim();
}

/**
 * Directory containing migration SQL files. Prefer dist/sql (filled by build) so
 * running "node dist/index.js" finds sql/ next to dist; fallback to process.cwd()/sql.
 */
function getMigrationRoot(): string {
  try {
    const thisDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
    const distRoot = path.resolve(thisDir, "..", "..");
    const distSql = path.join(distRoot, "sql");
    if (fs.existsSync(distSql)) return distSql;
    const cwdSql = path.join(process.cwd(), "sql");
    if (fs.existsSync(cwdSql)) return cwdSql;
  } catch {
    // ignore
  }
  return path.join(process.cwd(), "sql");
}

function resolveSqlPath(relativePath: string): string {
  const base = path.basename(relativePath);
  const migrationRoot = getMigrationRoot();
  const resolved = path.join(migrationRoot, base);
  return resolved;
}

function loadSql(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Migration file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Execute all migrations in order. Each file runs in its own transaction so a
 * failure in one file does not leave the connection in "transaction aborted"
 * state (Postgres does not allow further commands after any error in a txn).
 * On failure: rollback that file's txn and throw (stops app startup).
 */
export async function runMigrations(): Promise<void> {
  const connectionString = getDatabaseUrl();
  const client = new Client({
    connectionString,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  await client.connect();

  const migrationRoot = getMigrationRoot();
  logger.info({ migrationRoot }, "Migration root resolved");

  try {
    for (let i = 0; i < MIGRATION_ORDER.length; i++) {
      const relativePath = MIGRATION_ORDER[i];
      const absolutePath = resolveSqlPath(relativePath);
      const name = path.basename(relativePath);

      if (!fs.existsSync(absolutePath)) {
        const msg = `Migration file not found: ${absolutePath} (root: ${migrationRoot})`;
        if (i === 0) {
          throw new Error(msg + ". Ensure 'npm run build' ran (copies sql/ to dist/sql).");
        }
        logger.warn({ path: absolutePath }, "Migration file missing; skipping");
        continue;
      }

      const sql = loadSql(absolutePath);
      const rawStatements = sql
        .replace(/\r\n/g, "\n")
        .split(/\s*;\s*\n/)
        .map((s) => s.trim());
      const statements = rawStatements
        .map((s) => s.replace(/^\s*--[^\n]*\n?/gm, "").trim())
        .filter((s) => s.length > 0);

      await client.query("BEGIN");
      try {
        for (const statement of statements) {
          const one = statement.endsWith(";") ? statement : statement + ";";
          await client.query(one);
        }
        await client.query("COMMIT");
      } catch (fileErr) {
        await client.query("ROLLBACK").catch(() => {});
        const message = fileErr instanceof Error ? fileErr.message : String(fileErr);
        logger.error({ err: fileErr, migration: name, message }, "Migration file failed");
        throw new Error(`Migrations failed (${name}): ${message}`);
      }

      logger.info({ migration: name }, "Migration applied");
    }

    logger.info("All migrations completed successfully");
  } finally {
    await client.end();
  }
}
