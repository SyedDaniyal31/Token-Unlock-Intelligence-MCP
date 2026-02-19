import "dotenv/config";
import pg from "pg";
import type { PoolConfig, QueryResult, QueryResultRow } from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set in environment");
}

const poolConfig: PoolConfig = {
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
};

const pool = new Pool(poolConfig);

pool.on("error", (err: Error): void => {
  console.error("Unexpected pool error:", err.message);
});

/**
 * Run a parameterized query against the database.
 * @throws Error with message and cause when the query fails
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  try {
    const result = await pool.query<T>(text, values);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown database error";
    const cause = err instanceof Error ? err : new Error(String(err));
    throw new Error(`Database query failed: ${message}`, { cause });
  }
}

/**
 * Close the pool. Call during graceful shutdown.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
