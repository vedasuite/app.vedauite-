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

      logEvent(
        attempt === options.attempts ? "error" : "warn",
        "retry.failure",
        {
          operation: options.operationName,
          attempt,
          maxAttempts: options.attempts,
          error,
          ...(options.context ?? {}),
        }
      );

      if (attempt < options.attempts && options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }

  throw lastError;
}
