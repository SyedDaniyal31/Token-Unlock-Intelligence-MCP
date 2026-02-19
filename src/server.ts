import "dotenv/config";
import express, { type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import cron from "node-cron";
import { z } from "zod";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { query, closePool } from "./db.js";
import {
  runUnlockPrecompute,
  runUnlockIngestionPipeline,
  initializeUnlockEngine,
} from "./broker.js";
import logger from "./logger.js";
import type { Server } from "http";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get("/health", (_req: Request, res: Response): void => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Protect /mcp: requires Context Protocol JWT in Authorization header; returns 401 if unauthorized
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

/** Exact output shape for analyze_token_unlock; no extra fields. */
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

function safeErrorOutput(
  tokenSymbol: string,
  riskSummary: string
): AnalyzeTokenUnlockOutput {
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

function rowToOutput(row: {
  token_symbol: string | null;
  next_unlock_date: Date | null;
  unlock_amount: string | null;
  unlock_percent_supply: string | null;
  unlock_vs_volume_ratio: string | null;
  cohort_type: string | null;
  historical_avg_7d_return: string | null;
  impact_score: string | null;
  risk_summary: string | null;
  updated_at: Date | null;
}): AnalyzeTokenUnlockOutput {
  const num = (v: string | null): number =>
    v === null || v === "" ? 0 : Number(v);
  const str = (v: string | null): string => (v === null ? "" : String(v));
  const dateStr = (d: Date | null): string =>
    d ? new Date(d).toISOString() : "";
  return {
    token_symbol: str(row.token_symbol),
    next_unlock_date: dateStr(row.next_unlock_date),
    unlock_amount: num(row.unlock_amount),
    unlock_percent_supply: num(row.unlock_percent_supply),
    unlock_vs_volume_ratio: num(row.unlock_vs_volume_ratio),
    cohort_type: str(row.cohort_type),
    historical_avg_7d_return: num(row.historical_avg_7d_return),
    impact_score: str(row.impact_score),
    risk_summary: str(row.risk_summary),
    fetchedAt: dateStr(row.updated_at),
  };
}

// Cast to avoid TS2589 (SDK registerTool type instantiation excessively deep)
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

    function toResult(structuredContent: AnalyzeTokenUnlockOutput) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    }

    function logStructured(structuredContent: AnalyzeTokenUnlockOutput, resultFound: boolean): void {
      logger.info({
        tool: "analyze_token_unlock",
        token_symbol: structuredContent.token_symbol,
        responseTimeMs: Date.now() - startMs,
        resultFound,
        impact_score: structuredContent.impact_score,
      });
    }

    try {
      if (!tokenSymbol) {
        const out = safeErrorOutput("", "token_symbol is required.");
        logStructured(out, false);
        return toResult(out);
      }

      const result = await query<{
        token_symbol: string | null;
        next_unlock_date: Date | null;
        unlock_amount: string | null;
        unlock_percent_supply: string | null;
        unlock_vs_volume_ratio: string | null;
        cohort_type: string | null;
        historical_avg_7d_return: string | null;
        impact_score: string | null;
        risk_summary: string | null;
        updated_at: Date | null;
      }>(
        `SELECT token_symbol, next_unlock_date, unlock_amount, unlock_percent_supply,
         unlock_vs_volume_ratio, cohort_type, historical_avg_7d_return,
         impact_score, risk_summary, updated_at
         FROM unlock_analysis WHERE token_symbol = $1 LIMIT 1`,
        [tokenSymbol.toUpperCase()]
      );

      if (result.rowCount === 0 || !result.rows[0]) {
        const out = safeErrorOutput(
          tokenSymbol,
          `No unlock analysis found for token: ${tokenSymbol}.`
        );
        logStructured(out, false);
        return toResult(out);
      }

      const structuredContent = rowToOutput(result.rows[0]);
      logStructured(structuredContent, true);
      return toResult(structuredContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, message }, "analyze_token_unlock error");
      const out = safeErrorOutput(
        tokenSymbol,
        `Unlock analysis failed: ${message}.`
      );
      logStructured(out, false);
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
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, "MCP POST error");
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
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

app.use((err: Error, _req: Request, res: Response, _next: () => void): void => {
  logger.error({ err }, "Unhandled error");
  if (!res.headersSent) {
    res.status(500).json({ error: "internal_error" });
  }
});

let httpServer: Server | null = null;

const precomputeCron = cron.schedule("0 */6 * * *", () => {
  runUnlockIngestionPipeline()
    .then(() => runUnlockPrecompute())
    .catch((err: Error) => {
      logger.error({ err, scope: "cron" }, "Precompute cron error");
    });
});

export function start(port: number): Server {
  httpServer = app.listen(port, (): void => {
    logger.info({ port }, "Server listening");
    initializeUnlockEngine();
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
