import { getDb } from "@/db";
import type { DiscoveryResult } from "@/lib/ats/discovery";
import type { DomainIdentityResult } from "@/types";

export interface OrganizationDiscoveryCandidate {
  organizationId: number;
  canonicalName: string;
}

export function nextOrganizationsForDiscovery(limit: number): OrganizationDiscoveryCandidate[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 5000));
  return getDb().prepare(
    `WITH activity AS (
       SELECT er.organization_id,
              MAX(CASE WHEN er.source_type = 'dol_lca' THEN hs.most_recent_fiscal_year END) AS lca_year,
              MAX(CASE WHEN er.source_type = 'dol_lca' THEN hs.total_lca_certified END) AS lca_certified,
              MAX(CASE WHEN er.source_type = 'dol_perm' THEN pe.most_recent_fiscal_year END) AS perm_year,
              MAX(CASE WHEN er.source_type = 'dol_perm' THEN pe.total_certified END) AS perm_certified
       FROM organization_employer_records er
       LEFT JOIN h1b_sponsors hs
         ON er.source_type = 'dol_lca' AND hs.id = er.source_record_id
       LEFT JOIN perm_employers pe
         ON er.source_type = 'dol_perm' AND pe.id = er.source_record_id
       GROUP BY er.organization_id
     )
     SELECT o.id AS organizationId, o.canonical_name AS canonicalName
     FROM organizations o
     LEFT JOIN organization_discovery_state s ON s.organization_id = o.id
     LEFT JOIN activity a ON a.organization_id = o.id
     WHERE o.status <> 'inactive'
       AND (s.organization_id IS NULL OR (
         s.domain_identity_status = 'FAILED_TEMPORARY'
         AND s.attempted_at <= datetime('now', '-1 day')
       ))
     -- Never let cooldown retries consume the small final batch ahead of organizations that have
     -- no durable checkpoint. The continuous worker sizes its batch from the unsearched count, so
     -- retry-first ordering can otherwise starve the last N organizations forever while reporting
     -- "0 saved; N remaining".
     ORDER BY CASE WHEN s.organization_id IS NULL THEN 0 ELSE 1 END,
              COALESCE(a.lca_year, a.perm_year, 0) DESC,
              COALESCE(a.lca_certified, 0) + COALESCE(a.perm_certified, 0) DESC,
              o.id
     LIMIT ?`
  ).all(boundedLimit) as OrganizationDiscoveryCandidate[];
}

export function recordOrganizationDiscoveryState(input: {
  organizationId: number;
  resolvedCompanyId: number | null;
  domain: DomainIdentityResult;
  source: DiscoveryResult | null;
}): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO organization_discovery_state (
         organization_id, resolved_company_id, domain_identity_status, domain, resolution_method,
         resolution_confidence, evidence, channels_checked, source_resolution_status,
         discovered_jobs_url, attempted_at, resolved_at
       ) VALUES (@organizationId, @resolvedCompanyId, @domainStatus, @domain, @method, @confidence,
                 @evidence, @channels, @sourceStatus, @jobsUrl, datetime('now'), @resolvedAt)
       ON CONFLICT(organization_id) DO UPDATE SET
         resolved_company_id = excluded.resolved_company_id,
         domain_identity_status = excluded.domain_identity_status,
         domain = excluded.domain,
         resolution_method = excluded.resolution_method,
         resolution_confidence = excluded.resolution_confidence,
         evidence = excluded.evidence,
         channels_checked = excluded.channels_checked,
         source_resolution_status = excluded.source_resolution_status,
         discovered_jobs_url = excluded.discovered_jobs_url,
         attempted_at = excluded.attempted_at,
         resolved_at = excluded.resolved_at,
         updated_at = datetime('now')`
    ).run({
      organizationId: input.organizationId,
      resolvedCompanyId: input.resolvedCompanyId,
      domainStatus: input.domain.status,
      domain: input.domain.domain,
      method: input.domain.method,
      confidence: input.domain.confidence,
      evidence: JSON.stringify(input.domain.evidence),
      channels: JSON.stringify(input.domain.channelsChecked),
      sourceStatus: input.source?.status ?? null,
      jobsUrl: input.source?.discoveredJobsUrl ?? null,
      resolvedAt: input.domain.status === "FAILED_TEMPORARY" ? null : new Date().toISOString(),
    });

    if (input.domain.status === "VERIFIED" && input.domain.domain) {
      db.prepare(
        `UPDATE organization_domains
         SET resolution_method = ?, resolution_confidence = ?, evidence = ?,
             verified_at = COALESCE(verified_at, datetime('now')), updated_at = datetime('now')
         WHERE organization_id = ? AND domain = ?`
      ).run(
        input.domain.method,
        input.domain.confidence,
        JSON.stringify(input.domain.evidence),
        input.organizationId,
        input.domain.domain
      );
    }
  })();
}

export function organizationDiscoveryCounts(): {
  searched: number;
  pending: number;
} {
  return getDb().prepare(
    `SELECT COUNT(*) AS searched,
            (SELECT COUNT(*) FROM organizations WHERE status <> 'inactive') - COUNT(*) AS pending
     FROM organization_discovery_state`
  ).get() as { searched: number; pending: number };
}
