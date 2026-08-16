import { getDb } from "@/db";
import { deriveReliabilityState, RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD } from "@/lib/ats/reliability/state";
import type { Company, ErrorCategory, SourceType } from "@/types";

/**
 * Connector Reliability Control Plane V1 — read/query layer. Every query here is additive-read-only
 * over companies/scan_runs/ats_source_proposals; nothing in this file mutates anything (see
 * recoveryController.ts for the one write path — recordRediscoveryAttempt — and
 * atsSourceProposals.ts for the only proposal write path, both pre-existing/reused, not duplicated
 * here).
 */

const REDISCOVERY_ELIGIBLE_CATEGORIES: ErrorCategory[] = ["invalid_config", "blocked"];

export interface RediscoveryEligibleCompany {
  company: Company;
}

/**
 * Phase 4-6 candidate selection: companies whose most recent real scan failed with rediscovery-
 * eligible evidence (invalid_config/blocked — see classification.ts), have NOT exhausted their
 * recovery-attempt budget, have no already-pending proposal (avoids re-discovering a company a human
 * is already reviewing), and are past their cooldown window since the last rediscovery attempt (or
 * have never had one). Small, bounded, deterministic — mirrors listDiscoveryV2Candidates' own
 * shape/limit conventions (src/db/queries/organizationRegistry.ts), never a full-table scan.
 *
 * career_link is excluded — same "best-effort, never authoritative" boundary
 * canRunLifecycleActions/listScanReadyCompanies/getProviderHealthSummary already draw (see
 * src/lib/scan/status.ts and this file's own getProviderHealthSummary below): this Connector
 * Reliability Control Plane is scoped to the 30+ structured ATS connectors, and Discovery V2's
 * existing external-signals-triggered COVERAGE_MISMATCH bridge (discoveryV2Bridge.ts) already
 * covers career_link companies through its own, separate path.
 */
export function listRediscoveryEligibleCompanies(
  limit = 5,
  cooldownHours = 6
): RediscoveryEligibleCompany[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 25));
  const boundedCooldownHours = Math.max(1, Math.min(Math.trunc(cooldownHours), 168));
  const db = getDb();
  const placeholders = REDISCOVERY_ELIGIBLE_CATEGORIES.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT c.* FROM companies c
       WHERE c.is_active = 1
         AND c.source_type != 'career_link'
         AND c.connector_health IN ('degraded', 'down')
         AND c.last_error_category IN (${placeholders})
         AND c.consecutive_failures >= 1
         AND c.consecutive_failures < ?
         AND NOT EXISTS (
           SELECT 1 FROM ats_source_proposals p
           WHERE p.company_id = c.id AND p.status = 'PENDING_REVIEW'
         )
         AND (
           c.last_rediscovery_attempted_at IS NULL
           OR c.last_rediscovery_attempted_at <= datetime('now', '-' || ? || ' hours')
         )
       ORDER BY c.consecutive_failures DESC, COALESCE(c.last_rediscovery_attempted_at, '') ASC, c.id ASC
       LIMIT ?`
    )
    .all(...REDISCOVERY_ELIGIBLE_CATEGORIES, RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD, boundedCooldownHours, boundedLimit) as Company[];
  return rows.map((company) => ({ company }));
}

export interface ProviderHealthSummary {
  provider: SourceType;
  eligibleCompanies: number;
  recentSuccessfulScans: number;
  recentFailedScans: number;
  /** null when there were zero recent scan attempts (nothing to compute a rate from) — never
   *  silently reported as 0% or 100%, which would misrepresent "no data" as "all failing/passing." */
  successRate: number | null;
  dominantFailureCategory: ErrorCategory | null;
  recoveringCount: number;
  needsReviewCount: number;
  downCount: number;
  healthyCount: number;
}

interface ProviderScanRow {
  source_type: SourceType;
  status: string;
  error_category: ErrorCategory | null;
}

/**
 * Phase 7 — per-provider health, built from the SAME scan_runs rows every scan already writes
 * (recordScanRun in src/lib/scan.ts), windowed to the last `windowHours`. Distinguishes a single
 * company's problem from a provider-wide incident: a 100% failure rate across many companies on one
 * provider in a short window is the signature Phase 7/8 ask this function to make visible.
 */
export function getProviderHealthSummary(windowHours = 24): ProviderHealthSummary[] {
  const boundedWindowHours = Math.max(1, Math.min(Math.trunc(windowHours), 168));
  const db = getDb();

  const scanRows = db
    .prepare(
      `SELECT c.source_type, sr.status, sr.error_category
       FROM scan_runs sr
       JOIN companies c ON c.id = sr.company_id
       WHERE sr.started_at >= datetime('now', '-' || ? || ' hours')
         AND c.source_type != 'career_link'`
    )
    .all(boundedWindowHours) as ProviderScanRow[];

  const companyRows = db
    .prepare(
      `SELECT source_type, connector_health, consecutive_failures, last_error_category
       FROM companies
       WHERE is_active = 1 AND source_type != 'career_link'`
    )
    .all() as Pick<Company, "source_type" | "connector_health" | "consecutive_failures" | "last_error_category">[];

  const pendingProposalCompanyIds = new Set(
    (
      db
        .prepare(`SELECT company_id FROM ats_source_proposals WHERE status = 'PENDING_REVIEW'`)
        .all() as { company_id: number }[]
    ).map((r) => r.company_id)
  );
  const companyIdBySourceType = db
    .prepare(`SELECT id, source_type FROM companies WHERE is_active = 1`)
    .all() as { id: number; source_type: SourceType }[];

  const providers = new Set<SourceType>([
    ...scanRows.map((r) => r.source_type),
    ...companyRows.map((r) => r.source_type),
  ]);

  const summaries: ProviderHealthSummary[] = [];
  for (const provider of providers) {
    const providerScans = scanRows.filter((r) => r.source_type === provider);
    const recentSuccessfulScans = providerScans.filter((r) => r.status === "success").length;
    const recentFailedScans = providerScans.filter((r) => r.status === "failed").length;
    const attempted = recentSuccessfulScans + recentFailedScans;
    const successRate = attempted > 0 ? recentSuccessfulScans / attempted : null;

    const failureCategoryCounts = new Map<ErrorCategory, number>();
    for (const row of providerScans) {
      if (row.status === "failed" && row.error_category) {
        failureCategoryCounts.set(row.error_category, (failureCategoryCounts.get(row.error_category) ?? 0) + 1);
      }
    }
    let dominantFailureCategory: ErrorCategory | null = null;
    let dominantCount = 0;
    for (const [category, count] of failureCategoryCounts) {
      if (count > dominantCount) {
        dominantCount = count;
        dominantFailureCategory = category;
      }
    }

    const providerCompanies = companyRows.filter((r) => r.source_type === provider);
    const providerCompanyIds = new Set(
      companyIdBySourceType.filter((c) => c.source_type === provider).map((c) => c.id)
    );
    const needsReviewCount = [...pendingProposalCompanyIds].filter((id) => providerCompanyIds.has(id)).length;
    const healthyCount = providerCompanies.filter((r) => r.connector_health === "healthy").length;
    const downCount = providerCompanies.filter(
      (r) => r.connector_health === "down" || r.consecutive_failures >= RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD
    ).length;
    const recoveringCount = providerCompanies.filter(
      (r) =>
        (r.connector_health === "degraded" || r.connector_health === "down") &&
        r.consecutive_failures < RECOVERY_ATTEMPTS_EXHAUSTED_THRESHOLD
    ).length - needsReviewCount;

    summaries.push({
      provider,
      eligibleCompanies: providerCompanies.length,
      recentSuccessfulScans,
      recentFailedScans,
      successRate,
      dominantFailureCategory,
      recoveringCount: Math.max(0, recoveringCount),
      needsReviewCount,
      downCount,
      healthyCount,
    });
  }

  return summaries.sort((a, b) => a.provider.localeCompare(b.provider));
}

export interface ConnectorReliabilitySummary {
  healthy: number;
  recovering: number;
  needsReview: number;
  down: number;
  unknown: number;
  needsAttention: NeedsAttentionCompany[];
}

export interface NeedsAttentionCompany {
  id: number;
  name: string;
  sourceType: SourceType;
  state: "NEEDS_REVIEW" | "DOWN";
  reason: string;
}

/**
 * Phase 11 — the top-line "Connector Reliability" counts and the "Needs Attention" list for the ATS
 * Health UI. Deliberately imports deriveReliabilityState from the reliability state module (not a
 * second copy of its rules) and only lists companies in NEEDS_REVIEW or DOWN — Phase 11's own
 * instruction not to overwhelm the UI with expected, self-healing RECOVERING/transient entries.
 */
export function getConnectorReliabilitySummary(): ConnectorReliabilitySummary {
  const db = getDb();
  const companies = db
    .prepare(`SELECT * FROM companies WHERE is_active = 1 AND source_type != 'career_link'`)
    .all() as Company[];
  const pendingProposalCompanyIds = new Set(
    (
      db
        .prepare(`SELECT company_id FROM ats_source_proposals WHERE status = 'PENDING_REVIEW'`)
        .all() as { company_id: number }[]
    ).map((r) => r.company_id)
  );

  const summary: ConnectorReliabilitySummary = {
    healthy: 0,
    recovering: 0,
    needsReview: 0,
    down: 0,
    unknown: 0,
    needsAttention: [],
  };

  for (const company of companies) {
    const assessment = deriveReliabilityState({
      company,
      hasPendingProposal: pendingProposalCompanyIds.has(company.id),
    });
    switch (assessment.state) {
      case "HEALTHY":
        summary.healthy++;
        break;
      case "RECOVERING":
        summary.recovering++;
        break;
      case "NEEDS_REVIEW":
        summary.needsReview++;
        summary.needsAttention.push({
          id: company.id,
          name: company.name,
          sourceType: company.source_type,
          state: "NEEDS_REVIEW",
          reason: assessment.reason,
        });
        break;
      case "DOWN":
        summary.down++;
        summary.needsAttention.push({
          id: company.id,
          name: company.name,
          sourceType: company.source_type,
          state: "DOWN",
          reason: assessment.reason,
        });
        break;
      case "UNKNOWN":
        summary.unknown++;
        break;
    }
  }

  return summary;
}
