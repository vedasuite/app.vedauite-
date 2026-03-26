import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

export function attachRequestContext(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const requestId = req.headers["x-request-id"]?.toString() || crypto.randomUUID();

  (
    req as Request & {
      requestId?: string;
    }
  ).requestId = requestId;

  res.setHeader("X-Request-Id", requestId);
  next();
}
