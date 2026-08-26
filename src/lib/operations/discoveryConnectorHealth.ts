import { getDb } from "@/db";
import { getProviderHealthSummary } from "@/db/queries/reliability";
import { DISCOVERY_CONNECTOR_PROVIDERS, SCANNABLE_PROVIDERS } from "@/lib/ats/scannableProviders";
import { PROBE_ELIGIBLE_SOURCE_SQL } from "@/lib/ats/probeEligibility";
import type { ErrorCategory, SourceType } from "@/types";
import type { HealthStatus } from "./healthRules";

/**
 * ADMIN-OPS-3.2 — one truthful projection over JOB DISCOVERY connector evidence.
 *
 * SCOPE, STATED ONCE. This is discovery only: can Career-Ops FETCH jobs from a platform, and is it
 * currently doing so. It says nothing about application automation, which has three adapters against
 * this file's thirty-seven platforms and lives behind its own registry. Nothing here may be read as
 * apply capability, which is why no field in the result is named "supported".
 *
 * TWO KINDS OF EVIDENCE, DELIBERATELY NOT MERGED. They answer different questions and a single
 * status would silently pick one:
 *
 *   PROBE      — connector_health_check_runs. A read-only reachability check against ONE source per
 *                provider on a long cooldown. It proves the connector can still talk to that
 *                platform. It does not prove the sources an operator actually depends on are working.
 *   PRODUCTION — scan_runs, via getProviderHealthSummary. Real scheduled scans across every
 *                configured source. This is what "is discovery working" actually means, and it is
 *                the stronger signal wherever it exists.
 *
 * WHY BOTH ARE EXPOSED. Probe evidence is often the only evidence: a provider with configured
 * sources that have not come up in the scan rotation has no production data at all. Reporting the
 * probe as though it were production health would overstate coverage; discarding it would throw away
 * the only observation available. So each is reported with its own status and its own timestamps,
 * and the caller decides.
 *
 * NAMED "DISCOVERY" DELIBERATELY. `ConnectorHealth` already exists in src/types and means something
 * narrower and different — a per-COMPANY rollup ("healthy"|"degraded"|"down"|"unknown") computed
 * from consecutive_failures — and src/lib/ats/connectorHealthCheck.ts is the probe writer. This
 * module is per-PLATFORM and reuses HealthStatus only; it introduces no second health vocabulary.
 *
 * NO EVIDENCE IS NOT HEALTH. In this checkout connector_health_check_runs is empty and will stay
 * empty — the launchd job that writes it targets a different repository and is exiting EX_CONFIG —
 * so an implementation that treated "no failures recorded" as healthy would render every provider
 * green on a machine where the checker has never once run. Absence maps to NO_DATA, never HEALTHY,
 * and never to a fabricated failure either.
 */

/** Which body of evidence produced a status. */
export type ConnectorEvidenceSource = "PROBE" | "PRODUCTION_SCAN" | "NONE";

export interface ConnectorEvidence {
  status: HealthStatus;
  /** When the underlying observation happened. Null when nothing has been observed. */
  observedAt: string | null;
  /** Most recent observation that succeeded, if any. Never inferred from absence of failure. */
  lastSucceededAt: string | null;
  lastFailedAt: string | null;
  /** Failures counted inside the window. Zero here means "none observed", not "none occurred". */
  failureCount: number;
  /** Existing ErrorCategory vocabulary — no second taxonomy. `invalid_config` stays distinct from a
   *  provider outage, which is the distinction future repair decisions depend on. */
  lastFailureCategory: ErrorCategory | null;
}

export interface DiscoveryConnectorHealth {
  provider: SourceType;
  /** Code exists and the scanner is willing to select this provider's sources. Static; never health. */
  capability: "SCANNABLE" | "CONNECTOR_NOT_SCANNED";
  /**
   * Sources registered for this provider, or null when the registry cannot be read. Zero is only
   * ever reported when a real query returned zero — it is never a stand-in for "unknown".
   */
  configuredSourceCount: number | null;
  /**
   * A source the connector recheck could actually be run against, or null when none qualifies.
   *
   * UI-ADMIN-1 — added because the contract offered an action no caller could invoke. The recheck
   * takes a jobSourceId, but these rows are per-PLATFORM, so a console rendering
   * `availableActions` had a button and no argument for it. Resolved with exactly the conditions
   * the repair itself enforces (active, authoritative, VERIFIED, APPROVED, probeable provider,
   * active company), so a non-null value is one the repair will accept and null is a truthful
   * "there is nothing here to check" rather than a button that would 409.
   */
  actionableSourceId: number | null;
  probe: ConnectorEvidence;
  production: ConnectorEvidence;
  /** Which evidence the caller should lead with. PRODUCTION wins when it exists — it is the stronger claim. */
  primaryEvidence: ConnectorEvidenceSource;
}

const NO_EVIDENCE: ConnectorEvidence = {
  status: "NO_DATA",
  observedAt: null,
  lastSucceededAt: null,
  lastFailedAt: null,
  failureCount: 0,
  lastFailureCategory: null,
};

interface ProbeRow {
  provider: string;
  outcome: string;
  finished_at: string;
  error_category: string | null;
}

/**
 * Latest probe per provider inside the window, plus that provider's last success and last failure.
 *
 * HEALTHY_EMPTY counts as a success on purpose: the checker treats a reachable board with zero
 * openings as healthy, because an employer with nothing posted is not a broken connector. That is
 * only sound because the connector actually executed — a connector that throws (a missing
 * credential, say) never reaches that branch and is recorded as FAILED_*.
 */
function readProbeEvidence(windowHours: number): Map<string, ConnectorEvidence> {
  const rows = getDb()
    .prepare(
      /* ADMIN-OPS-4 — the second condition is not redundant. The window test is a SUBTRACTION, so a
       * row dated in the future yields a negative difference, satisfies "<= windowDays", sorts last,
       * and would become the provider's current reading — a clock skew or bad write could make a
       * broken connector show HEALTHY. OPS-1 already established that future timestamps fail closed
       * (readLiveness treats them as UNUSABLE); this applies the same rule to probe evidence. */
      `SELECT provider, outcome, finished_at, error_category
         FROM connector_health_check_runs
        WHERE julianday('now') - julianday(finished_at) <= @windowDays
          AND julianday(finished_at) <= julianday('now')
        ORDER BY finished_at ASC`
    )
    .all({ windowDays: windowHours / 24 }) as ProbeRow[];

  const byProvider = new Map<string, ConnectorEvidence>();
  for (const row of rows) {
    const healthy = row.outcome === "HEALTHY_JOBS" || row.outcome === "HEALTHY_EMPTY";
    const current = byProvider.get(row.provider) ?? { ...NO_EVIDENCE };
    byProvider.set(row.provider, {
      status: healthy ? "HEALTHY" : "ERROR",
      observedAt: row.finished_at,
      lastSucceededAt: healthy ? row.finished_at : current.lastSucceededAt,
      lastFailedAt: healthy ? current.lastFailedAt : row.finished_at,
      failureCount: current.failureCount + (healthy ? 0 : 1),
      lastFailureCategory: healthy
        ? current.lastFailureCategory
        : ((row.error_category as ErrorCategory | null) ?? null),
    });
  }
  return byProvider;
}

/**
 * One recheck-eligible source per provider, in a single grouped query.
 *
 * MIN(id) rather than a per-provider lookup: this must not become the N+1 the overview was
 * deliberately built to avoid. The WHERE clause is copied from the repair's own eligibility so the
 * two cannot drift into offering an action that would then be refused.
 */
function readActionableSourceIds(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `SELECT js.provider, MIN(js.id) AS source_id
         FROM job_sources js
         JOIN companies c ON c.id = js.legacy_company_id
        WHERE ${PROBE_ELIGIBLE_SOURCE_SQL}
        GROUP BY js.provider`
    )
    .all() as { provider: string; source_id: number }[];
  return new Map(rows.map((r) => [r.provider, r.source_id]));
}

/** Registered sources per provider. Reads job_sources, the real source registry. */
function readConfiguredSourceCounts(): Map<string, number> {
  const rows = getDb()
    .prepare(`SELECT provider, COUNT(*) AS n FROM job_sources WHERE is_active = 1 GROUP BY provider`)
    .all() as { provider: string; n: number }[];
  return new Map(rows.map((r) => [r.provider, r.n]));
}

interface ScanStampRow {
  provider: string;
  observed_at: string | null;
  last_succeeded_at: string | null;
  last_failed_at: string | null;
}

/**
 * Production-scan timestamps, which the provider rollup does not carry.
 *
 * ADMIN-OPS-3.2.1 — added because the three timestamp fields were structurally always null on the
 * production side, which is a field claiming more than it delivers: an operator could not tell
 * whether a verdict was two minutes or twenty hours old, and staleness is most of what makes health
 * actionable. One bounded aggregate over the same window, grouped in SQL rather than in JS.
 *
 * Attributed by companies.source_type, matching getProviderHealthSummary exactly so the counts and
 * the timestamps can never describe different populations.
 */
function readScanStamps(windowHours: number): Map<string, ScanStampRow> {
  const rows = getDb()
    .prepare(
      `SELECT c.source_type AS provider,
              MAX(sr.finished_at)                                        AS observed_at,
              MAX(CASE WHEN sr.status = 'success' THEN sr.finished_at END) AS last_succeeded_at,
              MAX(CASE WHEN sr.status = 'failed'  THEN sr.finished_at END) AS last_failed_at
         FROM scan_runs sr
         JOIN companies c ON c.id = sr.company_id
        WHERE sr.started_at >= datetime('now', '-' || ? || ' hours')
          AND c.source_type != 'career_link'
        GROUP BY c.source_type`
    )
    .all(windowHours) as ScanStampRow[];
  return new Map(rows.map((r) => [r.provider, r]));
}

/**
 * Production-scan evidence, derived from the existing provider rollup rather than new counting SQL.
 *
 * `successRate` is deliberately null there on zero attempts, and that nullness is carried through as
 * NO_DATA rather than coerced to a number.
 *
 * A NOTE ON `partial`. scan_runs.status is 'success' | 'partial' | 'failed', and the rollup counts
 * only the first two extremes — a window containing nothing but partial scans yields successRate
 * null and therefore NO_DATA here. That understates rather than overstates (it never turns a real
 * partial into a green), so it is carried as-is instead of introducing a competing count.
 */
function productionEvidence(
  summary: ReturnType<typeof getProviderHealthSummary>[number] | undefined,
  stamps: ScanStampRow | undefined
): ConnectorEvidence {
  if (!summary || summary.successRate === null) return { ...NO_EVIDENCE };

  const failed = summary.recentFailedScans;
  const succeeded = summary.recentSuccessfulScans;
  /* Mirrors classifyScanningHealth's existing shape: no successes alongside failures is an outage;
   * any failure at all is degraded; otherwise healthy. No new thresholds are introduced. */
  const status: HealthStatus = succeeded === 0 && failed > 0 ? "ERROR" : failed > 0 ? "WARNING" : "HEALTHY";

  return {
    status,
    observedAt: stamps?.observed_at ?? null,
    lastSucceededAt: stamps?.last_succeeded_at ?? null,
    lastFailedAt: stamps?.last_failed_at ?? null,
    failureCount: failed,
    lastFailureCategory: summary.dominantFailureCategory,
  };
}

/** Mirrors the rollup's own bounding so no window can exceed what its evidence source will honour. */
function clampHours(value: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

export interface DiscoveryConnectorHealthOptions {
  /** Probe window. Defaults to a week: the checker's own cooldown is 24h, so a shorter window would
   *  report NO_DATA for a provider that was legitimately checked two days ago. */
  probeWindowHours?: number;
  /** Production-scan window, passed straight to getProviderHealthSummary. */
  scanWindowHours?: number;
}

/**
 * One row per platform with a discovery connector, whether or not it has sources or evidence.
 *
 * Providers are listed even with nothing observed, because "we have a connector and have never
 * checked it" is itself operationally useful — and is precisely the state this whole checkout is in.
 */
export function getDiscoveryConnectorHealth(
  options: DiscoveryConnectorHealthOptions = {}
): DiscoveryConnectorHealth[] {
  const probeWindowHours = clampHours(options.probeWindowHours ?? 168, 720);
  /* Clamped to the SAME bounds getProviderHealthSummary applies internally (1..168). Without this an
   * out-of-range caller would get counts from a 168-hour window and timestamps from a wider one —
   * two populations presented as one reading. */
  const scanWindowHours = clampHours(options.scanWindowHours ?? 24, 168);

  const probes = readProbeEvidence(probeWindowHours);
  const sourceCounts = readConfiguredSourceCounts();
  const scanStamps = readScanStamps(scanWindowHours);
  const actionableSources = readActionableSourceIds();
  const scanSummaries = new Map(getProviderHealthSummary(scanWindowHours).map((s) => [s.provider as string, s]));
  const scannable = new Set<string>(SCANNABLE_PROVIDERS);

  return DISCOVERY_CONNECTOR_PROVIDERS.map((provider) => {
    const probe = probes.get(provider) ?? { ...NO_EVIDENCE };
    const production = productionEvidence(scanSummaries.get(provider), scanStamps.get(provider));

    /* Production is the stronger claim and wins when it exists; the probe is the fallback; and with
     * neither there is nothing to lead with. */
    const primaryEvidence: ConnectorEvidenceSource =
      production.status !== "NO_DATA" ? "PRODUCTION_SCAN" : probe.status !== "NO_DATA" ? "PROBE" : "NONE";

    return {
      provider,
      capability: scannable.has(provider) ? "SCANNABLE" : "CONNECTOR_NOT_SCANNED",
      configuredSourceCount: sourceCounts.get(provider) ?? 0,
      actionableSourceId: actionableSources.get(provider) ?? null,
      probe,
      production,
      primaryEvidence,
    };
  });
}
