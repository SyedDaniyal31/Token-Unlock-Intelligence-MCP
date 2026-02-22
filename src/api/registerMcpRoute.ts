/**
 * Production MCP JSON-RPC handler for POST /mcp.
 * Context Protocol compliant: listTools, callTool (tools/list, tools/call).
 * Never returns -32603 for tool execution; uses -32000 for failures.
 */

import type { Request, Response } from "express";
import type { RequestHandler } from "express";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getIntelligenceReport } from "./mcpController.js";
import { getScheduleByToken } from "../ingestion/unlockRegistry.js";
import logger from "../core/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcErrorBody {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string };
}

export type McpToolOutput = {
  unlock_pressure_ratio: number;
  volume_impact_ratio: number;
  supply_inflation_percent: number;
  risk_score: number;
};

// ---------------------------------------------------------------------------
// Tool definition – name and inputSchema match Context (token_symbol)
// ---------------------------------------------------------------------------

const MCP_TOOL_NAME = "analyze_token_unlock";

const MCP_TOOLS = [
  {
    name: MCP_TOOL_NAME,
    description:
      "Analyze upcoming token unlock and quantify sell-pressure risk using liquidity-adjusted impact scoring.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: {
          type: "string" as const,
          description: "Token ticker symbol (e.g. ETH, ARB)",
        },
      },
      required: ["token_symbol"] as const,
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        unlock_pressure_ratio: { type: "number" as const },
        volume_impact_ratio: { type: "number" as const },
        supply_inflation_percent: { type: "number" as const },
        risk_score: { type: "number" as const },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(raw: unknown): JsonRpcRequest | null {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as JsonRpcRequest;
  return null;
}

function safeSend(res: Response, payload: JsonRpcSuccess | JsonRpcErrorBody): void {
  if (res.headersSent) {
    console.warn("[MCP] Response already sent; skipping send");
    return;
  }
  res.status(200).set("Content-Type", "application/json").json(payload);
}

function jsonRpcSuccess(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: string | number | null, code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Normalize params.arguments: may be object or JSON string. */
function parseArguments(args: unknown): Record<string, unknown> {
  if (args == null) return {};
  if (typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Map IntelligenceReport to MCP tool output schema. */
function reportToMcpOutput(report: {
  unlock_vs_volume_ratio: number;
  unlock_percent_supply: number;
  score_numeric: number;
}): McpToolOutput {
  const ratio = Number(report.unlock_vs_volume_ratio) || 0;
  const supplyPct = Number(report.unlock_percent_supply) || 0;
  const risk = Number(report.score_numeric) ?? 0;
  return {
    unlock_pressure_ratio: ratio,
    volume_impact_ratio: ratio,
    supply_inflation_percent: supplyPct,
    risk_score: risk,
  };
}

const TOOL_TIMEOUT_MS = 25_000;

// ---------------------------------------------------------------------------
// Method handlers
// ---------------------------------------------------------------------------

function handleListTools(id: string | number | null): JsonRpcSuccess {
  return jsonRpcSuccess(id, { tools: MCP_TOOLS });
}

async function handleCallTool(
  id: string | number | null,
  params: unknown,
  deps: UnlockIntelligenceDeps | null | undefined
): Promise<JsonRpcSuccess | JsonRpcErrorBody> {
  if (!deps || typeof deps.chainProvider === "undefined" || typeof deps.marketProvider === "undefined") {
    console.error("[MCP] handleCallTool: deps or required deps fields are undefined");
    return jsonRpcError(id, -32000, "Server configuration error. Please try again later.");
  }

  const p =
    params != null && typeof params === "object" && !Array.isArray(params)
      ? (params as { name?: unknown; arguments?: unknown })
      : {};
  const name = typeof p.name === "string" ? p.name : "";
  const rawArgs = p.arguments;
  const args = parseArguments(rawArgs);

  if (name !== MCP_TOOL_NAME) {
    logger.warn({ name, allowed: MCP_TOOL_NAME }, "MCP unknown tool");
    return jsonRpcError(id, -32602, `Unknown tool: ${name || "(missing)"}. Supported: ${MCP_TOOL_NAME}.`);
  }

  const tokenRaw =
    (args as { token_symbol?: unknown }).token_symbol ??
    (args as { tokenSymbol?: unknown }).tokenSymbol ??
    (args as { token?: unknown }).token;
  const token = (typeof tokenRaw === "string" ? tokenRaw : tokenRaw != null ? String(tokenRaw) : "").trim();

  if (!token) {
    logger.warn({ args }, "MCP missing required argument: token_symbol");
    return jsonRpcError(id, -32602, "Missing required argument: token_symbol. Provide a token ticker (e.g. ARB, ETH).");
  }

  const symbol = token.toUpperCase();

  try {
    const schedule = await getScheduleByToken(symbol);
    if (!schedule) {
      console.log("[MCP] Token not supported:", symbol);
      logger.info({ token_symbol: symbol }, "MCP token not in registry");
      return jsonRpcSuccess(id, {
        success: false,
        error: "Token not supported",
      });
    }
  } catch (err) {
    console.error("[MCP] getScheduleByToken error:", err);
    logger.error({ err, token_symbol: symbol }, "MCP registry check failed");
    return jsonRpcError(id, -32000, "Token lookup failed. Please try again.");
  }

  try {
    const report = await Promise.race([
      getIntelligenceReport(symbol, deps),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
      ),
    ]);
    const output = reportToMcpOutput({
      unlock_vs_volume_ratio: report.unlock_vs_volume_ratio,
      unlock_percent_supply: report.unlock_percent_supply,
      score_numeric: report.score_numeric,
    });
    logger.info(
      { tool: MCP_TOOL_NAME, token_symbol: report.token_symbol, risk_score: output.risk_score },
      "MCP callTool success"
    );
    return jsonRpcSuccess(id, {
      success: true,
      data: output,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP] callTool execution error:", err);
    logger.error({ err, message, token: symbol }, "MCP callTool execution error");
    return jsonRpcError(
      id,
      -32000,
      message.includes("timed out") ? "Analysis timed out. Try again or use a different token." : `Unlock analysis failed: ${message}.`
    );
  }
}

function handleInitialize(id: string | number | null): JsonRpcSuccess {
  return jsonRpcSuccess(id, {
    protocolVersion: "2024-11-05",
    serverInfo: { name: "token-unlock-intelligence-mcp", version: "1.0.0" },
    capabilities: { tools: {} },
  });
}

// ---------------------------------------------------------------------------
// POST /mcp handler
// ---------------------------------------------------------------------------

export function registerMcpRoute(
  app: { post: (path: string, ...handlers: RequestHandler[]) => void },
  deps: UnlockIntelligenceDeps,
  middleware: RequestHandler[] = []
): void {
  const handler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const body = parseBody(req.body);

      console.log("[MCP] Incoming request body:", body != null ? JSON.stringify(body, null, 2) : "(null/undefined)");
      logger.info({ body }, "MCP POST body");

      if (!body) {
        safeSend(res, jsonRpcError(null, -32600, "Invalid Request: body must be a JSON object."));
        return;
      }

      const { jsonrpc, id, method, params } = body;
      const requestId = id ?? null;

      console.log("[MCP] Parsed method:", method);
      console.log("[MCP] Parsed params:", params != null ? JSON.stringify(params) : "(null/undefined)");

      if (jsonrpc !== "2.0") {
        safeSend(res, jsonRpcError(requestId, -32600, "Invalid Request: jsonrpc must be '2.0'."));
        return;
      }

      const methodName = typeof method === "string" ? method : "";

      if (methodName === "listTools" || methodName === "tools/list") {
        safeSend(res, handleListTools(requestId));
        return;
      }

      if (methodName === "callTool" || methodName === "tools/call") {
        const result = await handleCallTool(requestId, params, deps);
        safeSend(res, result);
        return;
      }

      if (methodName === "initialize") {
        safeSend(res, handleInitialize(requestId));
        return;
      }

      if (methodName === "") {
        safeSend(res, jsonRpcError(requestId, -32600, "Invalid Request: method is required."));
        return;
      }

      logger.warn({ method: methodName }, "MCP method not found");
      safeSend(res, jsonRpcError(requestId, -32601, `Method not found: ${methodName}.`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[MCP] Unhandled error:", err);
      logger.error({ err, message }, "MCP POST unhandled error");
      safeSend(
        res,
        jsonRpcError(null, -32603, `Unexpected server error: ${message}.`)
      );
    }
  };
  app.post("/mcp", ...middleware, handler);
}
