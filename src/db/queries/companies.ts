import { getDb } from "@/db";
import { syncLegacyCompanyToOrganizationRegistry } from "@/db/organizationRegistryCore";
import type { DiscoveryResult } from "@/lib/ats/discovery";
import { computeConnectorHealth } from "@/lib/scan/health";
import type { Company, ErrorCategory, H1bCompanyConfidence, H1bMatchTier, SourceType } from "@/types";

export function listCompanies(): Company[] {
  return getDb()
    .prepare("SELECT * FROM companies ORDER BY name COLLATE NOCASE")
    .all() as Company[];
}

export function getCompany(id: number): Company | undefined {
  return getDb()
    .prepare("SELECT * FROM companies WHERE id = ?")
    .get(id) as Company | undefined;
}

/** Exact-name lookup — used by the H1B employer discovery batch runner (src/lib/discovery/batch.ts)
 *  to reuse an existing companies row for an employer rather than creating a duplicate on a
 *  re-run. Case-sensitive on purpose: company names are user/DOL-sourced free text, and a
 *  case-insensitive match risks silently merging two distinctly-cased but genuinely different
 *  legal names — the same "never silently merge on fuzzy similarity" discipline this phase's
 *  identity-resolution design applies everywhere else. */
export function getCompanyByName(name: string): Company | undefined {
  return getDb()
    .prepare("SELECT * FROM companies WHERE name = ?")
    .get(name) as Company | undefined;
}

export function listActiveCompanies(): Company[] {
  return getDb()
    .prepare("SELECT * FROM companies WHERE is_active = 1 ORDER BY name COLLATE NOCASE")
    .all() as Company[];
}

export interface CreateCompanyInput {
  name: string;
  source_type: SourceType;
  ats_board_token?: string | null;
  career_page_url?: string | null;
  notes?: string | null;
  /** Attach source discovery to an already-seeded canonical organization. */
  organization_id?: number;
}

export function createCompany(input: CreateCompanyInput): Company {
  const db = getDb();
  const companyId = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO companies (name, source_type, ats_board_token, career_page_url, notes)
         VALUES (@name, @source_type, @ats_board_token, @career_page_url, @notes)`
      )
      .run({
        name: input.name,
        source_type: input.source_type,
        ats_board_token: input.ats_board_token ?? null,
        career_page_url: input.career_page_url ?? null,
        notes: input.notes ?? null,
      });
    const id = Number(result.lastInsertRowid);
    if (input.organization_id !== undefined) {
      const target = db.prepare("SELECT id FROM organizations WHERE id = ?").get(input.organization_id);
      if (!target) throw new Error(`Cannot attach company to missing organization ${input.organization_id}`);
      db.prepare(
        "INSERT INTO organization_company_links (company_id, organization_id) VALUES (?, ?)"
      ).run(id, input.organization_id);
    }
    syncLegacyCompanyToOrganizationRegistry(db, id);
    return id;
  })();
  return getCompany(companyId)!;
}

export interface UpdateCompanyInput {
  name?: string;
  is_active?: 0 | 1;
  notes?: string | null;
  ats_board_token?: string | null;
  career_page_url?: string | null;
}

export function updateCompany(id: number, input: UpdateCompanyInput): Company | undefined {
  const existing = getCompany(id);
  if (!existing) return undefined;
  const merged = { ...existing, ...input };
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `UPDATE companies SET
        name = @name,
        is_active = @is_active,
        notes = @notes,
        ats_board_token = @ats_board_token,
        career_page_url = @career_page_url,
        updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      id,
      name: merged.name,
      is_active: merged.is_active,
      notes: merged.notes,
      ats_board_token: merged.ats_board_token,
      career_page_url: merged.career_page_url,
    });
    syncLegacyCompanyToOrganizationRegistry(db, id);
  })();
  return getCompany(id);
}

export function deleteCompany(id: number): void {
  getDb().prepare("DELETE FROM companies WHERE id = ?").run(id);
}

export function updateCompanyScanStatus(
  id: number,
  status: "ok" | "error",
  error?: string
): void {
  getDb()
    .prepare(
      `UPDATE companies SET
        last_scanned_at = datetime('now'),
        last_scan_status = @status,
        last_scan_error = @error,
        updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({ id, status, error: error ?? null });
}

// --- Scanner Reliability & Observability (additive; see src/lib/scan.ts) ----------------------
// These run alongside (never replacing) the existing updateCompanyScanStatus call above, so the
// Companies page's existing last_scanned_at/last_scan_status/last_scan_error display is untouched.

/** A clean scan: resets the failure streak and marks the connector healthy. Does not touch
 *  last_error_category/last_error_message — those stay as a historical "most recent error ever"
 *  breadcrumb even once the connector has recovered, which is what a health dashboard wants to
 *  show ("last error: rate_limited, 3 runs ago") rather than erasing the trail on the first success. */
export function recordScanSuccess(id: number): void {
  getDb()
    .prepare(
      `UPDATE companies SET
        last_successful_scan_at = datetime('now'),
        consecutive_failures = 0,
        connector_health = 'healthy',
        updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({ id });
}

/** A partial scan (job list fetched completely; some job description fetches permanently failed)
 *  is neither a clean success nor a failure — consecutive_failures is deliberately left untouched
 *  (see src/lib/scan/status.ts's determineScanStatus doc comment), while connector_health still
 *  reflects the degradation immediately rather than waiting for a run that fully fails. */
export function recordScanPartial(
  id: number,
  input: { errorCategory: ErrorCategory | null; errorMessage: string | null }
): void {
  getDb()
    .prepare(
      `UPDATE companies SET
        connector_health = 'degraded',
        last_error_category = @errorCategory,
        last_error_message = @errorMessage,
        updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({ id, ...input });
}

/** A failed scan: bumps the failure streak and recomputes connector_health from it (see
 *  src/lib/scan/health.ts's computeConnectorHealth) — a single blip reads 'degraded', a sustained
 *  streak reads 'down'. */
export function recordScanFailure(
  id: number,
  input: { errorCategory: ErrorCategory | null; errorMessage: string | null }
): void {
  const db = getDb();
  const existing = db.prepare("SELECT consecutive_failures FROM companies WHERE id = ?").get(id) as
    | { consecutive_failures: number }
    | undefined;
  const consecutiveFailures = (existing?.consecutive_failures ?? 0) + 1;

  db.prepare(
    `UPDATE companies SET
      last_failed_scan_at = datetime('now'),
      consecutive_failures = @consecutiveFailures,
      connector_health = @connectorHealth,
      last_error_category = @errorCategory,
      last_error_message = @errorMessage,
      updated_at = datetime('now')
     WHERE id = @id`
  ).run({
    id,
    consecutiveFailures,
    connectorHealth: computeConnectorHealth(consecutiveFailures),
    ...input,
  });
}

/**
 * Writes the result of an ATS discovery attempt (src/lib/ats/discovery.ts) — see AGENTS.md §13/§14.
 * On VERIFIED, promotes the company to the real ATS connector (source_type/ats_board_token) so the
 * next scan uses it automatically. On GENERIC_SUPPORTED, points career_page_url at the discovered
 * jobs page (a better generic-scraper target than whatever URL the user originally pasted) while
 * staying on source_type='career_link'. UNRESOLVED/NEEDS_ADAPTER/FAILED_TEMPORARY never touch
 * source_type/ats_board_token/career_page_url at all — the company stays exactly as scannable (or
 * not) as it already was; only the diagnostic fields change. Never fabricates an ATS: sourceType/
 * atsBoardToken here always come straight from a DiscoveryResult that actually detected them.
 */
export function recordDiscoveryResult(id: number, result: DiscoveryResult): Company | undefined {
  const db = getDb();
  const existing = getCompany(id);
  if (!existing) return undefined;

  const shouldPromoteToAts = result.status === "VERIFIED" && result.sourceType && result.atsBoardToken;
  const shouldPromoteToGeneric = result.status === "GENERIC_SUPPORTED" && result.discoveredJobsUrl;

  db.transaction(() => {
    db.prepare(
      `UPDATE companies SET
        resolution_status = @resolutionStatus,
        discovered_jobs_url = @discoveredJobsUrl,
        discovery_attempted_at = datetime('now'),
        discovery_reason = @discoveryReason,
        suspected_ats = @suspectedAts,
        source_type = @sourceType,
        ats_board_token = @atsBoardToken,
        career_page_url = @careerPageUrl,
        updated_at = datetime('now')
       WHERE id = @id`
    ).run({
      id,
      resolutionStatus: result.status,
      discoveredJobsUrl: result.discoveredJobsUrl,
      discoveryReason: result.reason,
      suspectedAts: result.suspectedAts,
      sourceType: shouldPromoteToAts ? result.sourceType : shouldPromoteToGeneric ? "career_link" : existing.source_type,
      atsBoardToken: shouldPromoteToAts ? result.atsBoardToken : existing.ats_board_token,
      careerPageUrl: shouldPromoteToGeneric ? result.discoveredJobsUrl : existing.career_page_url,
    });
    syncLegacyCompanyToOrganizationRegistry(db, id);
  })();

  return getCompany(id);
}

/**
 * Writes the result of a DOMAIN-IDENTITY verification (src/lib/companyIdentity/verifyDomain.ts) —
 * a DIFFERENT axis from recordDiscoveryResult above, on purpose. domain_identity_status answers
 * "did we identify the real public company/domain," resolution_status (recordDiscoveryResult)
 * answers "did we find its careers/ATS source" — neither ever gates or overwrites the other. Only
 * called on a terminal outcome (VERIFIED/AMBIGUOUS) reaching this far in the batch runner; a
 * FAILED_TEMPORARY/UNRESOLVED domain result never reaches here because no companies row exists yet
 * to update (see src/lib/discovery/batch.ts — a company row is only created once a domain is
 * VERIFIED).
 */
export function updateCompanyDomainIdentity(
  id: number,
  input: { verifiedDomain: string; domainIdentityStatus: string }
): Company | undefined {
  const db = getDb();
  if (!getCompany(id)) return undefined;
  db.transaction(() => {
    db.prepare(
      `UPDATE companies SET
        verified_domain = @verifiedDomain,
        domain_identity_status = @domainIdentityStatus,
        last_successful_discovery_at = datetime('now'),
        updated_at = datetime('now')
       WHERE id = @id`
    ).run({ id, ...input });
    syncLegacyCompanyToOrganizationRegistry(db, id);
  })();
  return getCompany(id);
}

export interface UpdateCompanyH1bConfidenceInput {
  confidence: H1bCompanyConfidence;
  matchEmployerName: string | null;
  matchNormalized: string | null;
  matchTier: H1bMatchTier | null;
  matchScore: number | null;
  lcaCount: number;
  latestFiscalYear: number | null;
  evidence: string | null;
}

/** Writes the result of matching a company against imported DOL H1B/LCA data — see
 *  src/lib/h1b/fuzzyMatch.ts. h1b_updated_at marks specifically when this H1B recompute happened,
 *  distinct from updated_at (which changes on any company edit). */
export function updateCompanyH1bConfidence(id: number, input: UpdateCompanyH1bConfidenceInput): void {
  getDb()
    .prepare(
      `UPDATE companies SET
        h1b_confidence = @confidence,
        h1b_match_employer_name = @matchEmployerName,
        h1b_match_normalized = @matchNormalized,
        h1b_match_tier = @matchTier,
        h1b_match_score = @matchScore,
        h1b_lca_count = @lcaCount,
        h1b_latest_fiscal_year = @latestFiscalYear,
        h1b_confidence_evidence = @evidence,
        h1b_updated_at = datetime('now'),
        updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({ id, ...input });
}
