/**
 * HTTP-status-aware API error helpers, shared by the runtimes and the app.
 */

/** An API call failed with a non-2xx HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** True when `err` is an API failure with this HTTP status. */
export function isApiStatus(err: unknown, status: number): boolean {
  return err instanceof Error && (err as { status?: unknown }).status === status;
}
