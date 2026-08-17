import { listScanReadyCompanies, listDiscoveryV2Candidates } from "@/db/queries/organizationRegistry";
import { getConnectorReliabilitySummary } from "@/db/queries/reliability";
import { createProposalFromDiscoveryV2 } from "@/db/queries/atsSourceProposals";
import { runConnectorRecovery } from "@/lib/ats/reliability/recoveryController";
import { getCircuitBreakerDecisions } from "@/lib/ats/reliability/circuitBreaker";
import { discoverCompanySourceV2, type DiscoveryV2Result } from "@/lib/ats/discoveryV2";
import { runScan } from "@/lib/scan";
import { searchBuiltInAcrossRoles } from "@/lib/externalSignals/providers";
import { DEFAULT_SEARCH_ROLES } from "@/lib/externalSignals/types";
import { processExternalListing } from "@/lib/externalSignals/pipeline";
import { retireSupersededSecondaryJobs } from "@/lib/externalSignals/secondaryIngestion";
import {
  acquireProductionCycleLock,
  heartbeatProductionCycleLock,
  PRODUCTION_LOCK_HEARTBEAT_INTERVAL_MS,
  recordProductionCycleCompleted,
  recordProductionCycleFailed,
  recordProductionCycleStarted,
  releaseProductionCycleLock,
} from "./state";
import type {
  AtsScanPhaseMetrics,
  AtsScanPhaseResult,
  BuiltInPhaseMetrics,
  BuiltInPhaseResult,
  CrossSourceDedupPhaseResult,
  DiscoveryV2PhaseMetrics,
  DiscoveryV2PhaseResult,
  PhaseStatus,
  ProductionCycleStatus,
  ProductionCycleSummary,
  ReliabilityPhaseMetrics,
  ReliabilityPhaseResult,
  RunProductionCycleOptions,
} from "./types";

export type { RunProductionCycleOptions, ProductionCycleSummary, ProductionCycleStatus };

function createCycleId(now: Date): string {
  return `cycle-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * Phase 1: Reliability / Recovery Phase
 */
async function executeReliabilityPhase(
  options: RunProductionCycleOptions
): Promise<ReliabilityPhaseResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    const circuitDecisions = getCircuitBreakerDecisions(24);
    const openCircuits = circuitDecisions.filter((d) => d.open).map((d) => d.provider);

    let recoverySummary = null;
    let recoveryAttempted = 0;
    let recoveryProposalsCreated = 0;

    if (!options.skipPhases?.includes("reliability")) {
      const runner = options.recoveryRunner ?? runConnectorRecovery;
      recoverySummary = await runner({
        limit: options.reliabilityLimit ?? 5,
        cooldownHours: 6,
      });
      recoveryAttempted = recoverySummary.attempted;
      recoveryProposalsCreated = recoverySummary.proposalsCreated;
    }

    const summaryAfter = getConnectorReliabilitySummary();
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    const metrics: ReliabilityPhaseMetrics = {
      healthyCount: summaryAfter.healthy,
      recoveringCount: summaryAfter.recovering,
      needsReviewCount: summaryAfter.needsReview,
      downCount: summaryAfter.down,
      unknownCount: summaryAfter.unknown,
      openCircuits,
      recoveryAttempted,
      recoveryProposalsCreated,
      recoverySummary,
    };

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "COMPLETED",
      metrics,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "DEGRADED",
      metrics: {
        healthyCount: 0,
        recoveringCount: 0,
        needsReviewCount: 0,
        downCount: 0,
        unknownCount: 0,
        openCircuits: [],
        recoveryAttempted: 0,
        recoveryProposalsCreated: 0,
        recoverySummary: null,
      },
      error: errorMsg,
    };
  }
}

/**
 * Phase 2: Approved ATS Scan Phase
 */
async function executeAtsScanPhase(
  options: RunProductionCycleOptions
): Promise<AtsScanPhaseResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    if (options.skipPhases?.includes("atsScan")) {
      const completedAt = new Date().toISOString();
      return {
        startedAt,
        completedAt,
        durationMs: 0,
        status: "SKIPPED",
        metrics: {
          companiesAttempted: 0,
          successCount: 0,
          partialCount: 0,
          failedCount: 0,
          jobsDiscovered: 0,
          newJobs: 0,
          updatedJobs: 0,
          closedJobs: 0,
          suppressedJobs: 0,
          duplicatesSkipped: 0,
          staleRejected: 0,
          foreignFiltered: 0,
          unknownDateCount: 0,
          descriptionFailures: 0,
          providerBreakdown: {},
        },
      };
    }

    const companies = options.atsCompanies ?? listScanReadyCompanies();
    const scanSummary = await runScan(companies, { usOnly: true, runAgeSweep: false });

    let successCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    const providerBreakdown: AtsScanPhaseMetrics["providerBreakdown"] = {};

    for (const res of scanSummary.results) {
      const provider = res.sourceType || "unknown";
      if (!providerBreakdown[provider]) {
        providerBreakdown[provider] = { attempted: 0, success: 0, failed: 0, jobsNew: 0, jobsUpdated: 0 };
      }
      providerBreakdown[provider].attempted++;
      providerBreakdown[provider].jobsNew += res.jobsNew;
      providerBreakdown[provider].jobsUpdated += res.jobsUpdated;

      if (res.status === "error") {
        failedCount++;
        providerBreakdown[provider].failed++;
      } else {
        successCount++;
        providerBreakdown[provider].success++;
        if (res.jobsSuppressed > 0 || (res.freshnessMetrics && res.freshnessMetrics.foreignFiltered > 0)) {
          partialCount++;
        }
      }
    }

    let phaseStatus: PhaseStatus = "COMPLETED";
    if (failedCount > 0 && successCount > 0) {
      phaseStatus = "DEGRADED";
    } else if (failedCount > 0 && successCount === 0 && companies.length > 0) {
      phaseStatus = "FAILED";
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    // ScanSummary.freshnessMetrics is genuinely optional on the real type (src/types/index.ts) —
    // runScan() always populates it in practice, but this stays defensive rather than assume that.
    const freshness = scanSummary.freshnessMetrics;

    const metrics: AtsScanPhaseMetrics = {
      companiesAttempted: companies.length,
      successCount,
      partialCount,
      failedCount,
      jobsDiscovered: scanSummary.jobsNew + scanSummary.jobsUpdated + scanSummary.jobsClosed,
      newJobs: scanSummary.jobsNew,
      updatedJobs: scanSummary.jobsUpdated,
      closedJobs: scanSummary.jobsClosed,
      suppressedJobs: scanSummary.jobsSuppressed,
      duplicatesSkipped: 0,
      staleRejected: freshness?.staleRejected ?? 0,
      foreignFiltered: freshness?.foreignFiltered ?? 0,
      unknownDateCount: freshness?.unknownDateCount ?? 0,
      descriptionFailures: freshness?.pseudoJobFiltered ?? 0,
      providerBreakdown,
    };

    return {
      startedAt,
      completedAt,
      durationMs,
      status: phaseStatus,
      metrics,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "FAILED",
      metrics: {
        companiesAttempted: 0,
        successCount: 0,
        partialCount: 0,
        failedCount: 0,
        jobsDiscovered: 0,
        newJobs: 0,
        updatedJobs: 0,
        closedJobs: 0,
        suppressedJobs: 0,
        duplicatesSkipped: 0,
        staleRejected: 0,
        foreignFiltered: 0,
        unknownDateCount: 0,
        descriptionFailures: 0,
        providerBreakdown: {},
      },
      error: errorMsg,
    };
  }
}

/**
 * Phase 3: Built In Market Discovery & Safe Ingestion Phase
 */
async function executeBuiltInPhase(
  options: RunProductionCycleOptions
): Promise<BuiltInPhaseResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    if (options.skipPhases?.includes("builtIn")) {
      const completedAt = new Date().toISOString();
      return {
        startedAt,
        completedAt,
        durationMs: 0,
        status: "SKIPPED",
        metrics: {
          listingsDiscovered: 0,
          uniqueListings: 0,
          usAndFreshListings: 0,
          matchedExistingCount: 0,
          newVerifiedEmployersCount: 0,
          atsDiscoveredEmployersCount: 0,
          insufficientEvidenceCount: 0,
          ambiguousCount: 0,
          newCompaniesCreated: 0,
          organizationsReused: 0,
          newOrganizationsCreated: 0,
          newJobsInserted: 0,
          jobsUpdated: 0,
          crossSourceDuplicatesPrevented: 0,
          proposalsCreated: 0,
        },
      };
    }

    const roles = options.builtInRoles ?? DEFAULT_SEARCH_ROLES;
    const searcher = options.builtInSearcher ?? searchBuiltInAcrossRoles;
    const rawListings = await searcher(roles, {
      limitPerRole: options.builtInLimitPerRole ?? 10,
      maxTotalUnique: options.builtInMaxTotalUnique ?? 100,
    });

    let matchedExistingCount = 0;
    let newVerifiedEmployersCount = 0;
    let atsDiscoveredEmployersCount = 0;
    let insufficientEvidenceCount = 0;
    let ambiguousCount = 0;
    let newCompaniesCreated = 0;
    let organizationsReused = 0;
    let newOrganizationsCreated = 0;
    let newJobsInserted = 0;
    let jobsUpdated = 0;
    let crossSourceDuplicatesPrevented = 0;
    let proposalsCreated = 0;
    let usAndFreshCount = 0;

    for (const raw of rawListings) {
      const res = await processExternalListing("built_in", raw, {
        persistObservations: true,
        persistSecondaryJobs: true,
        onboardNewEmployers: true,
      });

      if (res.decision === "SECONDARY_JOB_CANDIDATE" || res.decision === "DISCOVERY_BEACON_ONLY") {
        usAndFreshCount++;
      }

      if (res.match.confidence === "AMBIGUOUS") {
        ambiguousCount++;
      } else if (res.match.companyId !== null) {
        matchedExistingCount++;
      } else {
        if (res.decision === "NON_US" || res.decision === "STALE" || res.decision === "LOW_QUALITY" || res.decision === "STAFFING_AGENCY") {
          insufficientEvidenceCount++;
        }
      }

      if (res.newEmployerOnboarding) {
        if (res.newEmployerOnboarding.outcome === "created") {
          newCompaniesCreated++;
          newOrganizationsCreated++;
          if (res.newEmployerOnboarding.proposalCreated) {
            atsDiscoveredEmployersCount++;
            proposalsCreated++;
          } else {
            newVerifiedEmployersCount++;
          }
        } else if (res.newEmployerOnboarding.outcome === "linked_existing_organization") {
          newCompaniesCreated++;
          organizationsReused++;
          if (res.newEmployerOnboarding.proposalCreated) {
            atsDiscoveredEmployersCount++;
            proposalsCreated++;
          } else {
            newVerifiedEmployersCount++;
          }
        }
      }

      if (res.stagedJob) {
        if (res.stagedJob.outcome === "inserted") {
          newJobsInserted++;
        } else if (res.stagedJob.outcome === "updated") {
          jobsUpdated++;
        } else if (res.stagedJob.outcome === "suppressed") {
          crossSourceDuplicatesPrevented++;
        }
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    const metrics: BuiltInPhaseMetrics = {
      listingsDiscovered: rawListings.length,
      uniqueListings: rawListings.length,
      usAndFreshListings: usAndFreshCount,
      matchedExistingCount,
      newVerifiedEmployersCount,
      atsDiscoveredEmployersCount,
      insufficientEvidenceCount,
      ambiguousCount,
      newCompaniesCreated,
      organizationsReused,
      newOrganizationsCreated,
      newJobsInserted,
      jobsUpdated,
      crossSourceDuplicatesPrevented,
      proposalsCreated,
    };

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "COMPLETED",
      metrics,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "DEGRADED",
      metrics: {
        listingsDiscovered: 0,
        uniqueListings: 0,
        usAndFreshListings: 0,
        matchedExistingCount: 0,
        newVerifiedEmployersCount: 0,
        atsDiscoveredEmployersCount: 0,
        insufficientEvidenceCount: 0,
        ambiguousCount: 0,
        newCompaniesCreated: 0,
        organizationsReused: 0,
        newOrganizationsCreated: 0,
        newJobsInserted: 0,
        jobsUpdated: 0,
        crossSourceDuplicatesPrevented: 0,
        proposalsCreated: 0,
      },
      error: errorMsg,
    };
  }
}

/**
 * Phase 4: Cross-Source Dedup & Official Source Preference
 */
async function executeCrossSourceDedupPhase(
  options: RunProductionCycleOptions
): Promise<CrossSourceDedupPhaseResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    if (options.skipPhases?.includes("crossSourceDedup")) {
      const completedAt = new Date().toISOString();
      return {
        startedAt,
        completedAt,
        durationMs: 0,
        status: "SKIPPED",
        metrics: { secondaryJobsRetired: 0 },
      };
    }

    // retireSupersededSecondaryJobs is per-company (it needs to know which company's OFFICIAL
    // source_type to prefer) — there is no existing global sweep variant, and this stage never
    // invents one. Reuses the exact same scan-ready company set the ATS phase itself scans (a
    // secondary job only ever becomes supersedable once that company's official ATS source has
    // confirmed the equivalent listing), so this phase never touches companies the ATS phase didn't.
    const companies = options.atsCompanies ?? listScanReadyCompanies();
    let secondaryJobsRetired = 0;
    let dedupErrorsCount = 0;
    let lastDedupError: string | undefined;

    for (const company of companies) {
      try {
        secondaryJobsRetired += retireSupersededSecondaryJobs(company.id).length;
      } catch (err) {
        dedupErrorsCount++;
        lastDedupError = err instanceof Error ? err.message : String(err);
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    return {
      startedAt,
      completedAt,
      durationMs,
      status: dedupErrorsCount > 0 ? "DEGRADED" : "COMPLETED",
      metrics: { secondaryJobsRetired },
      error: lastDedupError,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "DEGRADED",
      metrics: { secondaryJobsRetired: 0 },
      error: errorMsg,
    };
  }
}

/**
 * Phase 5: Discovery V2 Coverage-Gap Phase
 */
async function executeDiscoveryV2Phase(
  options: RunProductionCycleOptions
): Promise<DiscoveryV2PhaseResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    if (options.skipPhases?.includes("discoveryV2")) {
      const completedAt = new Date().toISOString();
      return {
        startedAt,
        completedAt,
        durationMs: 0,
        status: "SKIPPED",
        metrics: {
          companiesAttempted: 0,
          structuredCandidatesFound: 0,
          validatedJobsCount: 0,
          validatedZeroJobsCount: 0,
          validationFailedCount: 0,
          securityRejectedCount: 0,
          unsupportedCount: 0,
          proposalsCreated: 0,
          results: [],
        },
      };
    }

    const candidates = listDiscoveryV2Candidates("both", options.discoveryV2Limit ?? 5);
    const discover = options.discoverer ?? discoverCompanySourceV2;
    let structuredCandidatesFound = 0;
    let validatedJobsCount = 0;
    let validatedZeroJobsCount = 0;
    let validationFailedCount = 0;
    let securityRejectedCount = 0;
    let unsupportedCount = 0;
    let proposalsCreated = 0;
    let discoveryErrorsCount = 0;
    let lastDiscoveryError: string | undefined;
    const results: DiscoveryV2Result[] = [];

    for (const company of candidates) {
      // discoverCompanySourceV2 requires a seed URL to start from — reuses the SAME field
      // discoveryV2Bridge.ts (Phase 11's own caller) treats as authoritative when no fresher
      // per-observation evidence exists. A company with no career_page_url on file has nothing to
      // seed a Discovery V2 attempt from; skipped, never guessed.
      const seedUrl = company.career_page_url;
      if (!seedUrl) continue;

      try {
        const res = await discover(company, seedUrl);
        results.push(res);

        if (res.outcome === "STRUCTURED_CANDIDATE_FOUND" && res.candidates && res.candidates.length > 0) {
          structuredCandidatesFound += res.candidates.length;
          for (const cand of res.candidates) {
            if (cand.validationStatus === "VALIDATED_JOBS") validatedJobsCount++;
            else if (cand.validationStatus === "VALIDATED_ZERO_JOBS") validatedZeroJobsCount++;
            else if (cand.validationStatus === "VALIDATION_FAILED") validationFailedCount++;
            else if (cand.validationStatus === "SECURITY_REJECTED") securityRejectedCount++;
            else if (cand.validationStatus === "UNSUPPORTED") unsupportedCount++;

            // Strictly create proposal only (PENDING_REVIEW) — ZERO auto-approval!
            const proposal = createProposalFromDiscoveryV2({
              companyId: company.id,
              currentSourceType: company.source_type,
              currentBoardToken: company.ats_board_token,
              candidate: {
                provider: cand.provider,
                boardToken: cand.boardToken,
                canonicalUrl: cand.canonicalUrl,
                confidence: cand.confidence,
                validationStatus: cand.validationStatus,
                recommendation: cand.recommendation,
                evidenceTypes: cand.evidenceTypes,
                evidenceUrls: cand.evidenceUrls,
              },
            });
            if (proposal) {
              proposalsCreated++;
            }
          }
        } else if (res.outcome === "SECURITY_REJECTED") {
          securityRejectedCount++;
        }
      } catch (err) {
        discoveryErrorsCount++;
        lastDiscoveryError = err instanceof Error ? err.message : String(err);
      }
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    const metrics: DiscoveryV2PhaseMetrics = {
      companiesAttempted: candidates.length,
      structuredCandidatesFound,
      validatedJobsCount,
      validatedZeroJobsCount,
      validationFailedCount,
      securityRejectedCount,
      unsupportedCount,
      proposalsCreated,
      results,
    };

    return {
      startedAt,
      completedAt,
      durationMs,
      status: discoveryErrorsCount > 0 ? "DEGRADED" : "COMPLETED",
      metrics,
      error: lastDiscoveryError,
    };
  } catch (err) {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);

    return {
      startedAt,
      completedAt,
      durationMs,
      status: "DEGRADED",
      metrics: {
        companiesAttempted: 0,
        structuredCandidatesFound: 0,
        validatedJobsCount: 0,
        validatedZeroJobsCount: 0,
        validationFailedCount: 0,
        securityRejectedCount: 0,
        unsupportedCount: 0,
        proposalsCreated: 0,
        results: [],
      },
      error: errorMsg,
    };
  }
}

/**
 * Derives overall production cycle status.
 */
function deriveOverallStatus(phases: {
  reliability: ReliabilityPhaseResult;
  atsScan: AtsScanPhaseResult;
  builtIn: BuiltInPhaseResult;
  crossSourceDedup: CrossSourceDedupPhaseResult;
  discoveryV2: DiscoveryV2PhaseResult;
}): { status: ProductionCycleStatus; reason: string } {
  // Critical Failure: ATS Scan fatal failure
  if (phases.atsScan.status === "FAILED") {
    return {
      status: "FAILED",
      reason: `Core ATS scan failed: ${phases.atsScan.error || "0% company success rate"}`,
    };
  }

  const degradedReasons: string[] = [];

  if (phases.atsScan.status === "DEGRADED") {
    degradedReasons.push(`ATS scan had ${phases.atsScan.metrics.failedCount} failed companies`);
  }
  if (phases.reliability.status === "DEGRADED" || phases.reliability.status === "FAILED") {
    degradedReasons.push(`Reliability phase error: ${phases.reliability.error || "degraded"}`);
  }
  if (phases.reliability.metrics.openCircuits.length > 0) {
    degradedReasons.push(`Open provider circuits: ${phases.reliability.metrics.openCircuits.join(", ")}`);
  }
  if (phases.builtIn.status === "DEGRADED" || phases.builtIn.status === "FAILED") {
    degradedReasons.push(`Built In phase error: ${phases.builtIn.error || "degraded"}`);
  }
  if (phases.crossSourceDedup.status === "DEGRADED" || phases.crossSourceDedup.status === "FAILED") {
    degradedReasons.push(`Cross-source dedup error: ${phases.crossSourceDedup.error || "degraded"}`);
  }
  if (phases.discoveryV2.status === "DEGRADED" || phases.discoveryV2.status === "FAILED") {
    degradedReasons.push(`Discovery V2 error: ${phases.discoveryV2.error || "degraded"}`);
  }

  if (degradedReasons.length > 0) {
    return {
      status: "DEGRADED",
      reason: degradedReasons.join("; "),
    };
  }

  return {
    status: "READY",
    reason: "All production phases completed successfully with zero acceptance-critical defects.",
  };
}

/**
 * Main Production Cycle Orchestrator.
 * Coordinates Reliability, Approved ATS Scanning, Built In Ingestion, Cross-Source Dedup, and Discovery V2.
 * Enforces mutual exclusion via a heartbeating lease (see ./state.ts) — a healthy cycle renews its
 * own lease every heartbeatIntervalMs, so only a genuinely abandoned (heartbeat-stopped) cycle can
 * ever be taken over, regardless of total wall-clock duration. Never triggers lifecycle maintenance
 * or resume tailoring.
 */
export async function runProductionCycle(
  options: RunProductionCycleOptions = {},
  now: Date = new Date()
): Promise<ProductionCycleSummary> {
  const lockResult = acquireProductionCycleLock(now);
  if (!lockResult.acquired || !lockResult.ownerId) {
    throw new Error(`Production cycle already running (locked since ${lockResult.heldSince})`);
  }
  const ownerId = lockResult.ownerId;

  const startedAt = now.toISOString();
  const startedMs = now.getTime();
  const cycleId = createCycleId(now);
  recordProductionCycleStarted(now);

  // Lease heartbeat — its own timer, independent of phase boundaries, so a single slow real call
  // (Discovery V2 candidates have been observed taking up to ~90s) never starves it. A failed
  // renewal (lost ownership — e.g. this process stalled long enough for the lease to already be
  // considered stale and taken over) is recorded, never silently ignored: see leaseWarning below.
  let leaseWarning: string | undefined;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? PRODUCTION_LOCK_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimer = setInterval(() => {
    if (leaseWarning) return; // already lost the lease; no point retrying with a stolen ownerId.
    try {
      const stillOwned = heartbeatProductionCycleLock(ownerId);
      if (!stillOwned) {
        leaseWarning = "Lease heartbeat failed: another production cycle now owns the lock (this cycle's lease expired mid-run).";
      }
    } catch (err) {
      leaseWarning = `Lease heartbeat threw: ${err instanceof Error ? err.message : String(err)}`;
    }
  }, heartbeatIntervalMs);
  // Never let the heartbeat's own timer keep the Node process alive on its own.
  heartbeatTimer.unref?.();

  try {
    // 1. Reliability & Recovery Phase
    const reliability = await executeReliabilityPhase(options);

    // 2. Approved ATS Scan Phase
    const atsScan = await executeAtsScanPhase(options);

    // 3. Built In Discovery & Ingestion Phase
    const builtIn = await executeBuiltInPhase(options);

    // 4. Cross-Source Dedup / Official Source Preference Phase
    const crossSourceDedup = await executeCrossSourceDedupPhase(options);

    // 5. Discovery V2 Coverage-Gap Phase
    const discoveryV2 = await executeDiscoveryV2Phase(options);

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startedMs;

    const derived = deriveOverallStatus({
      reliability,
      atsScan,
      builtIn,
      crossSourceDedup,
      discoveryV2,
    });
    // A lost lease means a second cycle may now legitimately be running concurrently — never
    // report READY as if nothing happened, even if every phase this cycle ran itself completed
    // cleanly, since a concurrent cycle's writes are exactly the hazard this lease exists to prevent.
    const status = leaseWarning && derived.status === "READY" ? "DEGRADED" : derived.status;
    const reason = derived.reason;

    const summary: ProductionCycleSummary = {
      cycleId,
      startedAt,
      completedAt,
      durationMs,
      status,
      statusReason: leaseWarning ? `${reason} | ${leaseWarning}` : reason,
      phases: {
        reliability,
        atsScan,
        builtIn,
        crossSourceDedup,
        discoveryV2,
      },
      ...(leaseWarning ? { leaseWarning } : {}),
    };

    recordProductionCycleCompleted(summary);
    return summary;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    recordProductionCycleFailed(errorMsg);
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    // Ownership-checked: if the lease was already lost (leaseWarning set), this safely no-ops
    // rather than clearing whichever new cycle now legitimately owns the lock.
    releaseProductionCycleLock(ownerId);
  }
}
