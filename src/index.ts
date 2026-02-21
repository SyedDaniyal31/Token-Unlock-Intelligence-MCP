import "dotenv/config";
import { config } from "./core/config.js";
import { start, shutdown } from "./app.js";
import { runMigrations } from "./infrastructure/db/runMigrations.js";
import { syncUnlockRegistryToDb } from "./ingestion/index.js";
import logger from "./core/logger.js";

function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const hasDb = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim().length > 0;
  if (!hasDb) {
    logger.fatal("DATABASE_URL is required in production. Railway: Project → Variables → add DATABASE_URL.");
    process.exit(1);
  }

  const hasRpc = process.env.RPC_URL && String(process.env.RPC_URL).trim().length > 0;
  if (!hasRpc) {
    logger.fatal("RPC_URL is required in production. Railway: Project → Variables → add RPC_URL.");
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  logger.info(
    {
      NODE_ENV: process.env.NODE_ENV ?? "development",
      hasDatabase: Boolean(process.env.DATABASE_URL?.trim()),
      hasRpc: Boolean(process.env.RPC_URL?.trim()),
    },
    "Starting bootstrap"
  );
  validateProductionEnv();

  try {
    await runMigrations();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.fatal({ err, message }, "CRITICAL: Migrations failed; exiting.");
    process.exit(1);
  }

  try {
    await syncUnlockRegistryToDb();
  } catch (err) {
    logger.warn({ err }, "Initial registry sync failed; continuing (idempotent on next cycle).");
  }

  start(config.PORT);
}

bootstrap().catch((err) => {
  logger.fatal({ err }, "Bootstrap failed");
  process.exit(1);
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
