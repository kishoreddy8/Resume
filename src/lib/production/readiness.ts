import { getDb } from "@/db";
import { listScanReadyCompanies } from "@/db/queries/organizationRegistry";
import { getConnectorReliabilitySummary } from "@/db/queries/reliability";
import { getCircuitBreakerDecisions } from "@/lib/ats/reliability/circuitBreaker";
import { getProductionCycleRuntimeState } from "./state";
import type { MorningReadinessSummary } from "./types";

export function getMorningReadinessSummary(): MorningReadinessSummary {
  const db = getDb();
  const runtime = getProductionCycleRuntimeState();
  const reliabilitySummary = getConnectorReliabilitySummary();
  const circuitDecisions = getCircuitBreakerDecisions(24);
  const openCircuits = circuitDecisions.filter((d) => d.open).map((d) => d.provider);

  const scanReadyCompanies = listScanReadyCompanies().length;

  // Fresh active US jobs (<= 20 days old)
  const freshJobsRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM jobs
       WHERE is_active = 1
         AND is_archived = 0
         AND date(posted_at) >= date('now', '-20 days')`
    )
    .get() as { count: number };
  const freshActiveUsJobs = freshJobsRow.count;

  // Pending Proposals
  const pendingProposalsRow = db
    .prepare(`SELECT COUNT(*) as count FROM ats_source_proposals WHERE status = 'PENDING_REVIEW'`)
    .get() as { count: number };
  const pendingProposals = pendingProposalsRow.count;

  // Coverage queries
  const companiesWithFreshJobsRow = db
    .prepare(
      `SELECT COUNT(DISTINCT company_id) as count FROM jobs
       WHERE is_active = 1
         AND is_archived = 0
         AND date(posted_at) >= date('now', '-20 days')`
    )
    .get() as { count: number };

  const scanReadyWithFreshJobsRow = db
    .prepare(
      `SELECT COUNT(DISTINCT j.company_id) as count FROM jobs j
       JOIN companies c ON c.id = j.company_id
       WHERE j.is_active = 1
         AND j.is_archived = 0
         AND c.source_type != 'career_link'
         AND date(j.posted_at) >= date('now', '-20 days')`
    )
    .get() as { count: number };

  const genericCompaniesRow = db
    .prepare(
      `SELECT COUNT(*) as count FROM companies
       WHERE is_active = 1 AND source_type = 'career_link'`
    )
    .get() as { count: number };

  const lastSummary = runtime.lastSummary;
  const telemetryGaps: string[] = [];
  if (!lastSummary) {
    telemetryGaps.push("No prior production cycle summary recorded; cycle metrics reflect uninitialized state.");
  }

  // ATS metrics
  const atsMetrics = lastSummary?.phases.atsScan.metrics;
  const atsAttempted = atsMetrics?.companiesAttempted ?? 0;
  const atsSuccessful = atsMetrics?.successCount ?? 0;
  const atsPartial = atsMetrics?.partialCount ?? 0;
  const atsFailed = atsMetrics?.failedCount ?? 0;
  const atsSuccessPercentage = atsAttempted > 0 ? (atsSuccessful / atsAttempted) * 100 : null;

  // Jobs metrics
  const newAtsJobs = atsMetrics?.newJobs ?? 0;
  const newBuiltInJobs = lastSummary?.phases.builtIn.metrics.newJobsInserted ?? 0;
  const totalNewJobs = newAtsJobs + newBuiltInJobs;

  // Built In metrics
  const builtInMetrics = lastSummary?.phases.builtIn.metrics;
  const builtInDiscovered = builtInMetrics?.listingsDiscovered ?? 0;
  const builtInResolved =
    (builtInMetrics?.matchedExistingCount ?? 0) +
    (builtInMetrics?.newVerifiedEmployersCount ?? 0) +
    (builtInMetrics?.atsDiscoveredEmployersCount ?? 0);
  const builtInUnresolved =
    (builtInMetrics?.insufficientEvidenceCount ?? 0) + (builtInMetrics?.ambiguousCount ?? 0);
  const builtInOnboarded = builtInMetrics?.newCompaniesCreated ?? 0;
  const crossSourceDupsPrevented = builtInMetrics?.crossSourceDuplicatesPrevented ?? 0;

  // Discovery metrics
  const discoveryMetrics = lastSummary?.phases.discoveryV2.metrics;
  const discoveryCompaniesChecked = discoveryMetrics?.companiesAttempted ?? 0;
  const discoveryCandidates = discoveryMetrics?.structuredCandidatesFound ?? 0;

  // Needs Attention
  const failedPhases: string[] = [];
  if (lastSummary) {
    for (const [name, phase] of Object.entries(lastSummary.phases)) {
      if (phase.status === "FAILED" || phase.status === "DEGRADED") {
        failedPhases.push(`${name} (${phase.status}${phase.error ? ": " + phase.error : ""})`);
      }
    }
  }

  const attentionDetails: Array<{ type: string; message: string; companyId?: number; companyName?: string }> = [];

  for (const item of reliabilitySummary.needsAttention) {
    attentionDetails.push({
      type: item.state,
      message: `${item.name} (${item.sourceType}): ${item.reason}`,
      companyId: item.id,
      companyName: item.name,
    });
  }

  if (pendingProposals > 0) {
    attentionDetails.push({
      type: "PENDING_PROPOSALS",
      message: `${pendingProposals} ATS source proposal(s) awaiting operator review.`,
    });
  }

  if (failedPhases.length > 0) {
    attentionDetails.push({
      type: "FAILED_PHASES",
      message: `Production cycle degraded/failed phases: ${failedPhases.join("; ")}`,
    });
  }

  return {
    productionCycle: {
      lastRunAt: runtime.lastCompletedAt,
      durationMs: runtime.lastDurationMs,
      status: runtime.lastStatus,
      statusReason: lastSummary?.statusReason ?? runtime.lastError,
    },
    ats: {
      scanReadyCompanies,
      attempted: atsAttempted,
      successful: atsSuccessful,
      partial: atsPartial,
      failed: atsFailed,
      successPercentage: atsSuccessPercentage ? Math.round(atsSuccessPercentage * 10) / 10 : null,
    },
    reliability: {
      healthy: reliabilitySummary.healthy,
      recovering: reliabilitySummary.recovering,
      needsReview: reliabilitySummary.needsReview,
      down: reliabilitySummary.down,
      unknown: reliabilitySummary.unknown,
      recoveredThisCycle: lastSummary?.phases.reliability.metrics.recoveryAttempted ?? 0,
      openCircuits,
    },
    jobs: {
      freshActiveUsJobs,
      newAtsJobsThisCycle: newAtsJobs,
      newBuiltInJobsThisCycle: newBuiltInJobs,
      totalNewJobsThisCycle: totalNewJobs,
    },
    builtIn: {
      listingsDiscovered: builtInDiscovered,
      resolved: builtInResolved,
      unresolved: builtInUnresolved,
      employersOnboarded: builtInOnboarded,
      crossSourceDuplicatesPrevented: crossSourceDupsPrevented,
    },
    discovery: {
      companiesChecked: discoveryCompaniesChecked,
      atsCandidatesDiscovered: discoveryCandidates,
      pendingProposals,
    },
    coverage: {
      companiesWithFreshJobs: companiesWithFreshJobsRow.count,
      scanReadyWithFreshJobs: scanReadyWithFreshJobsRow.count,
      genericCompaniesRemaining: genericCompaniesRow.count,
    },
    needsAttention: {
      pendingProposals,
      persistentDownConnectors: reliabilitySummary.down,
      failedPhases,
      details: attentionDetails,
    },
    telemetryGaps,
  };
}
