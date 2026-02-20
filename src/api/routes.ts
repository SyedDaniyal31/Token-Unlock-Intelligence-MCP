import type { Request, Response } from "express";
import { getIntelligenceReport, extractTokenFromQuery, reportToLegacyShape } from "./mcpController.js";
import type { UnlockIntelligenceDeps } from "../intelligence/unlockIntelligence.js";
import logger from "../core/logger.js";

export function registerHealthRoute(
  app: { get: (path: string, handler: (req: Request, res: Response) => void) => void }
): void {
  app.get("/health", (_req: Request, res: Response): void => {
    res.json({
      status: "ok",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });
}

export function registerIntelligenceRoute(
  app: { post: (path: string, handler: (req: Request, res: Response) => void) => void },
  deps: UnlockIntelligenceDeps
): void {
  app.post("/intelligence", async (req: Request, res: Response): Promise<void> => {
    try {
      const query = (req.body?.query as string) ?? "";
      const tokenFromBody = (req.body?.token_symbol as string) ?? "";
      const tokenSymbol = tokenFromBody.trim() || extractTokenFromQuery(query) || "";
      if (!tokenSymbol) {
        res.status(400).json({ error: "token_symbol or query required" });
        return;
      }
      const report = await getIntelligenceReport(tokenSymbol, deps);
      res.json(report);
    } catch (err) {
      logger.error({ err }, "intelligence route error");
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error" });
      }
    }
  });
}

export { getIntelligenceReport, extractTokenFromQuery, reportToLegacyShape };
