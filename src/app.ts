import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import cron from "node-cron";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import type { Server as HttpServer } from "http";
import { config } from "./core/config.js";
import logger from "./core/logger.js";
import { closePool } from "./infrastructure/database/postgres.js";
import { getChainProvider } from "./infrastructure/rpc/chainProviderFactory.js";
import { StubMarketProvider, CoinGeckoMarketProvider } from "./infrastructure/market/marketProvider.js";
import { CachingMarketProvider } from "./infrastructure/market/marketCache.js";
import { DefaultExchangeRegistry } from "./infrastructure/exchanges/exchangeRegistry.js";
import { registerHealthRoute, registerIntelligenceRoute, registerRiskRoute, registerDiagnosticsRoute, registerMarketRoute } from "./api/routes.js";
import { registerMcpRoute } from "./api/registerMcpRoute.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { globalRateLimiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { syncUnlockRegistryToDb } from "./ingestion/index.js";
import { ingestExternalUnlocks } from "./ingestion/externalUnlockIngestion.js";
import { runFullIngestionCycle } from "./orchestration/ingestionPipeline.js";
import { runUnlockPrecompute } from "./broker.js";

const chainProvider = getChainProvider("ethereum");
const baseMarketProvider = config.COINGECKO_API_KEY
  ? new CoinGeckoMarketProvider(config.COINGECKO_API_KEY)
  : new StubMarketProvider();
const marketProvider = new CachingMarketProvider(baseMarketProvider);
const exchangeRegistry = new DefaultExchangeRegistry();

const deps = {
  chainProvider,
  marketProvider,
  exchangeRegistry,
};

const app = express();
// Railway runs behind a single reverse proxy.
// Required for express-rate-limit to correctly read X-Forwarded-For.
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(requestIdMiddleware);
app.use(globalRateLimiter);

registerHealthRoute(app);
registerDiagnosticsRoute(app);
registerMarketRoute(app);
registerIntelligenceRoute(app, deps);
registerRiskRoute(app, deps);

app.get("/", (_req: Request, res: Response): void => {
  res.status(200).json({
    name: "token-unlock-intelligence-mcp",
    status: "ok",
    endpoints: {
      health: "/health",
      diagnostics: "/diagnostics",
      intelligence: "POST /intelligence, GET /intelligence?token=SYMBOL",
      risk: "POST /risk, GET /risk?token=SYMBOL",
      market: "GET /market",
      mcp: "GET /mcp (discovery), POST /mcp (JSON-RPC)",
    },
  });
});

app.get("/mcp", (_req: Request, res: Response): void => {
  res.status(200).json({
    ok: true,
    protocol: "mcp",
    message: "POST JSON-RPC: initialize, listTools (or tools/list), callTool (or tools/call).",
  });
});

const verifyContextAuth = createContextMiddleware();
registerMcpRoute(app, deps, [verifyContextAuth]);

app.use(errorHandler);

let httpServer: HttpServer | null = null;

const precomputeCron = cron.schedule("0 */6 * * *", () => {
  syncUnlockRegistryToDb()
    .then(() => runFullIngestionCycle(deps))
    .then(() => ingestExternalUnlocks())
    .then(() => runUnlockPrecompute())
    .catch((err: Error) => {
      logger.error({ err, scope: "cron" }, "Ingestion cron error");
    });
});

export function start(port: number): HttpServer {
  httpServer = app.listen(port, (): void => {
    logger.info({ port }, "Server listening");
    syncUnlockRegistryToDb()
      .then(() => runFullIngestionCycle(deps))
      .then(() => ingestExternalUnlocks())
      .then(() => runUnlockPrecompute())
      .catch((err: Error) => {
        logger.error({ err }, "Initial ingestion cycle error");
      });
  });
  return httpServer;
}

export async function shutdown(): Promise<void> {
  logger.info("Shutting down...");
  precomputeCron.stop();
  if (httpServer) {
    httpServer.close();
  }
  await closePool();
  process.exit(0);
}
