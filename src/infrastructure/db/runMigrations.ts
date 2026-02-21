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
 * Execute all migrations in order inside a single transaction.
 * On failure: rollback and throw (stops app startup).
 */
export async function runMigrations(): Promise<void> {
  const connectionString = getDatabaseUrl();
  const client = new Client({
    connectionString,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  await client.connect();

  try {
    await client.query("BEGIN");

    const migrationRoot = getMigrationRoot();
    logger.info({ migrationRoot }, "Migration root resolved");

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

      for (const statement of statements) {
        const one = statement.endsWith(";") ? statement : statement + ";";
        try {
          await client.query(one);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("already exists") || msg.includes("duplicate key")) {
            logger.debug({ migration: name }, "Object already exists (idempotent)");
          } else {
            throw err;
          }
        }
      }

      logger.info({ migration: name }, "Migration applied");
    }

    await client.query("COMMIT");
    logger.info("All migrations completed successfully");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, message }, "CRITICAL: Migrations failed");
    throw new Error(`Migrations failed: ${message}`);
  } finally {
    await client.end();
  }
}
