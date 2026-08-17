import type { Company, SourceType } from "@/types";
import type { RecoveryControllerSummary } from "@/lib/ats/reliability/recoveryController";
import type { DiscoveryV2Result } from "@/lib/ats/discoveryV2";

export type ProductionCycleStatus = "READY" | "DEGRADED" | "FAILED";
export type PhaseStatus = "COMPLETED" | "DEGRADED" | "FAILED" | "SKIPPED";

export interface PhaseTiming {
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface ReliabilityPhaseMetrics {
  healthyCount: number;
  recoveringCount: number;
  needsReviewCount: number;
  downCount: number;
  unknownCount: number;
  openCircuits: SourceType[];
  recoveryAttempted: number;
  recoveryProposalsCreated: number;
  recoverySummary: RecoveryControllerSummary | null;
}

export interface ReliabilityPhaseResult extends PhaseTiming {
  status: PhaseStatus;
  metrics: ReliabilityPhaseMetrics;
  error?: string;
}

export interface AtsScanPhaseMetrics {
  companiesAttempted: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  jobsDiscovered: number;
  newJobs: number;
  updatedJobs: number;
  closedJobs: number;
  suppressedJobs: number;
  duplicatesSkipped: number;
  staleRejected: number;
  foreignFiltered: number;
  /** Aggregated from ScanSummary.freshnessMetrics.unknownDateCount — jobs with no reliable posted
   *  date (provider or first-seen fallback), not a location signal despite the name similarity to
   *  scan.ts's own per-company (DB-only, never returned to callers) unknownLocationCount. */
  unknownDateCount: number;
  descriptionFailures: number;
  providerBreakdown: Record<string, { attempted: number; success: number; failed: number; jobsNew: number; jobsUpdated: number }>;
}

export interface AtsScanPhaseResult extends PhaseTiming {
  status: PhaseStatus;
  metrics: AtsScanPhaseMetrics;
  error?: string;
}

export interface BuiltInPhaseMetrics {
  listingsDiscovered: number;
  uniqueListings: number;
  usAndFreshListings: number;
  matchedExistingCount: number;
  newVerifiedEmployersCount: number;
  atsDiscoveredEmployersCount: number;
  insufficientEvidenceCount: number;
  ambiguousCount: number;
  newCompaniesCreated: number;
  organizationsReused: number;
  newOrganizationsCreated: number;
  newJobsInserted: number;
  jobsUpdated: number;
  crossSourceDuplicatesPrevented: number;
  proposalsCreated: number;
}

export interface BuiltInPhaseResult extends PhaseTiming {
  status: PhaseStatus;
  metrics: BuiltInPhaseMetrics;
  error?: string;
}

export interface CrossSourceDedupPhaseMetrics {
  secondaryJobsRetired: number;
}

export interface CrossSourceDedupPhaseResult extends PhaseTiming {
  status: PhaseStatus;
  metrics: CrossSourceDedupPhaseMetrics;
  error?: string;
}

export interface DiscoveryV2PhaseMetrics {
  companiesAttempted: number;
  structuredCandidatesFound: number;
  validatedJobsCount: number;
  validatedZeroJobsCount: number;
  validationFailedCount: number;
  securityRejectedCount: number;
  unsupportedCount: number;
  proposalsCreated: number;
  results: DiscoveryV2Result[];
}

export interface DiscoveryV2PhaseResult extends PhaseTiming {
  status: PhaseStatus;
  metrics: DiscoveryV2PhaseMetrics;
  error?: string;
}

export interface ProductionCycleSummary {
  cycleId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: ProductionCycleStatus;
  statusReason: string;
  phases: {
    reliability: ReliabilityPhaseResult;
    atsScan: AtsScanPhaseResult;
    builtIn: BuiltInPhaseResult;
    crossSourceDedup: CrossSourceDedupPhaseResult;
    discoveryV2: DiscoveryV2PhaseResult;
  };
  /** Set only if a heartbeat renewal ever failed mid-cycle (lost lease ownership — see
   *  runProductionCycle's heartbeat wiring in orchestrator.ts). Never silently swallowed: a lost
   *  lease means another cycle may now also be running, which callers/operators must know about
   *  even though the phases that already completed are left as-is. */
  leaseWarning?: string;
}

export interface RunProductionCycleOptions {
  /** Optional override for reliability recovery limit (default: 5, max: 25) */
  reliabilityLimit?: number;
  /** Optional override for Discovery V2 candidates limit (default: 5, max: 25) */
  discoveryV2Limit?: number;
  /** Optional role list override for Built In discovery (defaults to DEFAULT_SEARCH_ROLES) */
  builtInRoles?: readonly string[];
  /** Optional per-role candidate limit for Built In (default: 10) */
  builtInLimitPerRole?: number;
  /** Optional maximum total unique Built In candidates to fetch/process (default: 100) */
  builtInMaxTotalUnique?: number;
  /** Optional list of companies to scan in ATS phase (defaults to listScanReadyCompanies()) */
  atsCompanies?: Company[];
  /** Skip specific phases if needed for controlled testing */
  skipPhases?: Array<"reliability" | "atsScan" | "builtIn" | "crossSourceDedup" | "discoveryV2">;
  /** Optional custom recovery runner for testing */
  recoveryRunner?: typeof import("@/lib/ats/reliability/recoveryController").runConnectorRecovery;
  /** Optional custom Built In searcher for testing */
  builtInSearcher?: typeof import("@/lib/externalSignals/providers").searchBuiltInAcrossRoles;
  /** Optional custom Discovery V2 discoverer for testing */
  discoverer?: typeof import("@/lib/ats/discoveryV2").discoverCompanySourceV2;
  /** Testing-only override for the lease heartbeat interval (defaults to
   *  PRODUCTION_LOCK_HEARTBEAT_INTERVAL_MS) — lets tests observe heartbeat/lease-loss behavior in
   *  milliseconds instead of waiting out the real 30s interval. */
  heartbeatIntervalMs?: number;
}

export interface MorningReadinessSummary {
  productionCycle: {
    lastRunAt: string | null;
    durationMs: number | null;
    status: ProductionCycleStatus | null;
    statusReason: string | null;
    /** True when a cycle currently holds the lease (heartbeating, not merely stale-but-unclaimed). */
    isRunning: boolean;
    /** Original acquisition time of the currently-running cycle's lease, or null when not running —
     *  distinct from the lease's heartbeat-refreshed internal timestamp, so this never drifts. */
    runningSinceAt: string | null;
    /** Scan-ready companies that have never been scanned even once (companies.last_scanned_at IS
     *  NULL) — the rotation's own highest-priority tier (see listScanReadyCompaniesForRotation).
     *  Purely informational: never gates anything. */
    scanReadyCompaniesNeverScanned: number;
  };
  ats: {
    scanReadyCompanies: number;
    attempted: number;
    successful: number;
    partial: number;
    failed: number;
    successPercentage: number | null;
  };
  reliability: {
    healthy: number;
    recovering: number;
    needsReview: number;
    down: number;
    unknown: number;
    recoveredThisCycle: number;
    openCircuits: SourceType[];
  };
  jobs: {
    freshActiveUsJobs: number;
    newAtsJobsThisCycle: number;
    newBuiltInJobsThisCycle: number;
    totalNewJobsThisCycle: number;
  };
  builtIn: {
    listingsDiscovered: number;
    resolved: number;
    unresolved: number;
    employersOnboarded: number;
    crossSourceDuplicatesPrevented: number;
  };
  discovery: {
    companiesChecked: number;
    atsCandidatesDiscovered: number;
    pendingProposals: number;
  };
  coverage: {
    companiesWithFreshJobs: number;
    scanReadyWithFreshJobs: number;
    genericCompaniesRemaining: number;
  };
  needsAttention: {
    pendingProposals: number;
    persistentDownConnectors: number;
    failedPhases: string[];
    details: Array<{ type: string; message: string; companyId?: number; companyName?: string }>;
  };
  telemetryGaps: string[];
}
