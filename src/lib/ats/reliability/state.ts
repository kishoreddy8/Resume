import type { Company } from "@/types";
import { getFailureProfile } from "./classification";

/**
 * Connector Reliability Control Plane V1 — Phase 2's state machine, entirely DERIVED at read time
 * from columns the scan pipeline and proposal system already write (companies.connector_health/
 * consecutive_failures/last_error_category/last_rediscovery_attempted_at, plus whether a PENDING_REVIEW
 * ats_source_proposals row exists for the company). No new persisted status column — see this
 * package's README-equivalent doc comment in classification.ts for why that's a deliberate choice,
 * not an oversight: connector_health/consecutive_failures/last_error_category already fully
 * determine everything this function computes, so a second stored "reliability_state" column would
 * be redundant state that could drift from the source of truth it's derived from.
 */
export type ReliabilityState = "HEALTHY" | "RECOVERING" | "NEEDS_REVIEW" | "DOWN" | "UNKNOWN";

/** Once a rediscovery-eligible failure has persisted this many CONSECUTIVE scan failures, recovery
 *  attempts are considered exhausted and the state stops reading RECOVERING (an indefinite "actively
 *  being worked on" claim) and reads DOWN instead — matching Phase 2's own DOWN definition verbatim:
 *  "repeated hard failure, recovery attempts exhausted, no validated replacement." Deliberately much
 *  higher than any single category's maxConsecutiveBeforeEscalation (1-5) — this is not "give up
 *  fast," it's "eventually stop presenting silent, indefinite hope once many bounded, cooldown-gated
 *  rediscovery cycles have had a real chance to run and found nothing" (see recoveryController.ts's
 *  REDISCOVERY_COOLDOWN_MS for how many real-world hours ~10 scan cycles roughly represents). Not
 *  tuned from production failure-duration data (none exists yet for this feature) — a documented,
 *  conservative starting point per the mission's own "don't invent arbitrary thresholds without
 *  documenting why" instruction; revisit once real DOWN-dwell-time data exists.
 */
const RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD = 10;

export interface ReliabilityInputs {
  company: Company;
  /** Whether a PENDING_REVIEW row exists in ats_source_proposals for this company — from ANY
   *  discovery trigger (this reliability controller's own stale-source recovery, or the pre-existing
   *  external-signals COVERAGE_MISMATCH bridge). NEEDS_REVIEW means the same thing either way:
   *  CareerOps found a plausible replacement it cannot safely activate without a human. */
  hasPendingProposal: boolean;
}

export interface ReliabilityAssessment {
  state: ReliabilityState;
  reason: string;
  /** True only when state==="HEALTHY" and the most recent successful scan discovered zero jobs —
   *  Phase 10's "a valid empty board is not a broken connector" distinction, surfaced as a sub-label
   *  rather than a fifth top-level state (a healthy-but-empty board is still, correctly, HEALTHY). */
  isHealthyEmpty: boolean;
}

/** Phase 10 — reuses scan.ts's own already-correct behavior: a successful scan (jobs.length===0,
 *  no description failures) calls recordScanSuccess exactly like any other success, so
 *  connector_health is already 'healthy' for a genuinely empty-but-reachable board. This function
 *  only adds the UI-facing sub-label; it never changes what counts as healthy. jobsDiscovered is the
 *  latest scan_run's jobs_discovered count (undefined when unknown/not joined by the caller). */
export function deriveReliabilityState(
  input: ReliabilityInputs,
  jobsDiscoveredOnLastRun?: number
): ReliabilityAssessment {
  const { company, hasPendingProposal } = input;

  if (hasPendingProposal) {
    return {
      state: "NEEDS_REVIEW",
      reason: "A candidate replacement source was found and is pending human review.",
      isHealthyEmpty: false,
    };
  }

  if (company.connector_health === "healthy") {
    return {
      state: "HEALTHY",
      reason: "Last real connector scan succeeded.",
      isHealthyEmpty: jobsDiscoveredOnLastRun === 0,
    };
  }

  if (company.connector_health === "unknown") {
    return {
      state: "UNKNOWN",
      reason: company.last_scanned_at
        ? "Connector health was reset and has not been re-verified by a real scan yet."
        : "Not yet scanned.",
      isHealthyEmpty: false,
    };
  }

  // connector_health is 'degraded' or 'down' from here on — a genuine, persisted scan problem (see
  // computeConnectorHealth / recordScanPartial / recordScanFailure; isolated per-job warnings never
  // reach connector_health at all, so every branch below is reasoning about a REAL connector issue).
  const category = company.last_error_category ?? "unknown";
  const profile = getFailureProfile(category);

  if (company.consecutive_failures >= RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD) {
    return {
      state: "DOWN",
      reason: `${company.consecutive_failures} consecutive scan failures — recovery attempts exhausted (last: ${category}).`,
      isHealthyEmpty: false,
    };
  }

  if (profile.crossScanTransient && company.consecutive_failures <= profile.maxConsecutiveBeforeEscalation) {
    return {
      state: "RECOVERING",
      reason: `${company.consecutive_failures} consecutive ${category} failure(s) — within the expected transient-recovery window.`,
      isHealthyEmpty: false,
    };
  }

  if (!profile.rediscoveryEligible) {
    return {
      state: "DOWN",
      reason: `Non-transient ${category} failure with no automatic recovery path available (${company.consecutive_failures} consecutive failure(s)).`,
      isHealthyEmpty: false,
    };
  }

  // Rediscovery-eligible: still actively in the recovery process (either about to be picked up by
  // the recovery controller, or already attempted and cooling down before the next try) until the
  // exhaustion threshold above fires.
  return {
    state: "RECOVERING",
    reason: `${category} failure looks like a possible stale/moved source — eligible for automatic rediscovery (${company.consecutive_failures} consecutive failure(s)).`,
    isHealthyEmpty: false,
  };
}

export { RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD };
