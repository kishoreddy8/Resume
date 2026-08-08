import pLimit from "p-limit";
import { updateCompany, updateCompanyScanStatus } from "@/db/queries/companies";
import { closeStaleJobs, getJobIdByDedupeKey, runAgeBasedSweep, upsertJob } from "@/db/queries/jobs";
import { upsertJobIntel } from "@/db/queries/jobIntel";
import { dedupeKeyForAts, dedupeKeyForCareerLink } from "@/lib/dedupe";
import { deleteGeneratedFiles } from "@/lib/generatedFiles";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { scanSponsorshipLanguage } from "@/lib/h1b/keywordScan";
import { extractJobIntel } from "@/lib/jobIntel/extractJobIntel";
import { fetchJobsForCompany } from "@/lib/normalize";
import { parseDescriptionSections } from "@/lib/parseSections";
import type { Company, NormalizedJob, ScanResult, ScanSummary } from "@/types";

const ATS_CONCURRENCY = 6;
const CAREER_LINK_CONCURRENCY = 2;
const ATS_DETECTED_NOTE_PREFIX = "Detected embedded ATS:";

async function scanCompany(company: Company): Promise<ScanResult> {
  try {
    let jobs: NormalizedJob[];
    let detectedAts: { source: string; token: string } | undefined;

    if (company.source_type === "career_link") {
      const { scrapeCareerPageDetailed } = await import("@/lib/ats/genericPlaywright");
      const result = await scrapeCareerPageDetailed(company.career_page_url!);
      jobs = result.jobs;
      detectedAts = result.detectedAts;

      if (detectedAts) {
        const note = `${ATS_DETECTED_NOTE_PREFIX} ${detectedAts.source}:${detectedAts.token} — consider adding it as a proper ATS company for full descriptions and reliable closing of stale postings.`;
        if (!company.notes?.includes(ATS_DETECTED_NOTE_PREFIX)) {
          updateCompany(company.id, {
            notes: company.notes ? `${company.notes}\n${note}` : note,
          });
        }
      }
    } else {
      jobs = await fetchJobsForCompany(company);
    }

    const seenDedupeKeys: string[] = [];
    let jobsNew = 0;
    let jobsUpdated = 0;
    let jobsSuppressed = 0;

    for (const job of jobs) {
      const dedupeKey =
        company.source_type === "career_link"
          ? dedupeKeyForCareerLink(company.id, job.title, job.url)
          : dedupeKeyForAts(company.source_type, company.id, job.externalId ?? job.url);
      seenDedupeKeys.push(dedupeKey);

      const { mentioned, polarity, snippet } = scanSponsorshipLanguage(job.descriptionText);
      const { confidence: h1bCombinedConfidence } = combineH1bConfidence(company.h1b_confidence, polarity);
      const sections = parseDescriptionSections(job.descriptionHtml);

      const outcome = upsertJob({
        companyId: company.id,
        sourceType: company.source_type,
        dedupeKey,
        job,
        descriptionSections: sections ? JSON.stringify(sections) : null,
        sponsorshipMentioned: mentioned,
        sponsorshipPolarity: polarity,
        sponsorshipSnippet: snippet,
        h1bCombinedConfidence,
      });
      if (outcome === "inserted") jobsNew++;
      else if (outcome === "updated") jobsUpdated++;
      else jobsSuppressed++;

      // Structured Job Intelligence: additive, best-effort, and deliberately non-fatal to the scan
      // itself — reuses the sponsorship polarity/snippet already computed above rather than
      // recomputing scanSponsorshipLanguage a second time. Skipped for "suppressed" outcomes (no
      // job row was written to attach intel to). A failure here must never take down the rest of
      // the scan, since it's purely additive metadata, not load-bearing for lifecycle/H1B/tailoring.
      if (outcome !== "suppressed") {
        try {
          const jobId = getJobIdByDedupeKey(dedupeKey);
          if (jobId) {
            const intel = extractJobIntel({
              title: job.title,
              descriptionText: job.descriptionText,
              descriptionHtml: job.descriptionHtml,
              employmentTypeNative: job.employmentType,
              workplaceTypeNative: job.workplaceType,
              locationNative: job.location,
              salaryTextNative: job.salaryText,
              sponsorshipPolarity: polarity,
              sponsorshipSnippet: snippet,
            });
            upsertJobIntel(jobId, intel);
          }
        } catch (err) {
          console.error(`Structured Job Intelligence extraction failed for ${dedupeKey}:`, err);
        }
      }
    }

    // Career-link scraping is best-effort/partial by nature — never auto-close/archive those jobs
    // (see closeStaleJobs's own doc comment for the closed->archived lifecycle rules that DO apply
    // to every ATS-sourced company).
    const { jobsClosed, jobsArchived } =
      company.source_type === "career_link"
        ? { jobsClosed: 0, jobsArchived: 0 }
        : closeStaleJobs(company.id, seenDedupeKeys);

    updateCompanyScanStatus(company.id, "ok");
    return {
      companyId: company.id,
      companyName: company.name,
      sourceType: company.source_type,
      status: "ok",
      jobsNew,
      jobsUpdated,
      jobsClosed,
      jobsArchived,
      jobsSuppressed,
      detectedAts,
    };
  } catch (err) {
    // Never treat a failed scan as evidence that jobs closed: closeStaleJobs/upsertJob are only
    // reached above, inside the try block, after jobs were successfully fetched — a thrown fetch
    // (network error, ATS API down, bad Workday token, etc.) skips straight here without touching
    // any job's lifecycle state at all.
    const message = err instanceof Error ? err.message : String(err);
    updateCompanyScanStatus(company.id, "error", message);
    return {
      companyId: company.id,
      companyName: company.name,
      sourceType: company.source_type,
      status: "error",
      error: message,
      jobsNew: 0,
      jobsUpdated: 0,
      jobsClosed: 0,
      jobsArchived: 0,
      jobsSuppressed: 0,
    };
  }
}

export async function runScan(companies: Company[]): Promise<ScanSummary> {
  const atsLimit = pLimit(ATS_CONCURRENCY);
  const careerLinkLimit = pLimit(CAREER_LINK_CONCURRENCY);

  const results = await Promise.all(
    companies.map((company) =>
      company.source_type === "career_link"
        ? careerLinkLimit(() => scanCompany(company))
        : atsLimit(() => scanCompany(company))
    )
  );

  // Age-based sweep runs once per runScan call, over every job in the database (not just the
  // companies scanned this run, and not gated on any company's fetch having succeeded) — it's a
  // calendar-time check ("how old is this job"), independent of scan results. Deliberately outside
  // the per-company try/catch above: a fetch failure for one company must never block the sweep
  // from running for everyone else's jobs.
  const ageSweep = runAgeBasedSweep();
  // The query layer (runAgeBasedSweep) only touches the DB — deleting a job's generated-output
  // directory is a filesystem side effect and stays here, same separation as markNotInterested's
  // API route caller. Best-effort: a missing/already-cleaned directory is not an error.
  for (const job of ageSweep.deleted) {
    deleteGeneratedFiles(job.companyName, job.jobId);
  }

  return {
    results,
    jobsNew: results.reduce((sum, r) => sum + r.jobsNew, 0),
    jobsUpdated: results.reduce((sum, r) => sum + r.jobsUpdated, 0),
    jobsClosed: results.reduce((sum, r) => sum + r.jobsClosed, 0),
    jobsArchived: results.reduce((sum, r) => sum + r.jobsArchived, 0) + ageSweep.archived,
    jobsSuppressed: results.reduce((sum, r) => sum + r.jobsSuppressed, 0),
    jobsDeletedByAge: ageSweep.deleted.length,
    errors: results.filter((r) => r.status === "error").length,
  };
}
