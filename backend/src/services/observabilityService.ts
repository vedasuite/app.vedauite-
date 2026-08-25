type LogLevel = "info" | "warn" | "error";

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, sanitize(nested)])
    );
  }

  return value;
}

export function logEvent(
  level: LogLevel,
  event: string,
  details?: Record<string, unknown>
) {
  const payload = {
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(details ? { details: sanitize(details) } : {}),
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
    return;
  }

  if (level === "warn") {
    // eslint-disable-next-line no-console
    console.warn(line);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(line);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    attempts: number;
    operationName: string;
    delayMs?: number;
    context?: Record<string, unknown>;
    /**
     * Decides whether a given failure is worth retrying. Optional, so every
     * existing caller keeps its current behaviour of retrying everything.
     *
     * WHY THIS EXISTS. The competitor fetch classified its failures — DNS,
     * TLS, blocked, timeout — but only in the OUTER catch, after this loop had
     * already exhausted its attempts. Production logged attempt 1 and attempt 2
     * for `addidas.com`, then `retriable: false`: the verdict was correct and
     * arrived too late to act on. A certificate that has expired will still be
     * expired 400ms later, so the second attempt was guaranteed waste.
     */
    shouldRetry?: (error: unknown) => boolean;
  }
) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        logEvent("warn", "retry.attempt", {
          operation: options.operationName,
          attempt,
          ...(options.context ?? {}),
        });
      }

      return await operation();
    } catch (error) {
      lastError = error;

      // Asked BEFORE the failure is logged as retryable and before any wait,
      // so a permanent condition costs exactly one attempt.
      const retryable = options.shouldRetry ? options.shouldRetry(error) : true;

      logEvent(
        attempt === options.attempts || !retryable ? "error" : "warn",
        "retry.failure",
        {
          operation: options.operationName,
          attempt,
          maxAttempts: options.attempts,
          retryable,
          error,
          ...(options.context ?? {}),
        }
      );

      if (!retryable) {
        break;
      }

      if (attempt < options.attempts && options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  throw lastError;
}
