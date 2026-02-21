import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import cron from "node-cron";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Server } from "http";
import { config } from "./core/config.js";
import logger from "./core/logger.js";
import { closePool } from "./infrastructure/database/postgres.js";
import { MockEthereumProvider } from "./infrastructure/rpc/ethereumProvider.js";
import { EthereumRpcProvider } from "./infrastructure/rpc/ethereumRpcProvider.js";
import { StubMarketProvider, CoinGeckoMarketProvider } from "./infrastructure/market/marketProvider.js";
import { CachingMarketProvider } from "./infrastructure/market/marketCache.js";
import { DefaultExchangeRegistry } from "./infrastructure/exchanges/exchangeRegistry.js";
import { registerHealthRoute, registerIntelligenceRoute, registerRiskRoute, registerDiagnosticsRoute, registerMarketRoute, getIntelligenceReport, reportToLegacyShape } from "./api/routes.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { globalRateLimiter } from "./middleware/rateLimiter.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { syncUnlockRegistryToDb } from "./ingestion/index.js";
import { runFullIngestionCycle } from "./orchestration/ingestionPipeline.js";
import { runUnlockPrecompute } from "./broker.js";

const rpcUrl = (config.RPC_URL || process.env.RPC_URL || "").trim();
const chainProvider =
  rpcUrl
    ? (() => {
        try {
          return new EthereumRpcProvider(rpcUrl);
        } catch (err) {
          logger.warn({ err: err instanceof Error ? err.message : String(err) }, "EthereumRpcProvider init failed; using mock");
          return new MockEthereumProvider();
        }
      })()
    : new MockEthereumProvider();
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
    message: "MCP endpoint; use POST for JSON-RPC (e.g. tools/list, tools/call).",
    transports: ["streamable-http"],
  });
});

app.use("/mcp", createContextMiddleware());

const mcpServer = new McpServer({
  name: "token-unlock-intelligence-mcp",
  version: "1.0.0",
});

/** Context Protocol compliant: JSON Schema for tool input (required for MCP + Context). */
const ANALYZE_TOKEN_UNLOCK_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    token_symbol: {
      type: "string" as const,
      description: "Token ticker symbol (e.g. ETH, ARB)",
    },
  },
  required: ["token_symbol"] as const,
};

/** Context Protocol compliant: outputSchema for payment verification and dispute resolution. */
const ANALYZE_TOKEN_UNLOCK_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    token_symbol: { type: "string" as const },
    next_unlock_date: { type: "string" as const },
    unlock_amount: { type: "number" as const },
    unlock_percent_supply: { type: "number" as const },
    unlock_vs_volume_ratio: { type: "number" as const },
    cohort_type: { type: "string" as const },
    historical_avg_7d_return: { type: "number" as const },
    impact_score: { type: "string" as const },
    risk_summary: { type: "string" as const },
    fetchedAt: { type: "string" as const },
  },
  required: [
    "token_symbol",
    "next_unlock_date",
    "unlock_amount",
    "unlock_percent_supply",
    "unlock_vs_volume_ratio",
    "cohort_type",
    "historical_avg_7d_return",
    "impact_score",
    "risk_summary",
    "fetchedAt",
  ] as const,
};

type AnalyzeTokenUnlockOutput = {
  token_symbol: string;
  next_unlock_date: string;
  unlock_amount: number;
  unlock_percent_supply: number;
  unlock_vs_volume_ratio: number;
  cohort_type: string;
  historical_avg_7d_return: number;
  impact_score: string;
  risk_summary: string;
  fetchedAt: string;
};

function safeErrorOutput(tokenSymbol: string, riskSummary: string): AnalyzeTokenUnlockOutput {
  return {
    token_symbol: tokenSymbol,
    next_unlock_date: "",
    unlock_amount: 0,
    unlock_percent_supply: 0,
    unlock_vs_volume_ratio: 0,
    cohort_type: "",
    historical_avg_7d_return: 0,
    impact_score: "error",
    risk_summary: riskSummary,
    fetchedAt: new Date().toISOString(),
  };
}

/** Context compliant: both content (backward compat) and structuredContent (required by Context). */
function toToolResult(structuredContent: AnalyzeTokenUnlockOutput) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

(mcpServer.registerTool as CallableFunction)(
  "analyze_token_unlock",
  {
    description:
      "Analyze upcoming token unlock and quantify sell-pressure risk using liquidity-adjusted impact scoring.",
    inputSchema: ANALYZE_TOKEN_UNLOCK_INPUT_SCHEMA,
    outputSchema: ANALYZE_TOKEN_UNLOCK_OUTPUT_SCHEMA,
  },
  (async (args: { token_symbol?: string }) => {
    const startMs = Date.now();
    const tokenSymbol = (args as { token_symbol?: string }).token_symbol?.trim() ?? "";

    try {
      if (!tokenSymbol) {
        const out = safeErrorOutput("", "token_symbol is required.");
        logger.info({
          tool: "analyze_token_unlock",
          token_symbol: out.token_symbol,
          responseTimeMs: Date.now() - startMs,
          resultFound: false,
        });
        return toToolResult(out);
      }

      const report = await getIntelligenceReport(tokenSymbol, deps);
      const structuredContent = reportToLegacyShape(report);
      logger.info({
        tool: "analyze_token_unlock",
        token_symbol: report.token_symbol,
        responseTimeMs: Date.now() - startMs,
        resultFound: true,
        impact_score: report.impact_score,
      });
      return toToolResult(structuredContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "analyze_token_unlock error");
      const out = safeErrorOutput(
        tokenSymbol,
        `Unlock analysis failed: ${message}.`
      );
      return toToolResult(out);
    }
  })
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});

const mcpConnectPromise = mcpServer.connect(transport).catch((err: Error) => {
  logger.error({ err }, "MCP server connect error");
  throw err;
});

app.post(
  "/mcp",
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    logger.info({
      route: "/mcp",
      method: req.method,
      hasBody: !!req.body,
      timestamp: new Date().toISOString(),
    });

    if (!req.body) {
      res.status(400).json({ error: "Missing request body" });
      return;
    }
    if (typeof req.body !== "object") {
      res.status(400).json({ error: "Missing request body" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    const b = body as { jsonrpc?: string; method?: string; params?: { name?: string; arguments?: unknown }; id?: unknown };
    if (b.jsonrpc !== "2.0") {
      res.status(400).json({
        jsonrpc: "2.0",
        id: b.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }
    if (b.method === "tools/call") {
      if (!b.params || typeof b.params !== "object") {
        res.status(400).json({
          jsonrpc: "2.0",
          id: b.id ?? null,
          error: { code: -32602, message: "Invalid params" },
        });
        return;
      }
      if (!b.params.name || typeof b.params.name !== "string") {
        res.status(400).json({
          jsonrpc: "2.0",
          id: b.id ?? null,
          error: { code: -32602, message: "Invalid params: name required" },
        });
        return;
      }
      if (!b.params.arguments || typeof b.params.arguments !== "object") {
        res.status(400).json({
          jsonrpc: "2.0",
          id: b.id ?? null,
          error: { code: -32602, message: "Invalid params: arguments required" },
        });
        return;
      }
      const args = b.params.arguments as Record<string, unknown>;
      if (b.params.name === "analyze_token_unlock") {
        const tokenSymbolVal = (args.token_symbol ?? args.tokenSymbol) ?? "";
        if (!tokenSymbolVal || typeof tokenSymbolVal !== "string" || !String(tokenSymbolVal).trim()) {
          res.status(400).json({
            jsonrpc: "2.0",
            id: b.id ?? null,
            error: { code: -32602, message: "Invalid params: token_symbol required" },
          });
          return;
        }
      }
    }
    try {
      await mcpConnectPromise;
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error(
        { err, method: b.method, id: b.id, message: err instanceof Error ? err.message : String(err) },
        "MCP transport handleRequest error"
      );
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          id: b.id ?? null,
          error: { code: -32603, message: "Internal server error" },
        });
      }
    }
  })
);

app.use(errorHandler);

let httpServer: Server | null = null;

const precomputeCron = cron.schedule("0 */6 * * *", () => {
  syncUnlockRegistryToDb()
    .then(() => runFullIngestionCycle(deps))
    .then(() => runUnlockPrecompute())
    .catch((err: Error) => {
      logger.error({ err, scope: "cron" }, "Ingestion cron error");
    });
});

export function start(port: number): Server {
  httpServer = app.listen(port, (): void => {
    logger.info({ port }, "Server listening");
    syncUnlockRegistryToDb()
      .then(() => runFullIngestionCycle(deps))
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
  await transport.close();
  await closePool();
  process.exit(0);
}
