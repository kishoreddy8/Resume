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
