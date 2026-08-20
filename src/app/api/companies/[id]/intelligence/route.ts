import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { getCompany } from "@/db/queries/companies";
import { requireCandidateAccess } from "@/lib/auth/guard";
import { requireActiveCandidate } from "@/db/queries/candidates";

/**
 * GET — what Career-Ops has actually observed about one company.
 *
 * EVERYTHING HERE IS OBSERVED, NOT KNOWN. Every figure is drawn from postings this installation
 * scanned and actions this user took. None of it is a fact about the company's real hiring: a role
 * Career-Ops never saw is missing from these lists, and its absence says nothing. The field names
 * and the UI both say "observed" for that reason — calling scanned postings "hiring strategy" or
 * "market demand" would turn a sample into a claim.
 *
 * BOUNDED BY AGGREGATION. Counts come from GROUP BY, and the lists are capped. /api/companies
 * already returns 4.8 MB for the full corpus; a detail route that loaded a company's postings to
 * count them in JavaScript would head the same way. Nothing here returns a job row.
 *
 * Read-only, no writes, no new projection on the jobs list, and no change to Stage 32's queries.
 */

const ROLE_LIMIT = 12;
const LOCATION_LIMIT = 8;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: raw } = await ctx.params;
  const companyId = Number(raw);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    return NextResponse.json({ error: "Invalid company id" }, { status: 400 });
  }

  const company = getCompany(companyId);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  /* Candidate scope is optional: company observations are not candidate data. It is required only
   * for the application-history section, which IS candidate data and is guarded accordingly. */
  const candidateParam = req.nextUrl.searchParams.get("candidateId");
  let candidateId: number | null = null;
  if (candidateParam !== null) {
    const parsed = Number(candidateParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
    }
    if (!requireActiveCandidate(parsed)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });
    const denial = requireCandidateAccess(req, parsed);
    if (denial) return denial;
    candidateId = parsed;
  }

  const db = getDb();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS discovered,
              SUM(CASE WHEN is_active = 1 AND is_archived = 0 THEN 1 ELSE 0 END) AS active,
              MIN(first_seen_at) AS firstSeen,
              MAX(first_seen_at) AS lastSeen
         FROM jobs WHERE company_id = ?`
    )
    .get(companyId) as { discovered: number; active: number | null; firstSeen: string | null; lastSeen: string | null };

  const roles = db
    .prepare(
      `SELECT title, COUNT(*) AS n
         FROM jobs WHERE company_id = ?
        GROUP BY title ORDER BY n DESC, title ASC LIMIT ?`
    )
    .all(companyId, ROLE_LIMIT) as { title: string; n: number }[];

  const locations = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(location), ''), 'Not stated') AS location, COUNT(*) AS n
         FROM jobs WHERE company_id = ?
        GROUP BY 1 ORDER BY n DESC LIMIT ?`
    )
    .all(companyId, LOCATION_LIMIT) as { location: string; n: number }[];

  const sources = db
    .prepare(
      `SELECT source_type AS source, COUNT(*) AS n
         FROM jobs WHERE company_id = ? GROUP BY 1 ORDER BY n DESC`
    )
    .all(companyId) as { source: string; n: number }[];

  /* This user's own recorded dealings with the company. Only stages they set — never inferred. */
  let applications: { jobId: number; title: string; stage: string; updatedAt: string | null }[] = [];
  if (candidateId !== null) {
    applications = db
      .prepare(
        `SELECT j.id AS jobId, j.title AS title, s.pipeline_status AS stage, s.pipeline_updated_at AS updatedAt
           FROM candidate_job_state s
           JOIN jobs j ON j.dedupe_key = s.dedupe_key
          WHERE s.candidate_id = ? AND j.company_id = ?
          ORDER BY s.pipeline_updated_at DESC LIMIT 20`
      )
      .all(candidateId, companyId) as typeof applications;
  }

  return NextResponse.json({
    company: {
      id: company.id,
      name: company.name,
      /* The ATS this company is configured against, plus whatever the postings actually came
       * through — configuration and observation can differ, so both are reported. */
      configuredSource: company.source_type ?? null,
      careerPageUrl: company.career_page_url ?? null,
      lastScannedAt: company.last_scanned_at ?? null,
      lastScanStatus: company.last_scan_status ?? null,
      /* Existing H1B fields, passed through untouched. This route computes no sponsorship signal
       * of its own — that logic lives in the H1B layer and stays there. */
      h1b: {
        confidence: company.h1b_confidence ?? null,
        lcaCount: company.h1b_lca_count ?? null,
        latestFiscalYear: company.h1b_latest_fiscal_year ?? null,
        matchedEmployerName: company.h1b_match_employer_name ?? null,
        evidence: company.h1b_confidence_evidence ?? null,
      },
    },
    observed: {
      discoveredJobs: totals.discovered ?? 0,
      activeJobs: totals.active ?? 0,
      firstSeenAt: totals.firstSeen,
      lastSeenAt: totals.lastSeen,
      roles,
      rolesTruncated: roles.length === ROLE_LIMIT,
      locations,
      sources,
    },
    applications,
  });
}
