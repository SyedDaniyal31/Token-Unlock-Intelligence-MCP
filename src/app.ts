import "dotenv/config";
import express, { type Request, type Response } from "express";
import cron from "node-cron";
import { z } from "zod";
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
import { registerHealthRoute, registerIntelligenceRoute, registerDiagnosticsRoute, registerMarketRoute, getIntelligenceReport, reportToLegacyShape } from "./api/routes.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { globalRateLimiter } from "./middleware/rateLimiter.js";
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
app.use(express.json({ limit: "1mb" }));
app.use(requestIdMiddleware);
app.use(globalRateLimiter);

registerHealthRoute(app);
registerDiagnosticsRoute(app);
registerMarketRoute(app);
registerIntelligenceRoute(app, deps);

app.use("/mcp", createContextMiddleware());

const mcpServer = new McpServer({
  name: "token-unlock-intelligence-mcp",
  version: "1.0.0",
});

const analyzeTokenUnlockOutputSchema = {
  token_symbol: z.string(),
  next_unlock_date: z.string(),
  unlock_amount: z.number(),
  unlock_percent_supply: z.number(),
  unlock_vs_volume_ratio: z.number(),
  cohort_type: z.string(),
  historical_avg_7d_return: z.number(),
  impact_score: z.string(),
  risk_summary: z.string(),
  fetchedAt: z.string(),
};

type LegacyOutput = {
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

function safeErrorOutput(tokenSymbol: string, riskSummary: string): LegacyOutput {
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

(mcpServer.registerTool as CallableFunction)(
  "analyze_token_unlock",
  {
    description:
      "Analyze upcoming token unlock and quantify sell-pressure risk using liquidity-adjusted impact scoring.",
    inputSchema: {
      token_symbol: z.string().describe("Token ticker symbol (e.g. ETH, ARB)"),
    },
    outputSchema: analyzeTokenUnlockOutputSchema,
  },
  (async (args: { token_symbol?: string }) => {
    const startMs = Date.now();
    const tokenSymbol = (args as { token_symbol?: string }).token_symbol?.trim() ?? "";

    const toResult = (structuredContent: LegacyOutput) => ({
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    });

    try {
      if (!tokenSymbol) {
        const out = safeErrorOutput("", "token_symbol is required.");
        logger.info({
          tool: "analyze_token_unlock",
          token_symbol: out.token_symbol,
          responseTimeMs: Date.now() - startMs,
          resultFound: false,
        });
        return toResult(out);
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
      return toResult(structuredContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "analyze_token_unlock error");
      const out = safeErrorOutput(
        tokenSymbol,
        `Unlock analysis failed: ${message}.`
      );
      return toResult(out);
    }
  })
);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
});

mcpServer.connect(transport).catch((err: Error) => {
  logger.error({ err }, "MCP server connect error");
});

app.post("/mcp", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as unknown;
  const id = body && typeof body === "object" && "id" in body ? (body as { id: unknown }).id : null;
  if (!body || typeof body !== "object") {
    res.status(400).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32700, message: "Parse error" },
    });
    return;
  }
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
    await transport.handleRequest(req, res, body);
  } catch (err) {
    logger.error({ err }, "MCP POST error");
    if (!res.headersSent) {
      const replyId = (body as { id?: unknown }).id ?? null;
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: replyId,
      });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response): Promise<void> => {
  try {
    await transport.handleRequest(req, res);
  } catch (err) {
    logger.error({ err }, "MCP GET error");
    if (!res.headersSent) {
      res.status(500).send("Internal server error");
    }
  }
});

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
