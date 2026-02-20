import pg from "pg";
import type { PoolConfig, QueryResult, QueryResultRow } from "pg";
import { config } from "../../core/config.js";
import logger from "../../core/logger.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getConnectionString(): string {
  const url = config.DATABASE_URL || process.env.DATABASE_URL;
  return url && String(url).trim() ? String(url).trim() : "";
}

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. On Railway: add it in Project → Variables, or link a PostgreSQL database."
    );
  }
  const poolConfig: PoolConfig = {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    ssl:
      config.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false,
  };
  pool = new Pool(poolConfig);
  pool.on("error", (err: Error): void => {
    logger.error({ err: err.message, message: "Unexpected pool error" });
  });
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  try {
    return await getPool().query<T>(text, values);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    throw new Error(`Database query failed: ${message}`);
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
