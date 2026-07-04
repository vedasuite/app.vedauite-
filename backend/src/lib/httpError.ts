// Thrown by service-layer code to indicate an expected, actionable failure
// (e.g. "plan doesn't include this module") rather than an actual crash.
// The error handler responds with `status` and the real message intact,
// instead of masking it behind a generic "server problem" 500.
export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}
