import type Database from "better-sqlite3";

interface LegacyCompanyRegistryRow {
  id: number;
  name: string;
  source_type: string;
  ats_board_token: string | null;
  career_page_url: string | null;
  discovered_jobs_url: string | null;
  discovery_attempted_at: string | null;
  resolution_status: string;
  suspected_ats: string | null;
  verified_domain: string | null;
  domain_identity_status: string;
  is_active: number;
}

/** Organization aliases preserve legal suffixes; H1B's suffix-stripping normalizer is deliberately
 * not reused because alias identity needs to distinguish a raw legal entity from its parent/brand. */
export function normalizeOrganizationAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

export function normalizeOrganizationDomain(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return raw.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  }
}

/**
 * Idempotently projects one legacy companies row into the additive registry. Accepts a DB handle so
 * migrations and query-layer transactions can reuse the exact same implementation without a
 * getDb() import cycle. It never merges two companies by name/domain similarity; each unlinked
 * legacy row gets its own organization until a reviewed merge explicitly says otherwise.
 */
export function syncLegacyCompanyToOrganizationRegistry(
  db: Database.Database,
  companyId: number
): number {
  const company = db.prepare(
    `SELECT id, name, source_type, ats_board_token, career_page_url, discovered_jobs_url,
            discovery_attempted_at, resolution_status, suspected_ats, verified_domain,
            domain_identity_status, is_active
     FROM companies WHERE id = ?`
  ).get(companyId) as LegacyCompanyRegistryRow | undefined;
  if (!company) throw new Error(`Cannot sync missing legacy company ${companyId}`);

  let link = db.prepare(
    "SELECT organization_id FROM organization_company_links WHERE company_id = ?"
  ).get(companyId) as { organization_id: number } | undefined;

  if (!link) {
    const inserted = db.prepare(
      "INSERT INTO organizations (canonical_name) VALUES (?) RETURNING id"
    ).get(company.name) as { id: number };
    db.prepare(
      "INSERT INTO organization_company_links (company_id, organization_id) VALUES (?, ?)"
    ).run(companyId, inserted.id);
    link = { organization_id: inserted.id };
  }

  const organizationId = link.organization_id;
  // A one-to-one compatibility organization follows its legacy company name. Once a reviewed merge
  // links multiple legacy companies, no arbitrary sync is allowed to overwrite the chosen canonical
  // name; status becomes active when ANY linked legacy company is active.
  db.prepare(
    `UPDATE organizations SET
       canonical_name = CASE
         WHEN (SELECT COUNT(*) FROM organization_company_links WHERE organization_id = ?) = 1
         THEN ? ELSE canonical_name END,
       status = CASE WHEN EXISTS (
         SELECT 1 FROM organization_company_links l
         JOIN companies c ON c.id = l.company_id
         WHERE l.organization_id = ? AND c.is_active = 1
       ) THEN 'active' ELSE 'inactive' END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(organizationId, company.name, organizationId, organizationId);

  db.prepare(
    `INSERT INTO organization_aliases (
       organization_id, alias, alias_normalized, alias_type, provenance_source, provenance_key,
       evidence, is_primary
     ) VALUES (?, ?, ?, 'legacy_company_name', 'legacy_companies', ?, ?, 1)
     ON CONFLICT(provenance_source, provenance_key) WHERE provenance_key IS NOT NULL DO UPDATE SET
       organization_id = excluded.organization_id,
       alias = excluded.alias,
       alias_normalized = excluded.alias_normalized,
       evidence = excluded.evidence,
       updated_at = datetime('now')`
  ).run(
    organizationId,
    company.name,
    normalizeOrganizationAlias(company.name),
    String(company.id),
    `Backfilled from companies.id=${company.id}`
  );

  if (company.verified_domain) {
    const domain = normalizeOrganizationDomain(company.verified_domain);
    db.prepare(
      `INSERT INTO organization_domains (
         organization_id, domain, identity_status, resolution_method, evidence, is_primary,
         verified_at
       ) VALUES (?, ?, ?, 'legacy_company_verified_domain', ?, 1, datetime('now'))
       ON CONFLICT(organization_id, domain) DO UPDATE SET
         identity_status = excluded.identity_status,
         -- Compatibility sync may refresh legacy-derived evidence, but must never erase a later
         -- reviewed/curated decision (for example, a manually corrected official domain).
         resolution_method = CASE
           WHEN organization_domains.resolution_method IS NULL
             OR organization_domains.resolution_method = 'legacy_company_verified_domain'
           THEN excluded.resolution_method ELSE organization_domains.resolution_method END,
         evidence = CASE
           WHEN organization_domains.resolution_method IS NULL
             OR organization_domains.resolution_method = 'legacy_company_verified_domain'
           THEN excluded.evidence ELSE organization_domains.evidence END,
         is_primary = 1,
         verified_at = CASE
           WHEN excluded.identity_status = 'VERIFIED' THEN COALESCE(organization_domains.verified_at, datetime('now'))
           ELSE organization_domains.verified_at
         END,
         updated_at = datetime('now')`
    ).run(
      organizationId,
      domain,
      company.domain_identity_status,
      `Backfilled from companies.verified_domain for companies.id=${company.id}`
    );
  }

  const sourceUrl = company.discovered_jobs_url ?? company.career_page_url;
  const isAuthoritative = company.source_type !== "career_link" && company.ats_board_token !== null;
  db.prepare(
    `INSERT INTO job_sources (
       organization_id, provider, source_key, source_url, resolution_status, suspected_ats,
       is_authoritative, is_active, legacy_company_id, last_validated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(legacy_company_id) WHERE legacy_company_id IS NOT NULL DO UPDATE SET
       organization_id = excluded.organization_id,
       provider = excluded.provider,
       source_key = excluded.source_key,
       source_url = excluded.source_url,
       resolution_status = excluded.resolution_status,
       suspected_ats = excluded.suspected_ats,
       is_authoritative = excluded.is_authoritative,
       is_active = excluded.is_active,
       review_status = CASE
         WHEN job_sources.provider = excluded.provider
          AND job_sources.source_key IS excluded.source_key
          AND job_sources.source_url IS excluded.source_url
         THEN job_sources.review_status ELSE 'PENDING' END,
       reviewed_at = CASE
         WHEN job_sources.provider = excluded.provider
          AND job_sources.source_key IS excluded.source_key
          AND job_sources.source_url IS excluded.source_url
         THEN job_sources.reviewed_at ELSE NULL END,
       review_evidence = CASE
         WHEN job_sources.provider = excluded.provider
          AND job_sources.source_key IS excluded.source_key
          AND job_sources.source_url IS excluded.source_url
         THEN job_sources.review_evidence ELSE NULL END,
       last_validated_at = excluded.last_validated_at,
       updated_at = datetime('now')`
  ).run(
    organizationId,
    company.source_type,
    company.ats_board_token,
    sourceUrl,
    company.resolution_status,
    company.suspected_ats,
    isAuthoritative ? 1 : 0,
    company.is_active,
    company.id,
    company.resolution_status === "VERIFIED" ? company.discovery_attempted_at : null
  );

  return organizationId;
}

/** Existing-database migration/backfill. Only unlinked legacy rows need projection: every normal
 * company mutation calls syncLegacyCompanyToOrganizationRegistry directly. Avoiding a full
 * 67K-row rewrite on every process startup also prevents long SQLite writer contention between
 * the independent discovery, validation, health, profiler, and web processes. */
export function runOrganizationRegistryBackfill(db: Database.Database): void {
  const ids = db.prepare(
    `SELECT c.id
     FROM companies c
     LEFT JOIN organization_company_links l ON l.company_id = c.id
     WHERE l.company_id IS NULL
     ORDER BY c.id`
  ).all() as { id: number }[];
  if (ids.length === 0) return;
  db.transaction(() => {
    for (const { id } of ids) syncLegacyCompanyToOrganizationRegistry(db, id);
  })();
}

/** Seeds the registry-wide discovery checkpoint from the older H1B-only resolution table. The
 * INSERT-OR-IGNORE boundary means later canonical-organization attempts always remain authoritative. */
export function backfillOrganizationDiscoveryState(db: Database.Database): void {
  db.exec(
    `INSERT OR IGNORE INTO organization_discovery_state (
       organization_id, resolved_company_id, domain_identity_status, domain, resolution_method,
       resolution_confidence, evidence, channels_checked, source_resolution_status,
       discovered_jobs_url, attempted_at, resolved_at, created_at, updated_at
     )
     SELECT er.organization_id, e.resolved_company_id, e.domain_identity_status, e.domain,
            e.resolution_method, e.resolution_confidence, e.evidence, e.channels_checked,
            e.careers_source_resolution_status, e.discovered_jobs_url, e.attempted_at,
            e.resolved_at, e.created_at, e.updated_at
     FROM employer_identity_resolutions e
     JOIN organization_employer_records er
       ON er.source_type = 'dol_lca' AND er.source_record_id = e.h1b_sponsor_id`
  );
}
