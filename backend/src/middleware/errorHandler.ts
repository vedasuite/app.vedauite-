import type { NextFunction, Request, Response } from "express";
import { logEvent } from "../services/observabilityService";
import { HttpError } from "../lib/httpError";

function isAggregateLikeError(
  err: unknown
): err is { errors: unknown[]; message?: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "errors" in err &&
    Array.isArray((err as { errors?: unknown[] }).errors)
  );
}

// Centralized error handler so API responses are consistent.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const status = err instanceof HttpError ? err.status : 500;
  const message =
    err instanceof HttpError
      ? err.message
      : isAggregateLikeError(err)
      ? err.errors
          .map((inner) =>
            inner instanceof Error && inner.message
              ? inner.message
              : String(inner)
          )
          .filter(Boolean)
          .join(" | ") || "Database connection failed."
      : err instanceof Error && err.message
      ? err.message
      : "Unexpected server error occurred.";

  const requestId = (
    req as Request & {
      requestId?: string;
    }
  ).requestId;

  logEvent(status >= 500 ? "error" : "warn", "request.failed", {
    requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    error: err,
  });

  res.status(status).json({
    error: {
      message,
      requestId,
    },
  });
}

