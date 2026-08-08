import { getDb } from "@/db";
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
}

export function createCompany(input: CreateCompanyInput): Company {
  const db = getDb();
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
  return getCompany(Number(result.lastInsertRowid))!;
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
  getDb()
    .prepare(
      `UPDATE companies SET
        name = @name,
        is_active = @is_active,
        notes = @notes,
        ats_board_token = @ats_board_token,
        career_page_url = @career_page_url,
        updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({
      id,
      name: merged.name,
      is_active: merged.is_active,
      notes: merged.notes,
      ats_board_token: merged.ats_board_token,
      career_page_url: merged.career_page_url,
    });
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
