import type { ErrorCategory } from "@/types";
import { isRetryableCategory } from "@/lib/scan/errors";

/**
 * Connector Reliability Control Plane V1 — Phase 3's "central failure classification layer."
 *
 * Deliberately NOT a new error taxonomy. src/lib/scan/errors.ts's ErrorCategory already covers the
 * mission's requested list almost 1:1 (see the mapping table below); inventing a second, competing
 * enum here would be exactly the "competing classification" the mission explicitly prohibits. This
 * module instead attaches reliability METADATA (retryable / cooldown / rediscovery-eligible / human
 * review / health impact / max attempts) to each of the 9 EXISTING ErrorCategory values, so the rest
 * of the reliability control plane reasons about the one category vocabulary every scan/adapter
 * already writes to companies.last_error_category — never a second field to keep in sync.
 *
 * Requested-vocabulary mapping (categories the mission asks to distinguish that don't already have
 * their own ErrorCategory value):
 *   RATE_LIMITED        -> "rate_limited"                          (exact existing match)
 *   TIMEOUT              -> "timeout"                                (exact existing match)
 *   NETWORK               -> "network"                                (exact existing match)
 *   DNS                    -> "network"  — a DNS failure surfaces to fetch() as a plain TypeError,
 *                             indistinguishable from a refused connection or TLS failure without a
 *                             deeper OS-level probe this codebase has never needed; categorizeHttpError
 *                             (scan/errors.ts) already buckets all of these as "network" on purpose.
 *   HTTP_5XX              -> "provider_5xx"                          (exact existing match)
 *   AUTH_OR_ACCESS          -> "blocked" — 401/403 both mean "access denied," not "malformed
 *                             request"; see scan/errors.ts's categorizeHttpError, which now maps
 *                             both status codes here (Stage-adjacent one-line fix made alongside this
 *                             module, since 401 previously fell into invalid_config where it read as
 *                             a config problem rather than an access problem).
 *   NOT_FOUND               -> "invalid_config", with statusCode 404 checked directly where it
 *                             matters (isLikelyStaleSource below) — pendingConnectorValidation.ts's
 *                             existing shouldRejectError already treats a 404 ScanConnectorError as
 *                             special this same way; reused, not reinvented.
 *   INVALID_CONFIG          -> "invalid_config"                       (exact existing match)
 *   STALE_SOURCE            -> not its own ErrorCategory; a DERIVED judgment (isLikelyStaleSource
 *                             below) over invalid_config/blocked/404, matching the mission's own
 *                             example ("Workday old token -> 422/invalid config -> ... -> Discovery
 *                             V2") — the category is the evidence, staleness is the interpretation.
 *   PARSER_FAILURE          -> "parse_error"                          (exact existing match)
 *   SECURITY_REJECTED        -> "unsafe_url"                          (exact existing match — this is
 *                             the SSRF-rejection category safeFetch.ts/discovery.ts already produce)
 *   EMPTY_BOARD              -> not an error at all — see src/lib/ats/reliability/state.ts's
 *                             deriveReliabilityState, which derives HEALTHY_EMPTY straight from a
 *                             successful scan with zero jobs, never from ErrorCategory.
 *   PARTIAL_DATA             -> not an error category either — this is exactly what
 *                             src/db/queries/atsCoverage.ts's deriveWarnings already reports
 *                             (LOCATION_UNKNOWN/DESCRIPTION_PARTIAL) for genuine isolated per-job
 *                             gaps; reused as-is, see state.ts.
 *   UNKNOWN                 -> "unknown"                              (exact existing match)
 */
export interface FailureProfile {
  category: ErrorCategory;
  /** Whether src/lib/scan/retry.ts's fetchWithRetry already retries this WITHIN one scan attempt —
   *  reused directly from RETRYABLE_CATEGORIES, never a second definition of "retryable." */
  retryableWithinScan: boolean;
  /** Whether a scan-to-scan (not within-scan) transient recovery expectation applies — i.e. the
   *  connector is expected to self-heal on its own next scheduled scan without any human or
   *  Discovery V2 action, given enough scans within the cooldown window. */
  crossScanTransient: boolean;
  /** Max consecutive scan-level failures tolerated before this category's persistence stops being
   *  read as "still transient" and starts being read as a genuine, non-self-healing problem eligible
   *  for rediscovery. Mirrors src/lib/scan/health.ts's own computeConnectorHealth threshold (>2
   *  consecutive failures -> 'down') so RECOVERING->DOWN transitions in state.ts line up with the
   *  existing connector_health rollup instead of introducing a second, divergent threshold.
   */
  maxConsecutiveBeforeEscalation: number;
  /** Whether this category is plausible evidence the SOURCE itself moved/expired (not just a blip),
   *  i.e. worth spending a bounded Discovery V2 rediscovery attempt on once maxConsecutiveBeforeEscalation
   *  is exceeded. Purely a "worth trying" signal — see isProposalApprovable/deriveConfidence for what
   *  actually gets acted on afterward; this never bypasses human approval on its own.
   */
  rediscoveryEligible: boolean;
  /** Never true anywhere in this table for V1 — see this module's own closing note. A HIGH-confidence
   *  Discovery V2 candidate still only ever creates a proposal (NEEDS_REVIEW), never an approval. */
  autoActivate: false;
}

const PROFILES: Record<ErrorCategory, FailureProfile> = {
  rate_limited: {
    category: "rate_limited",
    retryableWithinScan: true,
    crossScanTransient: true,
    maxConsecutiveBeforeEscalation: 5,
    rediscoveryEligible: false,
    autoActivate: false,
  },
  timeout: {
    category: "timeout",
    retryableWithinScan: true,
    crossScanTransient: true,
    maxConsecutiveBeforeEscalation: 3,
    rediscoveryEligible: false,
    autoActivate: false,
  },
  network: {
    category: "network",
    retryableWithinScan: true,
    crossScanTransient: true,
    maxConsecutiveBeforeEscalation: 3,
    rediscoveryEligible: false,
    autoActivate: false,
  },
  provider_5xx: {
    category: "provider_5xx",
    retryableWithinScan: true,
    crossScanTransient: true,
    maxConsecutiveBeforeEscalation: 3,
    rediscoveryEligible: false,
    autoActivate: false,
  },
  parse_error: {
    category: "parse_error",
    retryableWithinScan: false,
    crossScanTransient: false,
    maxConsecutiveBeforeEscalation: 2,
    // A malformed response body is more often a provider-side content bug than a moved board —
    // real, but not obviously "worth a browser rediscovery attempt." Evidence-only in V1: it still
    // reaches NEEDS_REVIEW-eligible DOWN state for a human, just never auto-triggers Discovery V2.
    rediscoveryEligible: false,
    autoActivate: false,
  },
  invalid_config: {
    category: "invalid_config",
    retryableWithinScan: false,
    crossScanTransient: false,
    maxConsecutiveBeforeEscalation: 1,
    // The mission's own worked example (Workday token -> 422/invalid_config -> Discovery V2) —
    // exactly the "likely stale/moved source" pattern.
    rediscoveryEligible: true,
    autoActivate: false,
  },
  blocked: {
    category: "blocked",
    retryableWithinScan: false,
    crossScanTransient: false,
    maxConsecutiveBeforeEscalation: 1,
    // 401/403 evidence is ambiguous: it can mean "board moved behind auth" (rediscovery may help) or
    // "our IP/UA got blocked" (rediscovery does nothing — the replacement board would block the same
    // way). Still marked eligible: attemptSourceRediscovery/discoverCompanySourceV2's own validation
    // step is what actually decides whether a candidate is real, so a wasted attempt here costs one
    // bounded rediscovery run, not a false activation — validation, not this table, is the safety net.
    rediscoveryEligible: true,
    autoActivate: false,
  },
  unsafe_url: {
    category: "unsafe_url",
    retryableWithinScan: false,
    crossScanTransient: false,
    maxConsecutiveBeforeEscalation: 1,
    // SECURITY_REJECTED must never trigger MORE automated navigation toward the same
    // already-rejected target — see Phase 5's explicit "SECURITY_REJECTED -> never activate" rule.
    rediscoveryEligible: false,
    autoActivate: false,
  },
  unknown: {
    category: "unknown",
    retryableWithinScan: false,
    crossScanTransient: false,
    maxConsecutiveBeforeEscalation: 2,
    rediscoveryEligible: false,
    autoActivate: false,
  },
};

export function getFailureProfile(category: ErrorCategory): FailureProfile {
  return PROFILES[category];
}

/** Phase 5's "likely stale/moved source" judgment — derived from evidence, not its own ErrorCategory
 *  (see this module's own doc comment). invalid_config/blocked are the two rediscovery-eligible
 *  categories in the table above; a 404/410 status code (when known) is treated as unconditional
 *  additional evidence of staleness, mirroring pendingConnectorValidation.ts's existing
 *  shouldRejectError 404 special-case. */
export function isLikelyStaleSource(category: ErrorCategory, statusCode?: number | null): boolean {
  if (statusCode === 404 || statusCode === 410) return true;
  return getFailureProfile(category).rediscoveryEligible;
}

/** Re-exported for callers that only need the within-scan retry question and would otherwise import
 *  scan/errors.ts directly — kept here so this module is a complete, single import for "what does
 *  this failure category mean for reliability," per Phase 3's "one deterministic classification
 *  layer" framing. Not a redefinition: delegates to the exact same RETRYABLE_CATEGORIES set. */
export { isRetryableCategory };
