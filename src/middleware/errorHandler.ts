import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import logger from "../core/logger.js";
import type { RequestWithId } from "./requestId.js";

export function errorHandler(
  err: unknown,
  req: Request & { request_id?: string; body?: unknown },
  res: Response,
  _next: NextFunction
): void {
  const requestId = (req as RequestWithId).request_id ?? randomUUID();
  const route = req.path ?? req.url;
  const body = req.body;
  const chainId = body && typeof body === "object" && "params" in body
    ? (body as { params?: { arguments?: { chain_id?: string } } }).params?.arguments?.chain_id
    : undefined;

  logger.error({
    request_id: requestId,
    route,
    token_symbol: body && typeof body === "object" && "params" in body
      ? (body as { params?: { arguments?: { token_symbol?: string } } }).params?.arguments?.token_symbol
      : body && typeof body === "object" && "token_symbol" in body
        ? (body as { token_symbol?: string }).token_symbol
        : body && typeof body === "object" && "tokenSymbol" in body
          ? (body as { tokenSymbol?: string }).tokenSymbol
          : undefined,
    chain_id: chainId,
    err: err instanceof Error ? err : new Error(String(err)),
    stack: err instanceof Error ? err.stack : undefined,
    body: typeof body === "object" && body !== null ? body : undefined,
  }, "Unhandled error");

  if (res.headersSent) return;

  const message =
    process.env.NODE_ENV === "development" && err instanceof Error
      ? err.message
      : "Unexpected server error";

  res.status(500).json({
    error: "Internal Server Error",
    message,
    request_id: requestId,
  });
}
