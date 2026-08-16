import { getDb } from "@/db";
import {
  normalizeOrganizationAlias,
  normalizeOrganizationDomain,
  syncLegacyCompanyToOrganizationRegistry,
} from "@/db/organizationRegistryCore";
import type {
  Company,
  CompanyResolutionStatus,
  DomainIdentityStatus,
  JobSource,
  Organization,
  OrganizationAlias,
  OrganizationDomain,
} from "@/types";

export function listScanReadyCompanies(): Company[] {
  return getDb()
    .prepare(
      `SELECT c.* FROM companies c
       JOIN job_sources js ON js.legacy_company_id = c.id
       WHERE c.is_active = 1 AND js.is_active = 1 AND js.resolution_status = 'VERIFIED'
         AND js.review_status = 'APPROVED'
         AND js.provider IN ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'adp_wfn', 'adp_rm', 'eightfold', 'cornerstone', 'avature', 'paylocity', 'icims', 'ukg_pro', 'bamboohr', 'oracle_recruiting_cloud', 'workable', 'rippling', 'paycom', 'jazzhr', 'jobvite', 'breezy', 'teamtailor', 'applicantpro', 'pinpoint', 'clearcompany', 'personio', 'applicantstack', 'comeet', 'cats', 'gohire', 'newton', 'silkroad', 'jobdiva', 'taleo', 'successfactors')
       ORDER BY c.name COLLATE NOCASE, c.id`
    )
    .all() as Company[];
}

/**
 * Discovery V2, Stage shadow — candidates worth spending a browser render on: UNRESOLVED and/or
 * GENERIC_SUPPORTED companies with zero currently-active jobs (a company already yielding real jobs
 * via generic scraping has less to gain here). Priority order matches the task's stated design:
 * (1) has a career_page_url to seed from at all, (2) fewer active jobs first, (3) UNRESOLVED before
 * GENERIC_SUPPORTED (a total miss is worth more than a partial one), (4) older/never-attempted
 * discovery first. Bounded and deterministic — no full-table scan of the ~2,700 candidate population,
 * just an indexed join + LIMIT.
 */
export function listDiscoveryV2Candidates(
  scope: "unresolved" | "generic" | "both",
  limit = 5
): Company[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 25));
  const statuses = scope === "unresolved" ? ["UNRESOLVED"] : scope === "generic" ? ["GENERIC_SUPPORTED"] : ["UNRESOLVED", "GENERIC_SUPPORTED"];
  const placeholders = statuses.map(() => "?").join(", ");
  return getDb()
    .prepare(
      `SELECT c.* FROM companies c
       LEFT JOIN (
         SELECT company_id, COUNT(*) AS job_count FROM jobs
         WHERE is_active = 1 AND is_archived = 0
         GROUP BY company_id
       ) jc ON jc.company_id = c.id
       WHERE c.is_active = 1
         AND c.resolution_status IN (${placeholders})
         AND COALESCE(jc.job_count, 0) = 0
       ORDER BY
         (CASE WHEN c.career_page_url IS NOT NULL THEN 0 ELSE 1 END),
         COALESCE(jc.job_count, 0),
         (CASE WHEN c.resolution_status = 'UNRESOLVED' THEN 0 ELSE 1 END),
         COALESCE(c.discovery_attempted_at, ''),
         c.id
       LIMIT ?`
    )
    .all(...statuses, boundedLimit) as Company[];
}

export interface RediscoveryEligibleCompany {
  company: Company;
  jobSourceId: number;
  provider: string;
}

/**
 * ATS Source Self-Healing, Stage 1 — deterministic rediscovery eligibility. A company is eligible
 * only when its CURRENT active, approved, authoritative source has failed with strong, specific
 * evidence of stale/broken configuration: at least 2 consecutive failures whose most recent category
 * is exactly 'invalid_config' (see src/lib/scan/errors.ts's categorizeHttpError — a 4xx status or a
 * synchronous "Missing/Invalid ..." validation throw, never a transient category). This deliberately
 * excludes every other failure category (429/rate_limited, provider_5xx, timeout, network — all
 * recoverable by the connector itself now that the 429 retry-budget fix restores its intended
 * behavior) and every ATS Health V2 data-quality warning (UNKNOWN location, partial description
 * failure, sample-verification) — none of those are evidence the SOURCE ITSELF is wrong, only that a
 * request or a few postings had a transient/data-quality issue. A single invalid_config failure is
 * also excluded (consecutive_failures >= 2, not >= 1) — a lone 4xx could be a one-off provider
 * hiccup; only a *sustained* run of them is treated as real evidence of staleness.
 *
 * Deliberately strict, not broad — see this function's own test file for the exact scenarios this
 * excludes.
 *
 * Cooldown: Stage 1+2 has NO persisted cooldown. Every existing timestamp field that could plausibly
 * serve as one (discovery_attempted_at, last_validated_at) already carries a distinct, real meaning
 * elsewhere (original company discovery; connector approval validation) that this read-only,
 * non-mutating service must not overload or corrupt — and Stage 1+2 never writes to companies or
 * job_sources at all, so there is nothing new to read a cooldown from. This is safe only because the
 * manual shadow runner (Stage 2) is human-triggered with a small, explicit --limit, never scheduled —
 * there is no automatic repeat-retry loop for a cooldown to guard against yet. A persisted cooldown
 * (and likely new schema) becomes necessary before any future Stage 3 wires this into automation;
 * that is out of scope here and reported as a known limitation, not silently worked around.
 */
export function listRediscoveryEligibleCompanies(limit = 25): RediscoveryEligibleCompany[] {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
  const rows = getDb()
    .prepare(
      `SELECT c.*, js.id AS job_source_id, js.provider AS job_source_provider
       FROM companies c
       JOIN job_sources js ON js.legacy_company_id = c.id
       WHERE c.is_active = 1 AND js.is_active = 1
         AND js.resolution_status = 'VERIFIED'
         AND js.review_status = 'APPROVED'
         AND js.is_authoritative = 1
         AND c.consecutive_failures >= 2
         AND c.last_error_category = 'invalid_config'
       ORDER BY c.consecutive_failures DESC, c.id ASC
       LIMIT ?`
    )
    .all(boundedLimit) as (Company & { job_source_id: number; job_source_provider: string })[];
  return rows.map((row) => {
    const { job_source_id, job_source_provider, ...companyFields } = row;
    return { company: companyFields as Company, jobSourceId: job_source_id, provider: job_source_provider };
  });
}

/** Generic sources whose latest evidence permits only additive U.S.-job loading. The scanner's
 * existing career_link lifecycle rule guarantees these can never close missing jobs. */
export function listGenericAdditiveReadyCompanies(): Company[] {
  return getDb().prepare(
    `SELECT c.* FROM companies c
     JOIN job_sources js ON js.legacy_company_id = c.id
     JOIN job_source_validation_runs vr ON vr.id = (
       SELECT vr2.id FROM job_source_validation_runs vr2
       WHERE vr2.job_source_id = js.id ORDER BY vr2.id DESC LIMIT 1
     )
     WHERE c.is_active = 1 AND js.is_active = 1
       AND js.provider = 'career_link' AND js.resolution_status = 'GENERIC_SUPPORTED'
       AND js.review_status = 'APPROVED'
       AND vr.outcome = 'READY_ADDITIVE' AND vr.can_ingest = 1 AND vr.can_close_missing = 0
     ORDER BY c.name COLLATE NOCASE, c.id`
  ).all() as Company[];
}

export function getOrganizationIdForEmployerRecord(
  sourceType: "dol_lca" | "dol_perm",
  sourceRecordId: number
): number | undefined {
  const row = getDb()
    .prepare(
      `SELECT organization_id FROM organization_employer_records
       WHERE source_type = ? AND source_record_id = ?`
    )
    .get(sourceType, sourceRecordId) as { organization_id: number } | undefined;
  return row?.organization_id;
}

export function getOrganization(id: number): Organization | undefined {
  return getDb().prepare("SELECT * FROM organizations WHERE id = ?").get(id) as Organization | undefined;
}

export function getOrganizationForCompany(companyId: number): Organization | undefined {
  return getDb().prepare(
    `SELECT o.* FROM organizations o
     JOIN organization_company_links l ON l.organization_id = o.id
     WHERE l.company_id = ?`
  ).get(companyId) as Organization | undefined;
}

export function getCompanyForOrganization(organizationId: number): Company | undefined {
  return getDb().prepare(
    `SELECT c.* FROM companies c
     JOIN organization_company_links l ON l.company_id = c.id
     WHERE l.organization_id = ?
     ORDER BY c.id LIMIT 1`
  ).get(organizationId) as Company | undefined;
}

export function listOrganizations(input: { limit?: number; offset?: number } = {}): Organization[] {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1000));
  const offset = Math.max(0, input.offset ?? 0);
  return getDb().prepare(
    "SELECT * FROM organizations ORDER BY canonical_name COLLATE NOCASE, id LIMIT ? OFFSET ?"
  ).all(limit, offset) as Organization[];
}

export function createOrganization(canonicalName: string): Organization {
  const name = canonicalName.trim();
  if (!name) throw new Error("Organization canonical name is required");
  const row = getDb().prepare(
    "INSERT INTO organizations (canonical_name) VALUES (?) RETURNING *"
  ).get(name) as Organization;
  return row;
}

export function listOrganizationAliases(organizationId: number): OrganizationAlias[] {
  return getDb().prepare(
    "SELECT * FROM organization_aliases WHERE organization_id = ? ORDER BY is_primary DESC, id"
  ).all(organizationId) as OrganizationAlias[];
}

export function addOrganizationAlias(input: {
  organizationId: number;
  alias: string;
  aliasType: string;
  provenanceSource: string;
  provenanceKey?: string | null;
  evidence?: string | null;
  isPrimary?: boolean;
}): OrganizationAlias {
  const alias = input.alias.trim();
  if (!alias) throw new Error("Organization alias is required");
  return getDb().prepare(
    `INSERT INTO organization_aliases (
       organization_id, alias, alias_normalized, alias_type, provenance_source, provenance_key,
       evidence, is_primary
     ) VALUES (@organizationId, @alias, @aliasNormalized, @aliasType, @provenanceSource,
               @provenanceKey, @evidence, @isPrimary)
     RETURNING *`
  ).get({
    ...input,
    alias,
    aliasNormalized: normalizeOrganizationAlias(alias),
    provenanceKey: input.provenanceKey ?? null,
    evidence: input.evidence ?? null,
    isPrimary: input.isPrimary ? 1 : 0,
  }) as OrganizationAlias;
}

export function listOrganizationDomains(organizationId: number): OrganizationDomain[] {
  return getDb().prepare(
    "SELECT * FROM organization_domains WHERE organization_id = ? ORDER BY is_primary DESC, id"
  ).all(organizationId) as OrganizationDomain[];
}

export function addOrganizationDomain(input: {
  organizationId: number;
  domain: string;
  identityStatus: DomainIdentityStatus;
  resolutionMethod?: string | null;
  resolutionConfidence?: string | null;
  evidence?: string | null;
  isPrimary?: boolean;
}): OrganizationDomain {
  const domain = normalizeOrganizationDomain(input.domain);
  if (!domain) throw new Error("Organization domain is required");
  return getDb().prepare(
    `INSERT INTO organization_domains (
       organization_id, domain, identity_status, resolution_method, resolution_confidence,
       evidence, is_primary, verified_at
     ) VALUES (@organizationId, @domain, @identityStatus, @resolutionMethod,
               @resolutionConfidence, @evidence, @isPrimary, @verifiedAt)
     RETURNING *`
  ).get({
    ...input,
    domain,
    resolutionMethod: input.resolutionMethod ?? null,
    resolutionConfidence: input.resolutionConfidence ?? null,
    evidence: input.evidence ?? null,
    isPrimary: input.isPrimary ? 1 : 0,
    verifiedAt: input.identityStatus === "VERIFIED" ? new Date().toISOString() : null,
  }) as OrganizationDomain;
}

export function listJobSources(organizationId: number): JobSource[] {
  return getDb().prepare(
    "SELECT * FROM job_sources WHERE organization_id = ? ORDER BY is_active DESC, id"
  ).all(organizationId) as JobSource[];
}

export function addJobSource(input: {
  organizationId: number;
  provider: string;
  sourceKey?: string | null;
  sourceUrl?: string | null;
  resolutionStatus?: CompanyResolutionStatus;
  suspectedAts?: string | null;
  isAuthoritative?: boolean;
  isActive?: boolean;
  reviewStatus?: "PENDING" | "APPROVED" | "REJECTED";
  reviewEvidence?: string | null;
}): JobSource {
  if (!input.provider.trim()) throw new Error("Job source provider is required");
  return getDb().prepare(
    `INSERT INTO job_sources (
       organization_id, provider, source_key, source_url, resolution_status, suspected_ats,
       is_authoritative, is_active, review_status, reviewed_at, review_evidence
     ) VALUES (@organizationId, @provider, @sourceKey, @sourceUrl, @resolutionStatus,
               @suspectedAts, @isAuthoritative, @isActive, @reviewStatus, @reviewedAt,
               @reviewEvidence)
     RETURNING *`
  ).get({
    ...input,
    provider: input.provider.trim(),
    sourceKey: input.sourceKey ?? null,
    sourceUrl: input.sourceUrl ?? null,
    resolutionStatus: input.resolutionStatus ?? "UNRESOLVED",
    suspectedAts: input.suspectedAts ?? null,
    isAuthoritative: input.isAuthoritative ? 1 : 0,
    isActive: input.isActive === false ? 0 : 1,
    reviewStatus: input.reviewStatus ?? "PENDING",
    reviewedAt: input.reviewStatus === "APPROVED" || input.reviewStatus === "REJECTED"
      ? new Date().toISOString()
      : null,
    reviewEvidence: input.reviewEvidence ?? null,
  }) as JobSource;
}

export function reviewJobSource(
  jobSourceId: number,
  status: "APPROVED" | "REJECTED",
  evidence: string
): JobSource {
  const row = getDb().prepare(
    `UPDATE job_sources
     SET review_status = ?, reviewed_at = datetime('now'), review_evidence = ?,
         last_validated_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ? RETURNING *`
  ).get(status, evidence.trim(), jobSourceId) as JobSource | undefined;
  if (!row) throw new Error(`Job source ${jobSourceId} does not exist`);
  return row;
}

/** Records a bounded validation attempt that did not justify approval or rejection. Keeping the
 * source PENDING is intentional for empty boards, no currently-visible U.S. roles, rate limits,
 * and transient provider failures; last_validated_at makes retry ordering resumable. */
export function recordPendingJobSourceValidation(jobSourceId: number, evidence: string): JobSource {
  const row = getDb().prepare(
    `UPDATE job_sources
     SET review_status = 'PENDING', reviewed_at = NULL, review_evidence = ?,
         last_validated_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? RETURNING *`
  ).get(evidence.trim(), jobSourceId) as JobSource | undefined;
  if (!row) throw new Error(`Job source ${jobSourceId} does not exist`);
  return row;
}

/** Public query-layer entry point for an explicit compatibility resync. Normal live company writes
 * already call the core helper transactionally; this supports migrations/repair tooling. */
export function syncOrganizationRegistryForCompany(companyId: number): Organization {
  const db = getDb();
  const organizationId = db.transaction(() => syncLegacyCompanyToOrganizationRegistry(db, companyId))();
  return getOrganization(organizationId)!;
}
