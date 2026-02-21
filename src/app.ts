import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import cron from "node-cron";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type CallToolRequest,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { Server as HttpServer } from "http";
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
    message: "MCP endpoint; use POST for JSON-RPC (e.g. initialize, tools/list, tools/call).",
    transports: ["streamable-http"],
  });
});

/** Tool definitions with outputSchema (Context Protocol compliant). See: https://github.com/ctxprotocol/sdk/tree/main/examples/server */
const MCP_TOOLS = [
  {
    name: "analyze_token_unlock",
    description:
      "Analyze upcoming token unlock and quantify sell-pressure risk using liquidity-adjusted impact scoring.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: {
          type: "string" as const,
          description: "Token ticker symbol (e.g. ETH, ARB)",
          default: "ARB",
        },
      },
      required: ["token_symbol"] as const,
    },
    outputSchema: {
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
    },
  },
];

const mcpServer = new Server(
  { name: "token-unlock-intelligence-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: MCP_TOOLS }));

mcpServer.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    const raw =
      args?.token_symbol ?? (args as { tokenSymbol?: string } | undefined)?.tokenSymbol ?? "ARB";
    const tokenSymbol = (typeof raw === "string" ? raw : String(raw ?? "")).trim() || "ARB";

    const successResult = (data: AnalyzeTokenUnlockOutput): CallToolResult => ({
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      structuredContent: data,
    });
    const errorResult = (message: string): CallToolResult => ({
      content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      isError: true,
    });

    const safeOutput = (sym: string, summary: string): AnalyzeTokenUnlockOutput => ({
      token_symbol: sym,
      next_unlock_date: "",
      unlock_amount: 0,
      unlock_percent_supply: 0,
      unlock_vs_volume_ratio: 0,
      cohort_type: "",
      historical_avg_7d_return: 0,
      impact_score: "error",
      risk_summary: summary,
      fetchedAt: new Date().toISOString(),
    });

    if (name !== "analyze_token_unlock") return errorResult(`Unknown tool: ${name}`);

    const symbol = tokenSymbol || "ARB";

    const TOOL_TIMEOUT_MS = 25_000;

    try {
      const report = await Promise.race([
        getIntelligenceReport(symbol, deps),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
        ),
      ]);
      const structuredContent = reportToLegacyShape(report);
      logger.info({ tool: "analyze_token_unlock", token_symbol: report.token_symbol, impact_score: report.impact_score });
      return successResult(structuredContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "analyze_token_unlock error");
      const summary = message.includes("timed out")
        ? "Analysis timed out; try again or use a different token."
        : `Unlock analysis failed: ${message}.`;
      return successResult(safeOutput(symbol, summary));
    }
  }
);

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

const mcpTransports: Record<string, StreamableHTTPServerTransport> = {};
const verifyContextAuth = createContextMiddleware();

app.post(
  "/mcp",
  verifyContextAuth,
  asyncHandler(async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && mcpTransports[sessionId]) {
      transport = mcpTransports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          mcpTransports[id] = transport;
          logger.info({ sessionId: id }, "MCP session initialized");
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete mcpTransports[transport.sessionId];
          logger.info({ sessionId: transport.sessionId }, "MCP session closed");
        }
      };
      await mcpServer.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid session. Send initialize request first." },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  })
);

app.get("/mcp", verifyContextAuth, async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? mcpTransports[sessionId] : undefined;
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response): Promise<void> => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? mcpTransports[sessionId] : undefined;
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.use(errorHandler);

let httpServer: HttpServer | null = null;

const precomputeCron = cron.schedule("0 */6 * * *", () => {
  syncUnlockRegistryToDb()
    .then(() => runFullIngestionCycle(deps))
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
  await Promise.all(Object.values(mcpTransports).map((t) => t.close()));
  await closePool();
  process.exit(0);
}
