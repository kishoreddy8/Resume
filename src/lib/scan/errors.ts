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
    // 401 (unauthenticated) and 403 (unauthorized) are both "access denied," not "malformed
    // request" — grouping them keeps the existing 'blocked' category's meaning (see the Connector
    // Reliability Control Plane's failure-classification table, which reads this the same way
    // AUTH_OR_ACCESS would) rather than leaving 401 indistinguishable from a generic 4xx config
    // problem, which invalid_config otherwise means below.
    if (res.status === 401 || res.status === 403) return "blocked";
    if (res.status >= 500) return "provider_5xx";
    if (res.status >= 400) return "invalid_config";
  }

  // No response at all: DNS failure, connection refused, TLS error, etc.
  if (err instanceof TypeError) return "network";

  return "unknown";
}

// Connector Reliability Control Plane V1.1 — evidence-based generic message patterns for the
// synchronous-throw fallback below. Every pattern here was found by reading real production
// last_error_message values that had fallen through to "unknown" and tracing each one to its
// actual throw site across the ATS adapters (see the V1.1 investigation report). Matched on
// message CONTENT, never on provider name — these are shared conventions adapter authors reused
// across many files, not one-off provider quirks, so a generic regex correctly classifies future
// adapters that follow the same convention too.
//
//  - "has no full/exact description": the exact phrase 10 different adapters (BambooHR, Oracle
//    Recruiting Cloud, ApplicantPro, Rippling, Paycom, ClearCompany, Workable, UKG, Eightfold,
//    Comeet) throw when ONE job's detail response is missing its description content. Confirmed
//    via a live, read-only reprobe (Oracle Recruiting Cloud, job 22367) that this is a genuine,
//    persistent, reproducible per-job content gap — not a network blip — so parse_error (not
//    retried aggressively, not rediscovery-eligible, escalates to DOWN if it never clears) is the
//    correct category, not "unknown."
//  - "description encoding is invalid" (Taleo): same class of content-validation failure,
//    confirmed via the same kind of live reprobe (Unifirst Corporation) to be persistent/
//    reproducible, not transient.
//  - "pagination shifted"/"snapshot(s) disagreed/drift"/"traversal did not match"/"duplicate ...
//    across pages": JobDiva's own defensive double-fetch consistency checks (see jobdiva.ts's
//    fetchCompleteListings/fetchJobDivaJobs) failing because the provider's session-scoped,
//    stateful pagination didn't hold still across two full traversals. Confirmed transient via a
//    live reprobe (Kyyba, Inc.) succeeding immediately on retry — network (self-healing,
//    retried/rescanned normally), never invalid_config (rediscovery would find the exact same
//    board and hit the exact same transient inconsistency again).
//  - "redirected to an untrusted host": a deliberate security refusal (see
//    successfactorsTrustedHosts.ts's own doc comment) — the adapter reached the provider fine but
//    correctly declined to trust an unreviewed redirect target. This is an access-restriction
//    outcome, not a moved/broken board — blocked, matching the existing 401/403 grouping in
//    categorizeHttpError above, never invalid_config (adding the target to the reviewed allowlist
//    is a separate, explicit trust decision, not something rediscovery should attempt to bypass).
//  - "Unsupported source_type": a company's own source_type doesn't match any known adapter — by
//    definition a genuine configuration problem, not a network/content issue.
const UNSUPPORTED_SOURCE_TYPE_PATTERN = /unsupported source_type/i;
const CONTENT_VALIDATION_PATTERN = /has no (full|exact) description|description encoding is invalid/i;
const TRANSIENT_CONSISTENCY_PATTERN = /pagination (shifted|is incomplete)|snapshots? (disagreed|drift)|traversal did not match|duplicate .* across pages/i;
const UNTRUSTED_REDIRECT_PATTERN = /redirected to an? untrusted( external)? host/i;

/**
 * Fallback for synchronous validation throws that never reach fetch at all — e.g.
 * "Missing Greenhouse board token" (src/lib/normalize.ts) or "Invalid Workday token ..."
 * (src/lib/ats/workday.ts's decodeWorkdayToken). Used at the top of scan.ts's scanCompany catch
 * block for whatever categorizeHttpError/fetchWithRetry didn't already tag as a ScanConnectorError.
 */
export function categorizeThrownError(err: unknown): ErrorCategory {
  if (err instanceof ScanConnectorError) return err.category;
  if (!(err instanceof Error)) return "unknown";
  if (/^(missing|invalid)\b/i.test(err.message)) return "invalid_config";
  if (UNSUPPORTED_SOURCE_TYPE_PATTERN.test(err.message)) return "invalid_config";
  if (UNTRUSTED_REDIRECT_PATTERN.test(err.message)) return "blocked";
  if (TRANSIENT_CONSISTENCY_PATTERN.test(err.message)) return "network";
  if (CONTENT_VALIDATION_PATTERN.test(err.message)) return "parse_error";
  return "unknown";
}
