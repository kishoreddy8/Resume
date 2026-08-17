import { getDb } from "@/db";
import { getCompany } from "@/db/queries/companies";
import { archiveJob, upsertJob } from "@/db/queries/jobs";
import { markObservationResultingJob } from "@/db/queries/externalHiringObservations";
import { upsertJobIntel } from "@/db/queries/jobIntel";
import { dedupeKeyForAts } from "@/lib/dedupe";
import { parseAtsDate } from "@/lib/ats/jobFreshness";
import { htmlToBlockText, parseDescriptionSections } from "@/lib/parseSections";
import { scanSponsorshipLanguage } from "@/lib/h1b/keywordScan";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { extractJobIntel } from "@/lib/jobIntel/extractJobIntel";
import type { ExternalSignalSource } from "./types";
import type { ExternalHiringObservationRow, NormalizedExternalJob } from "./types";

// External-signals providers (Built In today; google_jobs/indeed if ever enabled) hand back either
// clean plain text or raw HTML in their description field depending on the provider's own payload
// shape — unlike ATS adapters (src/lib/ats/*), which each normalize this themselves before it ever
// reaches this module. A simple tag sniff is enough to tell the two apart without a full HTML parser.
// Exported for reuse by scripts/backfill-job-intelligence.ts, which applies the identical split to
// already-stored rows whose description_text still holds pre-fix raw HTML.
export function looksLikeHtml(text: string): boolean {
  return /<[a-z][\s\S]*>/i.test(text);
}

/** Splits a provider's raw description into (descriptionHtml, descriptionText) the same way every
 *  ATS adapter already does before calling upsertJob — descriptionHtml preserves block/bullet
 *  boundaries (via htmlToBlockText) for downstream parsing (parseDescriptionSections,
 *  extractJobIntel's toLines), descriptionText is the clean human-readable form. Plain-text input
 *  (no HTML) passes through unchanged in both directions it's already needed. */
export function splitDescription(raw: string | null): { descriptionHtml: string | null; descriptionText: string | null } {
  if (!raw) return { descriptionHtml: null, descriptionText: null };
  if (!looksLikeHtml(raw)) return { descriptionHtml: null, descriptionText: raw };
  return { descriptionHtml: raw, descriptionText: htmlToBlockText(raw) };
}

/**
 * Stage 13 Phase 8 — provider/date-confidence-aware posted_at persistence. Built In's own datePosted
 * is a reliable plain YYYY-MM-DD (confirmed live, Stage 11) — safe to persist. Google Jobs' posted
 * date is confirmed relative text ("3 days ago", Stage 7's own fixture/live investigation), and
 * Indeed's reliability was never independently confirmed either — both stay null, completely
 * unchanged, per the explicit "must NOT be broadened" instruction. Deliberately a per-source
 * allowlist (not "parseable => trust it") so a future low-quality source can't silently start writing
 * posted_at just because its dates happen to parse.
 */
const SOURCES_WITH_RELIABLE_POSTED_DATE = new Set<ExternalSignalSource>(["built_in"]);

function reliablePostedAtIso(source: ExternalSignalSource, rawPostedAt: string | null): string | null {
  if (!SOURCES_WITH_RELIABLE_POSTED_DATE.has(source) || !rawPostedAt) return null;
  const parsed = parseAtsDate(rawPostedAt);
  return parsed ? parsed.toISOString() : null;
}

/**
 * Phase 9 — the ONLY function in this module that ever writes to `jobs`. Reuses upsertJob's exact
 * existing logic (dedup by dedupe_key, suppression check via isSuppressionActive, existing-row
 * update path) — no bespoke INSERT/UPDATE here. dedupe_key uses the observation's own fingerprint as
 * the externalId component of dedupeKeyForAts (never null, unlike provider_job_id, which some
 * listings omit), so this secondary job's identity is permanent and namespaced to
 * (source, companyId) — it can never collide with an official ATS's own dedupe_key, which always
 * uses a real official source_type as the prefix.
 *
 * "Official upgrade" (Phase 9's lifecycle) is NOT a same-row merge — see retireSupersededSecondaryJobs
 * below for why that's the safer, explicit alternative this module implements instead.
 */
export interface StageSecondaryJobResult {
  outcome: "inserted" | "updated" | "suppressed";
  jobId: number | null;
  dedupeKey: string;
}

export function stageSecondaryJob(
  observation: ExternalHiringObservationRow,
  job: NormalizedExternalJob,
  companyId: number
): StageSecondaryJobResult {
  const dedupeKey = dedupeKeyForAts(observation.source, companyId, observation.fingerprint);
  const { descriptionHtml, descriptionText } = splitDescription(job.description);
  const sections = parseDescriptionSections(descriptionHtml);
  const { mentioned, polarity, snippet } = scanSponsorshipLanguage(descriptionText);
  const company = getCompany(companyId);
  const { confidence: h1bCombinedConfidence } = combineH1bConfidence(company?.h1b_confidence ?? "Unknown", polarity);

  const outcome = upsertJob({
    companyId,
    sourceType: observation.source,
    dedupeKey,
    job: {
      externalId: observation.fingerprint,
      title: job.title,
      location: job.location,
      department: null,
      url: job.listingUrl,
      descriptionHtml,
      descriptionText,
      employmentType: job.employmentType,
      workplaceType: null,
      salaryText: job.salaryText,
      postedAt: reliablePostedAtIso(observation.source, job.postedAt),
      raw: job.raw,
    },
    descriptionSections: sections ? JSON.stringify(sections) : null,
    sponsorshipMentioned: mentioned,
    sponsorshipPolarity: polarity,
    sponsorshipSnippet: snippet,
    h1bCombinedConfidence,
  });

  const row = getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as { id: number } | undefined;
  if (row) markObservationResultingJob(observation.id, row.id);

  // Structured Job Intelligence — same best-effort, non-fatal pattern scan.ts's ATS path already
  // uses: a failure here must never take down secondary-job ingestion, since this is purely
  // additive metadata, not load-bearing for lifecycle/H1B/tailoring. Skipped for "suppressed"
  // outcomes (no job row was written to attach intel to).
  if (outcome !== "suppressed" && row) {
    try {
      const intel = extractJobIntel({
        title: job.title,
        descriptionText,
        descriptionHtml,
        employmentTypeNative: job.employmentType,
        workplaceTypeNative: null,
        locationNative: job.location,
        salaryTextNative: job.salaryText,
        sponsorshipPolarity: polarity,
        sponsorshipSnippet: snippet,
      });
      upsertJobIntel(row.id, intel);
    } catch (err) {
      console.error(`Structured Job Intelligence extraction failed for ${dedupeKey}:`, err);
    }
  }

  return { outcome, jobId: row?.id ?? null, dedupeKey };
}

/**
 * Phase 9's real "upgrade" semantic: a secondary job's dedupe_key permanently uses its own
 * (source, companyId, fingerprint) namespace — it can never literally become the same row as an
 * official ATS job (different provider prefix), so a true single-row merge across namespaces isn't
 * attempted here; that would require either fabricating a shared identity (unsafe/misleading) or
 * rewriting a stable primary key (unsupported by every other lifecycle primitive in this codebase).
 *
 * Instead: once a company has at least one genuine ACTIVE OFFICIAL job (source_type equal to the
 * company's own connected, non-career_link source_type) whose normalized title matches an active
 * secondary job's title, the secondary job is explicitly archived via the existing archiveJob path
 * (which already refuses a protected job) with a clear reason — never deleted, so candidate_job_state/
 * match results/tailoring history on THAT row
 * remain permanently queryable. This preserves "no duplicate ACTIVE listing" and "no history lost"
 * without either row's identity being disturbed. Explicit/manual — never auto-wired into runScan.
 */
export function retireSupersededSecondaryJobs(companyId: number): number[] {
  const db = getDb();
  const company = getCompany(companyId);
  if (!company || company.source_type === "career_link" || company.source_type === "google_jobs" || company.source_type === "indeed" || company.source_type === "built_in") return [];

  const officialTitles = (
    db
      .prepare("SELECT title FROM jobs WHERE company_id = ? AND source_type = ? AND is_active = 1")
      .all(companyId, company.source_type) as { title: string }[]
  ).map((r) => normalizeTitle(r.title));
  if (officialTitles.length === 0) return [];

  const secondaryJobs = db
    .prepare("SELECT id, title FROM jobs WHERE company_id = ? AND source_type IN ('google_jobs', 'indeed', 'built_in') AND is_active = 1")
    .all(companyId) as { id: number; title: string }[];

  const retiredIds: number[] = [];
  for (const job of secondaryJobs) {
    if (officialTitles.includes(normalizeTitle(job.title))) {
      // archiveJob already refuses a protected (Applied/Interviewing/pinned) job — exactly Phase 9's
      // "do not lose candidate state" requirement, enforced by the existing primitive itself.
      const result = archiveJob(job.id, "Superseded by official source");
      if (result.ok) retiredIds.push(job.id);
    }
  }
  return retiredIds;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
