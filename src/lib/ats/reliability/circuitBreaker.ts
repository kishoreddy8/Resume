import { getProviderHealthSummary, type ProviderHealthSummary } from "@/db/queries/reliability";
import type { SourceType } from "@/types";

/**
 * Phase 8 — bounded, provider-level circuit breaker for the automatic rediscovery path ONLY. Never
 * gates scanning itself (a scan is a cheap, ordinary fetch every company already gets on its normal
 * schedule regardless of provider health) — it exists solely to stop the EXPENSIVE, browser-rendered
 * Discovery V2 rediscovery attempt (recoveryController.ts) from firing across many companies at once
 * when the evidence points to a provider-wide incident rather than N independent per-company source
 * changes, which Discovery V2 cannot fix anyway (the provider itself being down means there is
 * nothing new to discover).
 *
 * Deliberately holds NO persisted circuit state (open/closed/half-open) of its own — see this
 * module's own isCircuitOpen: every call re-derives the decision from the same windowed
 * getProviderHealthSummary data the observability layer already computes, so "recovering" happens
 * automatically and for free the moment enough of that provider's ordinary scheduled scans start
 * succeeding again — no separate recovery/reset logic to get wrong, and nothing to leave stuck open
 * if a process restarts mid-incident.
 *
 * Thresholds are conservative, documented starting points (no historical incident data exists yet
 * for this exact windowed metric to tune against) — trivially revisable via the two exported
 * constants below, per the mission's explicit "don't invent thresholds without documenting why."
 */

/** Minimum recent scan attempts (successes + failures) on a provider within the window before this
 *  module will even consider opening the breaker — below this, a handful of failures could easily
 *  just be a couple of genuinely broken individual companies, not a provider-wide signal. */
export const CIRCUIT_MIN_SAMPLE_SIZE = 10;

/** Provider-wide success rate floor. Individual companies already tolerate 1-5 consecutive failures
 *  before escalating (see classification.ts's maxConsecutiveBeforeEscalation) and connector_health
 *  itself stays 'degraded' rather than 'down' for the first couple of failures (computeConnectorHealth,
 *  src/lib/scan/health.ts) — both existing mechanisms are already conservative about calling a single
 *  company broken. A provider-wide aggregate success rate this low, across enough distinct attempts
 *  (CIRCUIT_MIN_SAMPLE_SIZE), is strong evidence that ordinary per-company noise cannot explain —
 *  i.e. plausibly the provider/adapter itself, not many unrelated company-level source changes. */
export const CIRCUIT_FAILURE_RATE_THRESHOLD = 0.5;

/** How many companies from an open-circuit provider may still go through per recovery-controller
 *  invocation — Phase 8's own "periodically test a very small number of connectors" requirement.
 *  Never zero (a fully-blocked provider could never demonstrate recovery) and deliberately tiny. */
export const CIRCUIT_PROBE_ALLOWANCE = 1;

export interface CircuitBreakerDecision {
  provider: SourceType;
  open: boolean;
  reason: string;
  summary: ProviderHealthSummary | null;
}

/** Pure function over an already-fetched summary — split out from getCircuitBreakerDecisions below
 *  so callers/tests can evaluate the threshold logic without a database. */
export function evaluateCircuitBreaker(summary: ProviderHealthSummary): CircuitBreakerDecision {
  const attempted = summary.recentSuccessfulScans + summary.recentFailedScans;
  if (attempted < CIRCUIT_MIN_SAMPLE_SIZE) {
    return {
      provider: summary.provider,
      open: false,
      reason: `Only ${attempted} recent scan attempt(s) — below the ${CIRCUIT_MIN_SAMPLE_SIZE}-attempt minimum sample size to evaluate a provider-wide incident.`,
      summary,
    };
  }
  if (summary.successRate !== null && summary.successRate < CIRCUIT_FAILURE_RATE_THRESHOLD) {
    return {
      provider: summary.provider,
      open: true,
      reason: `Provider-wide success rate ${(summary.successRate * 100).toFixed(0)}% across ${attempted} recent attempts is below the ${(CIRCUIT_FAILURE_RATE_THRESHOLD * 100).toFixed(0)}% threshold — suspected provider-wide incident, not independent per-company source changes.`,
      summary,
    };
  }
  return {
    provider: summary.provider,
    open: false,
    reason: `Provider-wide success rate is healthy (${attempted} recent attempts).`,
    summary,
  };
}

/** Convenience wrapper for real callers (recoveryController.ts) — fetches the current windowed
 *  provider health summary and evaluates every provider found in it. */
export function getCircuitBreakerDecisions(windowHours = 24): CircuitBreakerDecision[] {
  return getProviderHealthSummary(windowHours).map(evaluateCircuitBreaker);
}
