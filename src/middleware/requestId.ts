import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export interface RequestWithId extends Request {
  request_id?: string;
}

export function requestIdMiddleware(req: RequestWithId, _res: Response, next: NextFunction): void {
  req.request_id = req.headers["x-request-id"] as string | undefined ?? randomUUID();
  next();
}
