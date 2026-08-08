import pLimit from "p-limit";
import { recordScanFailure, recordScanPartial, recordScanSuccess, updateCompany, updateCompanyScanStatus } from "@/db/queries/companies";
import { closeStaleJobs, getJobByDedupeKey, getJobIdByDedupeKey, runAgeBasedSweep, upsertJob } from "@/db/queries/jobs";
import { upsertJobIntel } from "@/db/queries/jobIntel";
import { recordScanRun } from "@/db/queries/scanRuns";
import { dedupeKeyForAts, dedupeKeyForCareerLink, normalizeJobUrl } from "@/lib/dedupe";
import { deleteGeneratedFiles } from "@/lib/generatedFiles";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { scanSponsorshipLanguage } from "@/lib/h1b/keywordScan";
import { extractJobIntel } from "@/lib/jobIntel/extractJobIntel";
import { fetchJobsForCompany } from "@/lib/normalize";
import { parseDescriptionSections } from "@/lib/parseSections";
import { categorizeThrownError } from "@/lib/scan/errors";
import { canRunLifecycleActions, determineScanStatus, hasContentChanged } from "@/lib/scan/status";
import type { Company, ErrorCategory, NormalizedJob, ScanResult, ScanSummary } from "@/types";

const ATS_CONCURRENCY = 6;
const CAREER_LINK_CONCURRENCY = 2;
const ATS_DETECTED_NOTE_PREFIX = "Detected embedded ATS:";

async function scanCompany(company: Company): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let retryCount = 0;
  const onRetry = () => {
    retryCount++;
  };

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
      jobs = await fetchJobsForCompany(company, { onRetry });
    }

    const seenDedupeKeys: string[] = [];
    let jobsNew = 0;
    let jobsUpdated = 0;
    let jobsSuppressed = 0;
    // Finer-grained counters for scan_runs only — jobsNew/jobsUpdated/jobsSuppressed above (and the
    // ScanResult returned below) keep their exact pre-existing meaning and values. Every
    // outcome==="updated" case falls into exactly one of jobsTrulyUpdated/jobsUnchanged, so their
    // sum always equals jobsUpdated.
    let jobsTrulyUpdated = 0;
    let jobsUnchanged = 0;
    let descriptionFailures = 0;

    for (const job of jobs) {
      const dedupeKey =
        company.source_type === "career_link"
          ? dedupeKeyForCareerLink(company.id, job)
          : dedupeKeyForAts(company.source_type, company.id, job.externalId ?? normalizeJobUrl(job.url));
      seenDedupeKeys.push(dedupeKey);

      if (!job.descriptionText) descriptionFailures++;

      // Snapshotted before upsertJob so an "updated" outcome can be split into "content genuinely
      // changed" vs. "re-seen, nothing changed" for scan_runs — read-only, does not affect upsertJob.
      const before = getJobByDedupeKey(dedupeKey);

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
      else if (outcome === "updated") {
        jobsUpdated++;
        if (before && !hasContentChanged(before, job)) jobsUnchanged++;
        else jobsTrulyUpdated++;
      } else jobsSuppressed++;

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

    // SAFETY RULE: a partial scan (list complete, but ≥1 job's description permanently failed —
    // see determineScanStatus) never closes/archives jobs, same as the pre-existing career_link
    // exclusion below (best-effort scrapes are never authoritative). Only a fully successful ATS
    // scan may act on "this job disappeared" — see canRunLifecycleActions's doc comment.
    const scanStatus = determineScanStatus(descriptionFailures);
    const { jobsClosed, jobsArchived } = canRunLifecycleActions(scanStatus, company.source_type)
      ? closeStaleJobs(company.id, seenDedupeKeys)
      : { jobsClosed: 0, jobsArchived: 0 };

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    const partialErrorMessage =
      scanStatus === "partial" ? `${descriptionFailures} job description(s) failed to fetch after retries` : null;

    recordScanRun({
      companyId: company.id,
      provider: company.source_type,
      startedAt,
      finishedAt,
      durationMs,
      status: scanStatus,
      jobsDiscovered: jobs.length,
      jobsAdded: jobsNew,
      jobsUpdated: jobsTrulyUpdated,
      jobsUnchanged,
      duplicatesSkipped: jobsSuppressed,
      jobsClosed,
      jobsArchived,
      descriptionFailures,
      retryCount,
      errorCategory: null,
      errorMessage: partialErrorMessage,
    });
    if (scanStatus === "success") {
      recordScanSuccess(company.id);
    } else {
      recordScanPartial(company.id, { errorCategory: null, errorMessage: partialErrorMessage });
    }

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
    const category: ErrorCategory = categorizeThrownError(err);
    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;

    recordScanRun({
      companyId: company.id,
      provider: company.source_type,
      startedAt,
      finishedAt,
      durationMs,
      status: "failed",
      jobsDiscovered: 0,
      jobsAdded: 0,
      jobsUpdated: 0,
      jobsUnchanged: 0,
      duplicatesSkipped: 0,
      jobsClosed: 0,
      jobsArchived: 0,
      descriptionFailures: 0,
      retryCount,
      errorCategory: category,
      errorMessage: message,
    });
    recordScanFailure(company.id, { errorCategory: category, errorMessage: message });

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
