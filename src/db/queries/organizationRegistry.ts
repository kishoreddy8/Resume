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
         AND js.provider IN ('greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'adp_wfn', 'adp_rm', 'eightfold', 'cornerstone', 'avature', 'paylocity', 'icims', 'ukg_pro', 'bamboohr', 'oracle_recruiting_cloud', 'workable', 'rippling', 'paycom', 'jazzhr', 'jobvite', 'breezy', 'teamtailor', 'applicantpro', 'pinpoint', 'clearcompany', 'personio', 'applicantstack', 'comeet', 'cats', 'gohire', 'newton', 'silkroad', 'jobdiva', 'taleo')
       ORDER BY c.name COLLATE NOCASE, c.id`
    )
    .all() as Company[];
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
