import { getDb } from "@/db";
import { getCompany } from "@/db/queries/companies";
import { upsertJobIntel } from "@/db/queries/jobIntel";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { scanSponsorshipLanguage } from "@/lib/h1b/keywordScan";
import { extractJobIntel } from "@/lib/jobIntel/extractJobIntel";
import { parseDescriptionSections } from "@/lib/parseSections";
import { looksLikeHtml, splitDescription } from "@/lib/externalSignals/secondaryIngestion";

export interface BackfillJobIntelligenceResult {
  candidatesFound: number;
  processed: number;
  succeeded: number;
  failed: number;
  descriptionsNormalized: number;
  errors: Array<{ jobId: number; error: string }>;
}

interface BackfillJobRow {
  id: number;
  company_id: number;
  title: string;
  location: string | null;
  description_html: string | null;
  description_text: string | null;
  employment_type: string | null;
  workplace_type: string | null;
  salary_text: string | null;
}

/**
 * Stage 24A — bounded, idempotent backfill for existing active jobs ingested before structured
 * intelligence extraction ever ran for their source (the entire Built In pipeline, historically —
 * see stageSecondaryJob's Stage 24A fix, which wires extraction into all FUTURE secondary-job
 * ingestion). This function is the same fix applied retroactively to jobs already in the database,
 * so they don't need to be rediscovered to become usable.
 *
 * Per row: re-derives descriptionHtml/descriptionText the same way new ingestion now does
 * (splitDescription) ONLY when the stored description_text still looks like raw HTML (a pre-fix
 * row) — an already-clean row is never re-touched. Recomputes descriptionSections/sponsorship
 * signals from the corrected text, then runs the exact same extractJobIntel()/upsertJobIntel() call
 * scan.ts's ATS path already uses for every real scan.
 *
 * Idempotent and restartable: selects only rows where structured_extraction_version IS NULL, so an
 * already-backfilled job is never reselected on a subsequent run, and upsertJobIntel itself is a
 * full replace (never an append), so re-running never creates duplicate job_skills/certifications
 * rows. One row's failure is caught and recorded, never aborting the batch — matches scan.ts's own
 * "purely additive metadata, never load-bearing" non-fatal pattern.
 */
export function backfillJobIntelligence(limit: number): BackfillJobIntelligenceResult {
  const db = getDb();
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));

  const rows = db
    .prepare(
      `SELECT id, company_id, title, location, description_html, description_text, employment_type, workplace_type, salary_text
       FROM jobs
       WHERE is_active = 1 AND structured_extraction_version IS NULL
       ORDER BY id ASC
       LIMIT ?`
    )
    .all(boundedLimit) as BackfillJobRow[];

  const result: BackfillJobIntelligenceResult = {
    candidatesFound: rows.length,
    processed: 0,
    succeeded: 0,
    failed: 0,
    descriptionsNormalized: 0,
    errors: [],
  };

  const updateDescription = db.prepare(
    `UPDATE jobs SET description_html = ?, description_text = ?, description_sections = ?,
       sponsorship_mentioned = ?, sponsorship_polarity = ?, sponsorship_snippet = ?,
       h1b_combined_confidence = ?, updated_at = datetime('now')
     WHERE id = ?`
  );

  for (const row of rows) {
    result.processed++;
    try {
      const needsSplit = Boolean(!row.description_html && row.description_text && looksLikeHtml(row.description_text));
      const { descriptionHtml, descriptionText } = needsSplit
        ? splitDescription(row.description_text)
        : { descriptionHtml: row.description_html, descriptionText: row.description_text };
      if (needsSplit) result.descriptionsNormalized++;

      const sections = parseDescriptionSections(descriptionHtml);
      const { mentioned, polarity, snippet } = scanSponsorshipLanguage(descriptionText);
      const company = getCompany(row.company_id);
      const { confidence: h1bCombinedConfidence } = combineH1bConfidence(company?.h1b_confidence ?? "Unknown", polarity);

      updateDescription.run(
        descriptionHtml,
        descriptionText,
        sections ? JSON.stringify(sections) : null,
        mentioned ? 1 : 0,
        polarity,
        snippet,
        h1bCombinedConfidence,
        row.id
      );

      const intel = extractJobIntel({
        title: row.title,
        descriptionText,
        descriptionHtml,
        employmentTypeNative: row.employment_type,
        workplaceTypeNative: row.workplace_type,
        locationNative: row.location,
        salaryTextNative: row.salary_text,
        sponsorshipPolarity: polarity,
        sponsorshipSnippet: snippet,
      });
      upsertJobIntel(row.id, intel);
      result.succeeded++;
    } catch (err) {
      result.failed++;
      result.errors.push({ jobId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

// --- Stage 25B: sponsorship-signal refresh --------------------------------------------------------

export interface SponsorshipRefreshRow {
  jobId: number;
  company: string;
  title: string;
  currentPolarity: string;
  recomputedPolarity: string;
  currentConfidence: string;
  recomputedConfidence: string;
  snippet: string | null;
}

export interface SponsorshipRefreshResult {
  scanned: number;
  differing: number;
  updated: number;
  /** "none->negative", "positive->negative", ... — the full transition histogram. */
  transitions: Record<string, number>;
  rows: SponsorshipRefreshRow[];
}

/**
 * Stage 25B — Blocker 3. Recomputes each job's SPONSORSHIP SIGNAL from its already-stored
 * description and rewrites only the rows whose stored value disagrees.
 *
 * WHY THIS IS NEEDED. jobs.sponsorship_polarity is written at SCAN time (src/lib/scan.ts and
 * src/lib/externalSignals/secondaryIngestion.ts) and nowhere else — `npm run extract-job-intel`
 * takes it as an INPUT and never recomputes it. So when Stage 25A taught keywordScan.ts to
 * recognise the negated VERB form ("<Employer> does not sponsor <object>"), the fix applied to all
 * FUTURE ingestion while 42 already-ingested postings kept a stale polarity of 'none' — and one
 * kept a stale 'positive'. Those postings reached the candidate as eligibility UNKNOWN or PASS when
 * the JD explicitly says the employer will not sponsor: the most costly direction this system can
 * be wrong in for a candidate who requires sponsorship.
 *
 * THERE IS NO SECOND CLASSIFIER HERE. Polarity comes from scanSponsorshipLanguage() and the
 * combined confidence from combineH1bConfidence() — the exact two functions the scan path calls,
 * imported at the top of this same module and used identically by backfillJobIntelligence above.
 * This function only decides WHICH rows to recompute and writes the result.
 *
 * Company H1B history keeps its existing meaning: combineH1bConfidence is what folds it in, and it
 * remains propensity evidence about the COMPANY, never proof about one requisition. A JD-level
 * negative still wins outright, which is what makes the affected rows BLOCKED rather than advisory.
 *
 * Defaults to a DRY RUN so the exact rows can be reviewed before anything is written.
 */
export function refreshSponsorshipSignals(
  options: { dryRun?: boolean; limit?: number } = {}
): SponsorshipRefreshResult {
  const dryRun = options.dryRun ?? true;
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT j.id, j.company_id, j.title, j.description_text, j.sponsorship_polarity, j.h1b_combined_confidence,
              c.name AS company_name, c.h1b_confidence AS company_h1b_confidence
         FROM jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.is_active = 1 AND j.is_archived = 0 AND j.description_text IS NOT NULL
        ORDER BY j.id ASC`
    )
    .all() as {
    id: number;
    company_id: number;
    title: string;
    description_text: string;
    sponsorship_polarity: string;
    h1b_combined_confidence: string;
    company_name: string;
    company_h1b_confidence: string;
  }[];

  const update = db.prepare(
    `UPDATE jobs SET sponsorship_mentioned = ?, sponsorship_polarity = ?, sponsorship_snippet = ?,
       h1b_combined_confidence = ?, updated_at = datetime('now')
     WHERE id = ?`
  );

  const result: SponsorshipRefreshResult = { scanned: 0, differing: 0, updated: 0, transitions: {}, rows: [] };
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;

  for (const row of rows) {
    result.scanned++;
    const { mentioned, polarity, snippet } = scanSponsorshipLanguage(row.description_text);
    const { confidence } = combineH1bConfidence(
      (row.company_h1b_confidence ?? "Unknown") as Parameters<typeof combineH1bConfidence>[0],
      polarity
    );
    if (polarity === row.sponsorship_polarity && confidence === row.h1b_combined_confidence) continue;

    result.differing++;
    const key = `${row.sponsorship_polarity}->${polarity}`;
    result.transitions[key] = (result.transitions[key] ?? 0) + 1;
    if (result.rows.length < 200) {
      result.rows.push({
        jobId: row.id,
        company: row.company_name,
        title: row.title,
        currentPolarity: row.sponsorship_polarity,
        recomputedPolarity: polarity,
        currentConfidence: row.h1b_combined_confidence,
        recomputedConfidence: confidence,
        snippet: snippet ? snippet.slice(0, 160) : null,
      });
    }

    if (!dryRun && result.updated < limit) {
      update.run(mentioned ? 1 : 0, polarity, snippet, confidence, row.id);
      result.updated++;
    }
  }

  return result;
}
