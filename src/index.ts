import "dotenv/config";
import * as path from "path";
import { config } from "./core/config.js";
import { start, shutdown } from "./app.js";
import { runMigrations } from "./infrastructure/db/runMigrations.js";
import { ensureManualRegistryTableChecked } from "./infrastructure/db/ensureManualRegistryTable.js";
import { syncUnlockRegistryToDb } from "./ingestion/index.js";
import { importManualRegistryFromCmcCsv } from "./scripts/importManualRegistryCmcFormat.js";
import { getConfiguredChains } from "./infrastructure/rpc/chainProviderFactory.js";
import logger from "./core/logger.js";

function validateProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;

  const hasDb = process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim().length > 0;
  if (!hasDb) {
    logger.fatal("DATABASE_URL is required in production. Railway: Project → Variables → add DATABASE_URL.");
    process.exit(1);
  }

  const hasAnyRpc =
    (process.env.RPC_URL && String(process.env.RPC_URL).trim().length > 0) ||
    (process.env.ETH_RPC_URL && String(process.env.ETH_RPC_URL).trim().length > 0) ||
    (process.env.ARB_RPC_URL && String(process.env.ARB_RPC_URL).trim().length > 0) ||
    (process.env.BSC_RPC_URL && String(process.env.BSC_RPC_URL).trim().length > 0);
  if (!hasAnyRpc) {
    logger.fatal(
      "At least one RPC provider must be configured in production. Set RPC_URL, ETH_RPC_URL, ARB_RPC_URL, or BSC_RPC_URL."
    );
    process.exit(1);
  }
}

async function bootstrap(): Promise<void> {
  validateProductionEnv();
  const chains = getConfiguredChains();
  logger.info(
    {
      NODE_ENV: process.env.NODE_ENV ?? "development",
      hasDatabase: Boolean(process.env.DATABASE_URL?.trim()),
      chains_configured: chains,
    },
    "Starting bootstrap"
  );

  try {
    await runMigrations();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.fatal({ err, message }, "CRITICAL: Migrations failed; exiting.");
    process.exit(1);
  }

  try {
    await ensureManualRegistryTableChecked();
  } catch (err) {
    logger.warn({ err }, "Manual registry table check failed; continuing.");
  }

  try {
    const csvPath = path.join(__dirname, "scripts", "manual_registry.csv");
    const cmcImported = await importManualRegistryFromCmcCsv(csvPath);
    if (cmcImported > 0) {
      logger.info({ rows: cmcImported }, "Manual registry CMC CSV imported on startup");
    }
  } catch (err) {
    logger.warn({ err }, "Manual registry CMC import failed; continuing.");
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
