import type { ErrorCategory } from "@/types";
import { ScanConnectorError, categorizeHttpError, isRetryableCategory } from "./errors";

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Called once per attempt that failed but will be retried — not called on success, and not
   *  called on the final failure that gets thrown. Lets scan.ts accumulate a per-scan retry_count. */
  onRetry?: (attempt: number, category: ErrorCategory) => void;
}

const DEFAULT_MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
const DEFAULT_BASE_DELAY_MS = 300;
const DEFAULT_MAX_DELAY_MS = 4000;
const DEFAULT_TIMEOUT_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, retryAfterMs?: number): number {
  const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const jitter = Math.random() * Math.min(100, backoff);
  const computed = backoff + jitter;
  return retryAfterMs !== undefined ? Math.min(maxDelayMs, Math.max(computed, retryAfterMs)) : computed;
}

function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * fetch() wrapped with a per-attempt timeout (AbortController), bounded retry/backoff for
 * transient failures (see RETRYABLE_CATEGORIES in ./errors), and error categorization. Always
 * throws ScanConnectorError on final failure — never a bare fetch/DOM error — so callers (scan.ts)
 * can persist a category without re-deriving one from a message string.
 *
 * Only retries categories in RETRYABLE_CATEGORIES; a non-retryable category (bad config, blocked,
 * malformed response) throws immediately on the first attempt. 429 responses honor a numeric
 * Retry-After header when present, taking the max of that and the computed backoff.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return res;

      const category = categorizeHttpError(res, undefined);
      const message = `Request to ${url} failed with status ${res.status}`;
      if (!isRetryableCategory(category) || attempt === maxAttempts) {
        throw new ScanConnectorError(message, category, attempt - 1, res.status);
      }
      options.onRetry?.(attempt, category);
      await sleep(
        computeDelayMs(attempt, baseDelayMs, maxDelayMs, category === "rate_limited" ? parseRetryAfterMs(res) : undefined)
      );
    } catch (err) {
      if (err instanceof ScanConnectorError) throw err;

      const category = categorizeHttpError(res, err);
      const message = err instanceof Error ? err.message : String(err);
      if (!isRetryableCategory(category) || attempt === maxAttempts) {
        throw new ScanConnectorError(message, category, attempt - 1, res?.status);
      }
      options.onRetry?.(attempt, category);
      await sleep(computeDelayMs(attempt, baseDelayMs, maxDelayMs));
    } finally {
      clearTimeout(timer);
    }
  }

  // Unreachable — every loop iteration either returns or throws — but keeps TS's control-flow
  // analysis happy without a non-null assertion on the caller's side.
  throw new ScanConnectorError(`Request to ${url} failed`, "unknown", maxAttempts - 1);
}

/** res.json() wrapped so a malformed 2xx body (rare, but seen from flaky ATS backends) surfaces as
 *  a categorized ScanConnectorError('parse_error') instead of an uncaught SyntaxError — parse
 *  failures aren't retried (see RETRYABLE_CATEGORIES), so this is a straight classify-and-rethrow. */
export async function parseJsonOrThrow<T>(res: Response, url: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    const message = `Response from ${url} was not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
    throw new ScanConnectorError(message, "parse_error", 0, res.status);
  }
}
