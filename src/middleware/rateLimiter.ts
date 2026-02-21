/**
 * Global API rate limiter: 60 requests per minute per IP.
 * Protects CoinGecko, CoinPaprika, and API endpoints.
 */

import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 60;

export const globalRateLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req: Request, res: Response): void => {
    res.status(429).json({ error: "Too many requests" });
  },
});
