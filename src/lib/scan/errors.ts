import type { ErrorCategory } from "@/types";

/**
 * Thrown by src/lib/scan/retry.ts's fetchWithRetry once retries are exhausted (or immediately for
 * a non-retryable category) — carries enough for scan.ts to persist a scan_run row and update
 * company health without re-deriving the category from a plain Error's message string.
 */
export class ScanConnectorError extends Error {
  readonly category: ErrorCategory;
  readonly retryCount: number;
  readonly statusCode?: number;

  constructor(message: string, category: ErrorCategory, retryCount: number, statusCode?: number) {
    super(message);
    this.name = "ScanConnectorError";
    this.category = category;
    this.retryCount = retryCount;
    this.statusCode = statusCode;
  }
}

/** Categories worth retrying — transient by nature. Everything else (bad config, unparseable
 *  response, a block page) won't be fixed by trying again. */
export const RETRYABLE_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  "timeout",
  "rate_limited",
  "network",
  "provider_5xx",
]);

export function isRetryableCategory(category: ErrorCategory): boolean {
  return RETRYABLE_CATEGORIES.has(category);
}

/**
 * Classifies a failed fetch attempt. `res` is the HTTP response when one was received (a non-ok
 * status); absent when the fetch itself rejected (network failure, our own timeout abort, or a
 * body-parsing failure after a 2xx response — see fetchWithRetry, which calls this with `err` set
 * and `res` undefined for all three of those cases, distinguishing them by `err.name`/`isParseError`).
 */
export function categorizeHttpError(
  res: Response | undefined,
  err: unknown,
  opts: { isParseError?: boolean } = {}
): ErrorCategory {
  if (opts.isParseError) return "parse_error";
  if (err instanceof Error && err.name === "AbortError") return "timeout";

  if (res) {
    if (res.status === 429) return "rate_limited";
    if (res.status === 403) return "blocked";
    if (res.status >= 500) return "provider_5xx";
    if (res.status >= 400) return "invalid_config";
  }

  // No response at all: DNS failure, connection refused, TLS error, etc.
  if (err instanceof TypeError) return "network";

  return "unknown";
}

/**
 * Fallback for synchronous validation throws that never reach fetch at all — e.g.
 * "Missing Greenhouse board token" (src/lib/normalize.ts) or "Invalid Workday token ..."
 * (src/lib/ats/workday.ts's decodeWorkdayToken). Used at the top of scan.ts's scanCompany catch
 * block for whatever categorizeHttpError/fetchWithRetry didn't already tag as a ScanConnectorError.
 */
export function categorizeThrownError(err: unknown): ErrorCategory {
  if (err instanceof ScanConnectorError) return err.category;
  if (err instanceof Error && /^(missing|invalid)\b/i.test(err.message)) return "invalid_config";
  return "unknown";
}
