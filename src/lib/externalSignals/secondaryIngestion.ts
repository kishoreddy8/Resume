import { getDb } from "@/db";
import { getCompany } from "@/db/queries/companies";
import { archiveJob, upsertJob } from "@/db/queries/jobs";
import { markObservationResultingJob } from "@/db/queries/externalHiringObservations";
import { dedupeKeyForAts } from "@/lib/dedupe";
import type { ExternalHiringObservationRow, NormalizedExternalJob } from "./types";

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
      descriptionHtml: null,
      descriptionText: job.description,
      employmentType: job.employmentType,
      workplaceType: null,
      salaryText: job.salaryText,
      postedAt: null, // provider dates are frequently relative text ("2 days ago"), not reliable ISO
      raw: job.raw,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });

  const row = getDb().prepare("SELECT id FROM jobs WHERE dedupe_key = ?").get(dedupeKey) as { id: number } | undefined;
  if (row) markObservationResultingJob(observation.id, row.id);

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
  if (!company || company.source_type === "career_link" || company.source_type === "google_jobs" || company.source_type === "indeed") return [];

  const officialTitles = (
    db
      .prepare("SELECT title FROM jobs WHERE company_id = ? AND source_type = ? AND is_active = 1")
      .all(companyId, company.source_type) as { title: string }[]
  ).map((r) => normalizeTitle(r.title));
  if (officialTitles.length === 0) return [];

  const secondaryJobs = db
    .prepare("SELECT id, title FROM jobs WHERE company_id = ? AND source_type IN ('google_jobs', 'indeed') AND is_active = 1")
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
