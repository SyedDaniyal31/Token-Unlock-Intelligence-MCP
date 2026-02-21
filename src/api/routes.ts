import type { Request, Response } from "express";
import { getIntelligenceReport, extractTokenFromQuery, reportToLegacyShape } from "./mcpController.js";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import { getScheduleByToken } from "../ingestion/unlockRegistry.js";
import logger from "../core/logger.js";
import { query } from "../infrastructure/database/postgres.js";
import { getConfiguredChains, getRpcConfigured } from "../infrastructure/rpc/chainProviderFactory.js";
import { loadUnlockRegistryFromDisk } from "../infrastructure/registry/unlockRegistryLoader.js";
import type { RequestWithId } from "../middleware/requestId.js";

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
      const queryParam = (req.body?.query as string) ?? "";
      const tokenFromBody =
        (req.body?.token_symbol as string) ?? (req.body?.tokenSymbol as string) ?? "";
      const tokenSymbol = (tokenFromBody.trim() || extractTokenFromQuery(queryParam) || "").toUpperCase();
      if (!tokenSymbol) {
        res.status(400).json({ error: "token_symbol or query required" });
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

export { getIntelligenceReport, extractTokenFromQuery, reportToLegacyShape };
