/**
 * Production MCP JSON-RPC handler for POST /mcp.
 * Context Protocol compliant: listTools, callTool (tools/list, tools/call).
 * Never returns -32603 for tool execution; uses -32000 for failures.
 */

import type { Request, Response } from "express";
import type { RequestHandler } from "express";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { runAnalyzeTokenSupplyRisk } from "../tools/analyze_token_supply_risk.js";
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

// ---------------------------------------------------------------------------
// Tool definition – analyze_token_supply_risk (multi-chain supply risk engine)
// ---------------------------------------------------------------------------

const MCP_TOOL_NAME = "analyze_token_supply_risk";

const MCP_TOOLS = [
  {
    name: MCP_TOOL_NAME,
    description:
      "Multi-chain token supply risk engine: historical unlocks, vesting cliffs, emission patterns, liquidity stress, and combined risk score for Ethereum, Arbitrum, BSC.",
    inputSchema: {
      type: "object" as const,
      properties: {
        token_symbol: { type: "string" as const, description: "Token ticker symbol (e.g. ETH, ARB)" },
        chain: {
          type: "string" as const,
          enum: ["ethereum", "arbitrum", "bsc"] as const,
          description: "Chain to analyze; auto-detect if omitted",
        },
        timeframe_days: {
          type: "number" as const,
          description: "Analysis window in days; default 30",
        },
      },
      required: ["token_symbol"] as const,
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        success: { type: "boolean" as const },
        data: {
          type: "object" as const,
          properties: {
            token: { type: "string" as const },
            chain: { type: "string" as const },
            supply_metrics: { type: "object" as const },
            historical_unlock_analysis: { type: "object" as const },
            vesting_cliff_analysis: { type: "object" as const },
            emission_analysis: { type: "object" as const },
            liquidity_analysis: { type: "object" as const },
            risk_assessment: { type: "object" as const },
          },
        },
        error: { type: "string" as const },
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

const TOOL_TIMEOUT_MS = 35_000;

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

  const tokenSymbol =
    (args as { token_symbol?: unknown }).token_symbol ??
    (args as { tokenSymbol?: unknown }).tokenSymbol ??
    (args as { token?: unknown }).token;
  const token = (typeof tokenSymbol === "string" ? tokenSymbol : tokenSymbol != null ? String(tokenSymbol) : "").trim();
  if (!token) {
    logger.warn({ args }, "MCP missing required argument: token_symbol");
    return jsonRpcError(id, -32602, "Missing required argument: token_symbol. Provide a token ticker (e.g. ARB, ETH).");
  }

  const chainArg = (args as { chain?: unknown }).chain;
  const chainSlug =
    chainArg === "ethereum" || chainArg === "arbitrum" || chainArg === "bsc" ? chainArg : undefined;
  const timeframeDays = typeof (args as { timeframe_days?: unknown }).timeframe_days === "number"
    ? (args as { timeframe_days: number }).timeframe_days
    : undefined;

  try {
    const result = await Promise.race([
      runAnalyzeTokenSupplyRisk(
        { token_symbol: token, chain: chainSlug, timeframe_days: timeframeDays },
        deps
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Analysis timed out")), TOOL_TIMEOUT_MS)
      ),
    ]);

    if (!result.success) {
      return jsonRpcError(id, -32000, result.error);
    }

    logger.info(
      { tool: MCP_TOOL_NAME, token: result.data.token, chain: result.data.chain, risk: result.data.risk_assessment.overall_risk_score },
      "MCP callTool success"
    );
    return jsonRpcSuccess(id, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[MCP] callTool execution error:", err);
    logger.error({ err, message, token }, "MCP callTool execution error");
    return jsonRpcError(
      id,
      -32000,
      message.includes("timed out") ? "Analysis timed out. Try again or use a different token." : `Supply risk analysis failed: ${message}.`
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
