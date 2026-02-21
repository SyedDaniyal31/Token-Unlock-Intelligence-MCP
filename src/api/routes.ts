import type { Request, Response } from "express";
import { z } from "zod";
import { getIntelligenceReport, extractTokenFromQuery, reportToLegacyShape } from "./mcpController.js";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getScheduleByToken } from "../ingestion/unlockRegistry.js";
import logger from "../core/logger.js";
import { query } from "../infrastructure/database/postgres.js";
import { getConfiguredChains, getRpcConfigured } from "../infrastructure/rpc/chainProviderFactory.js";
import { loadUnlockRegistryFromDisk } from "../infrastructure/registry/unlockRegistryLoader.js";
import type { RequestWithId } from "../middleware/requestId.js";
import {
  MarketAggregatorService,
  InvalidTokenIdError,
  MarketUnavailableError,
} from "../services/MarketAggregator.js";

/** POST /intelligence body: token_symbol or query required; optional chain_id and market ids. */
const intelligenceBodySchema = z.object({
  query: z.string().max(200).optional(),
  token_symbol: z.string().max(20).regex(/^[A-Z0-9]*$/i).optional(),
  tokenSymbol: z.string().max(20).regex(/^[A-Z0-9]*$/i).optional(),
  chain_id: z.number().int().positive().optional(),
  coingecko_id: z.string().max(64).regex(/^[a-z0-9-]*$/).optional(),
  paprika_id: z.string().max(64).regex(/^[a-z0-9-]*$/).optional(),
});

export function registerHealthRoute(
  app: { get: (path: string, handler: (req: Request, res: Response) => void | Promise<void>) => void }
): void {
  app.get("/health", async (_req: Request, res: Response): Promise<void> => {
    let db: "connected" | "error" = "error";
    try {
      await query("SELECT 1");
      db = "connected";
    } catch {
      db = "error";
    }
    let registry_loaded = 0;
    try {
      registry_loaded = loadUnlockRegistryFromDisk().length;
    } catch {
      // ignore
    }
    res.json({
      status: db === "connected" ? "ok" : "degraded",
      db,
      registry_loaded,
      chains_configured: getConfiguredChains(),
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });
}

export function registerDiagnosticsRoute(
  app: { get: (path: string, handler: (req: Request, res: Response) => void | Promise<void>) => void }
): void {
  app.get("/diagnostics", async (_req: Request, res: Response): Promise<void> => {
    let registry_tokens = 0;
    let db_tokens = 0;
    try {
      registry_tokens = loadUnlockRegistryFromDisk().length;
    } catch {
      // ignore
    }
    try {
      const r = await query<{ count: string }>("SELECT COUNT(*) AS count FROM unlock_schedules");
      db_tokens = parseInt(r.rows[0]?.count ?? "0", 10) || 0;
    } catch {
      // ignore
    }
    res.json({
      registry_tokens,
      db_tokens,
      chains_configured: getConfiguredChains(),
      rpc_configured: getRpcConfigured(),
    });
  });
}

export function registerIntelligenceRoute(
  app: { post: (path: string, handler: (req: Request, res: Response) => void) => void },
  deps: UnlockIntelligenceDeps
): void {
  app.post("/intelligence", async (req: Request & RequestWithId, res: Response): Promise<void> => {
    const requestId = req.request_id ?? "";
    try {
      const parseResult = intelligenceBodySchema.safeParse(req.body ?? {});
      if (!parseResult.success) {
        const issues = parseResult.error.flatten().fieldErrors;
        res.status(400).json({
          error: "validation_error",
          message: "Request body validation failed",
          details: issues,
        });
        return;
      }
      const body = parseResult.data;
      const tokenFromBody = (body.token_symbol ?? body.tokenSymbol ?? "").trim().toUpperCase();
      const queryParam = body.query ?? "";
      const tokenSymbol = tokenFromBody || extractTokenFromQuery(queryParam) || "";
      if (!tokenSymbol) {
        res.status(400).json({
          error: "token_symbol or query required",
          message: "Provide token_symbol, tokenSymbol, or query to derive a token symbol",
        });
        return;
      }
      const schedule = await getScheduleByToken(tokenSymbol);
      if (!schedule) {
        logger.info({ request_id: requestId, token_symbol: tokenSymbol }, "Token not found");
        res.status(404).json({ error: "token_not_found" });
        return;
      }
      const report = await getIntelligenceReport(tokenSymbol, deps);
      res.json(report);
    } catch (err) {
      logger.error({ err, request_id: requestId, route: "/intelligence" }, "intelligence route error");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: "An unexpected error occurred", request_id: requestId });
      }
    }
  });
}

const TOKEN_ID_MAX_LEN = 64;
const TOKEN_ID_REGEX = /^[a-z0-9-]+$/;

/** Normalize query param to a single string; validate length and token-id pattern. Returns null if invalid. */
function parseMarketIdParam(val: unknown): string | null {
  const raw = Array.isArray(val) ? val[0] : val;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > TOKEN_ID_MAX_LEN) return null;
  if (!TOKEN_ID_REGEX.test(trimmed)) return null;
  return trimmed;
}

/**
 * GET /market?coingecko_id=ethereum&paprika_id=eth-ethereum
 * Returns unified market result; 400 invalid token ID or param, 503 when both providers fail.
 */
export function registerMarketRoute(
  app: { get: (path: string, handler: (req: Request, res: Response) => void | Promise<void>) => void }
): void {
  const marketService = new MarketAggregatorService();
  app.get("/market", async (req: Request, res: Response): Promise<void> => {
    const coingeckoId = parseMarketIdParam(req.query?.coingecko_id);
    const paprikaId = parseMarketIdParam(req.query?.paprika_id);
    if (coingeckoId === null && paprikaId === null) {
      const hasAny = req.query?.coingecko_id != null || req.query?.paprika_id != null;
      res.status(400).json({
        error: hasAny ? "invalid_param" : "coingecko_id or paprika_id required",
        message: hasAny
          ? "coingecko_id and paprika_id must be single strings, max 64 chars, only a-z 0-9 and hyphen"
          : "Provide at least one of coingecko_id or paprika_id",
      });
      return;
    }
    const cgId = coingeckoId ?? undefined;
    const papId = paprikaId ?? undefined;
    try {
      const result = await marketService.getMarketData(cgId, papId);
      res.json(result);
    } catch (err) {
      if (err instanceof InvalidTokenIdError) {
        res.status(400).json({ error: "invalid_token_id", message: err.message });
        return;
      }
      if (err instanceof MarketUnavailableError) {
        res.status(503).json({ error: "market_unavailable", message: err.message });
        return;
      }
      logger.error({ err, route: "/market" }, "Market route error");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: "An unexpected error occurred" });
      }
    }
  });
}

export { getIntelligenceReport, extractTokenFromQuery, reportToLegacyShape };
