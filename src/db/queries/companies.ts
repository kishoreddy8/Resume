import { getDb } from "@/db";
import type { Company, H1bCompanyConfidence, H1bMatchTier, SourceType } from "@/types";

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
