import pLimit from "p-limit";
import { recordScanFailure, recordScanPartial, recordScanSuccess, updateCompany, updateCompanyScanStatus } from "@/db/queries/companies";
import { closeStaleJobs, getExistingJobExternalIds, getExistingJobRawListings, getJobByDedupeKey, getJobIdByDedupeKey, runAgeBasedSweep, touchJobSighting, upsertJob } from "@/db/queries/jobs";
import { upsertJobIntel } from "@/db/queries/jobIntel";
import { recordScanRun } from "@/db/queries/scanRuns";
import { getAppSettings } from "@/db/queries/settings";
import { dedupeKeyForAts, dedupeKeyForCareerLink, normalizeJobUrl } from "@/lib/dedupe";
import { deleteGeneratedFiles } from "@/lib/generatedFiles";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { scanSponsorshipLanguage } from "@/lib/h1b/keywordScan";
import { extractJobIntel } from "@/lib/jobIntel/extractJobIntel";
import { fetchJobsForCompany } from "@/lib/normalize";
import { workdayListingFingerprint } from "@/lib/ats/workday";
import { filterJobsToUs } from "@/lib/ats/locationFilter";
import { isRealJobPosting } from "@/lib/ats/jobValidation";
import { isJobFreshForIngestion } from "@/lib/ats/jobFreshness";
import { parseDescriptionSections } from "@/lib/parseSections";
import { categorizeThrownError } from "@/lib/scan/errors";
import { canRunLifecycleActions, determineScanStatus, hasContentChanged } from "@/lib/scan/status";
import type { AppSettings } from "@/lib/settings";
import type { Company, ErrorCategory, NormalizedJob, ScanResult, ScanSummary } from "@/types";

// Not settings-driven: it's specific to the best-effort career_link/Playwright path (a much heavier
// per-unit cost than an ATS API call), not the general "how many companies scan in parallel" knob
// Settings > Scanner > Concurrency controls (that's ATS_CONCURRENCY's replacement — see runScan).
const CAREER_LINK_CONCURRENCY = 2;
const ATS_DETECTED_NOTE_PREFIX = "Detected embedded ATS:";

export interface RunScanOptions {
  /** Verification-only bound. Sample scans never run closure, archive, or age-sweep actions. */
  maxJobsPerCompany?: number;
  /** Restrict persisted ATS jobs to explicit U.S. locations. Bare Remote/ambiguous locations are
   * excluded. Defaults to true for Career-Ops; pass false only for a deliberate global audit. */
  usOnly?: boolean;
  /** Dedicated additive-only workflows can suppress the database-wide calendar age sweep. Source
   * scanning/lifecycle rules remain unchanged. Defaults to true for normal full scans. */
  runAgeSweep?: boolean;
}

async function scanCompany(company: Company, settings: AppSettings, options: RunScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let retryCount = 0;
  let unknownLocationCount = 0;
  const onRetry = () => {
    retryCount++;
  };

  const freshnessMetrics = {
    providerDateFresh: 0,
    firstSeenFallbackFresh: 0,
    staleRejected: 0,
    invalidDateCount: 0,
    futureDateCount: 0,
    unknownDateCount: 0,
    existingJobBypass: 0,
    foreignFiltered: 0,
    pseudoJobFiltered: 0,
  };

  try {
    let jobs: NormalizedJob[];
    let detectedAts: { source: string; token: string } | undefined;

    if (company.source_type === "career_link") {
      const { scrapeCareerPageDetailed } = await import("@/lib/ats/genericPlaywright");
      const result = await scrapeCareerPageDetailed(company.career_page_url!);
      const usOnly = options.usOnly ?? true;
      jobs = filterJobsToUs(
        result.jobs,
        {
          usOnly,
          onLocationFiltered: (scope) => {
            if (scope === "UNKNOWN") unknownLocationCount++;
            else freshnessMetrics.foreignFiltered++;
          },
        },
        options.maxJobsPerCompany
      );
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
      const usOnly = options.usOnly ?? true;
      const existingListingFingerprints =
        usOnly && company.source_type === "workday"
          ? new Map(
              getExistingJobRawListings(company.id).map(({ externalId, listing }) => [
                externalId,
                workdayListingFingerprint(listing as Parameters<typeof workdayListingFingerprint>[0]),
              ])
            )
          : undefined;
      jobs = await fetchJobsForCompany(company, {
        onRetry,
        timeoutMs: settings.scanner.timeoutMs,
        maxAttempts: settings.scanner.maxAttempts,
        baseDelayMs: settings.scanner.baseDelayMs,
        maxDelayMs: settings.scanner.maxDelayMs,
        maxJobs: options.maxJobsPerCompany,
        usOnly,
        existingExternalIds: usOnly ? getExistingJobExternalIds(company.id) : undefined,
        existingListingFingerprints,
        onLocationFiltered: (scope) => {
          if (scope === "UNKNOWN") unknownLocationCount++;
          else freshnessMetrics.foreignFiltered++;
        },
      });
    }

    const seenDedupeKeys: string[] = [];
    // Phase 4 Stage 2 — canonical identity of every job this company's scan newly inserted or
    // materially changed (see hasContentChanged, imported below). A Set guards the documented
    // "same dedupe key changed multiple times within one scan appears once" requirement; in
    // practice a dedupe_key should only ever appear once per company's job list, but a provider
    // returning a duplicate listing must not produce a duplicate affected-job entry.
    const affectedDedupeKeys = new Set<string>();
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
      if (!isRealJobPosting(job)) {
        freshnessMetrics.pseudoJobFiltered++;
        continue;
      }

      const dedupeKey =
        company.source_type === "career_link"
          ? dedupeKeyForCareerLink(company.id, job)
          : dedupeKeyForAts(company.source_type, company.id, job.externalId ?? normalizeJobUrl(job.url));

      // Snapshotted before upsertJob so an "updated" outcome can be split into "content genuinely
      // changed" vs. "re-seen, nothing changed" for scan_runs — read-only, does not affect upsertJob.
      const before = getJobByDedupeKey(dedupeKey);

      // Centralized 20-Day Freshness Gate with Provenance:
      // Evaluates against provider date semantics (POSTED, PUBLISHED, CREATED, UPDATED, FIRST_SEEN).
      // Rescans of existing database jobs are always eligible so their lifecycle is preserved.
      const freshness = isJobFreshForIngestion(
        job,
        before ? { id: before.id } : undefined,
        company.source_type,
        20
      );

      if (before) {
        freshnessMetrics.existingJobBypass++;
      } else if (!freshness.eligible) {
        freshnessMetrics.staleRejected++;
        continue;
      } else if (freshness.provenance.dateType === "FIRST_SEEN") {
        freshnessMetrics.firstSeenFallbackFresh++;
        freshnessMetrics.unknownDateCount++;
      } else if (freshness.provenance.dateType === "UNKNOWN") {
        freshnessMetrics.firstSeenFallbackFresh++;
        freshnessMetrics.invalidDateCount++;
      } else {
        freshnessMetrics.providerDateFresh++;
      }

      seenDedupeKeys.push(dedupeKey);

      // Some Workday boards transiently emit a requisition ID with no title/path. Preserve its
      // lifecycle identity without replacing good stored content with blanks. Marking the scan
      // partial also blocks all closure/archive actions for this source until complete data returns.
      if (job.sightingOnly) {
        descriptionFailures++;
        continue;
      }

      if (job.lifecycleOnly) {
        if (touchJobSighting(dedupeKey)) jobsUnchanged++;
        continue;
      }

      if (!job.descriptionText) descriptionFailures++;

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
      if (outcome === "inserted") {
        jobsNew++;
        affectedDedupeKeys.add(dedupeKey);
      } else if (outcome === "updated") {
        jobsUpdated++;
        if (before && !hasContentChanged(before, job)) jobsUnchanged++;
        else {
          jobsTrulyUpdated++;
          // Phase 4 Stage 2 — "materially changed" means exactly what hasContentChanged already
          // means for the jobsTrulyUpdated/jobsUnchanged split above: reused, not a second
          // comparator. before is always defined here (outcome==="updated" only happens when
          // upsertJob found the same dedupe_key this synchronous call's own pre-fetch already found).
          affectedDedupeKeys.add(dedupeKey);
        }
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

    // ATS Health Semantics V2 — operational status (success/partial, feeding connector_health) now
    // reflects only a MATERIAL connector-level problem: every discovered job's description fetch
    // failed (descriptionFailures === jobs.length, on a non-empty result). A few isolated
    // description gaps out of many successfully-fetched jobs proves the fetch mechanism basically
    // works (source-side content gaps, not a CareerOps ingestion capability problem) — see this
    // file's own real-data audit (CAREEROPS — ATS HEALTH SEMANTICS V2) showing 10 of 11 real
    // description-failure companies had a partial, non-total failure rate and were never actually
    // "operationally broken." unknownLocationCount NEVER contributes here, at any magnitude: those
    // jobs were correctly excluded by the conservative US-only location policy — the connector
    // fetched its inventory fine, the exclusion is a content/classification outcome about the
    // source, not a fetch/connectivity fault. Both descriptionFailures and unknownLocationCount are
    // still recorded on every scan_run below regardless of operational outcome, so
    // src/db/queries/atsCoverage.ts can surface them as separate data-quality warnings.
    const hasCompleteDescriptionFailure = jobs.length > 0 && descriptionFailures === jobs.length;
    const scanStatus = determineScanStatus(hasCompleteDescriptionFailure ? descriptionFailures : 0);

    // SAFETY RULE: a partial scan never closes/archives jobs, same as the pre-existing career_link
    // exclusion below (best-effort scrapes are never authoritative). Only a fully successful ATS
    // scan may act on "this job disappeared" — see canRunLifecycleActions's doc comment.
    // Sample/verification scans (isSampleScan) are suppressed independently, right here via
    // `!isSampleScan &&` — this is unconditional and does not depend on scanStatus at all, so
    // narrowing what feeds scanStatus above can never weaken this safety rule.
    const isSampleScan = options.maxJobsPerCompany !== undefined;
    const { jobsClosed, jobsArchived } = !isSampleScan && canRunLifecycleActions(scanStatus, company.source_type)
      ? closeStaleJobs(company.id, seenDedupeKeys)
      : { jobsClosed: 0, jobsArchived: 0 };

    const finishedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    // Recorded on every scan_run regardless of operational outcome — a full observability note, not
    // gated behind scanStatus === "partial" the way it used to be, so a "success" run with warnings
    // (unknown locations, a few description gaps, or a sample probe) still leaves a readable trail.
    const runNote = [
      isSampleScan
        ? `Verification sample limited to ${options.maxJobsPerCompany} job(s); lifecycle actions disabled`
        : null,
      descriptionFailures > 0
        ? `${descriptionFailures} job description(s) failed to fetch after retries`
        : null,
      unknownLocationCount > 0
        ? `${unknownLocationCount} job location(s) remained UNKNOWN and were not loaded`
        : null,
    ]
      .filter(Boolean)
      .join("; ") || null;

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
      unknownLocationCount,
      isSampleScan,
      retryCount,
      errorCategory: null,
      errorMessage: runNote,
    });
    if (scanStatus === "success") {
      recordScanSuccess(company.id);
    } else {
      recordScanPartial(company.id, { errorCategory: null, errorMessage: runNote });
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
      freshnessMetrics,
      detectedAts,
      affectedJobDedupeKeys: Array.from(affectedDedupeKeys),
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
      freshnessMetrics,
      affectedJobDedupeKeys: [],
    };
  }
}

export async function runScan(companies: Company[], options: RunScanOptions = {}): Promise<ScanSummary> {
  // Read once per runScan call (not per company) — Settings > Scanner governs this whole run
  // uniformly, and avoids a settings-table read per company.
  const settings = getAppSettings();
  const atsLimit = pLimit(settings.scanner.concurrency);
  const careerLinkLimit = pLimit(CAREER_LINK_CONCURRENCY);

  const results = await Promise.all(
    companies.map((company) =>
      company.source_type === "career_link"
        ? careerLinkLimit(() => scanCompany(company, settings, options))
        : atsLimit(() => scanCompany(company, settings, options))
    )
  );

  // Age-based sweep runs once per runScan call, over every job in the database (not just the
  // companies scanned this run, and not gated on any company's fetch having succeeded) — it's a
  // calendar-time check ("how old is this job"), independent of scan results. Deliberately outside
  // the per-company try/catch above: a fetch failure for one company must never block the sweep
  // from running for everyone else's jobs.
  const ageSweep =
    options.maxJobsPerCompany === undefined && options.runAgeSweep !== false
      ? runAgeBasedSweep()
      : { archived: 0, deleted: [] };
  // The query layer (runAgeBasedSweep) only touches the DB — deleting a job's generated-output
  // directory is a filesystem side effect and stays here, same separation as markNotInterested's
  // API route caller. Best-effort: a missing/already-cleaned directory is not an error.
  for (const job of ageSweep.deleted) {
    deleteGeneratedFiles(job.companyName, job.jobId);
  }

  const aggregatedFreshness = results.reduce(
    (acc, r) => {
      if (r.freshnessMetrics) {
        acc.providerDateFresh += r.freshnessMetrics.providerDateFresh;
        acc.firstSeenFallbackFresh += r.freshnessMetrics.firstSeenFallbackFresh;
        acc.staleRejected += r.freshnessMetrics.staleRejected;
        acc.invalidDateCount += r.freshnessMetrics.invalidDateCount;
        acc.futureDateCount += r.freshnessMetrics.futureDateCount;
        acc.unknownDateCount += r.freshnessMetrics.unknownDateCount;
        acc.existingJobBypass += r.freshnessMetrics.existingJobBypass;
        acc.foreignFiltered += r.freshnessMetrics.foreignFiltered;
        acc.pseudoJobFiltered += r.freshnessMetrics.pseudoJobFiltered;
      }
      return acc;
    },
    {
      providerDateFresh: 0,
      firstSeenFallbackFresh: 0,
      staleRejected: 0,
      invalidDateCount: 0,
      futureDateCount: 0,
      unknownDateCount: 0,
      existingJobBypass: 0,
      foreignFiltered: 0,
      pseudoJobFiltered: 0,
    }
  );

  // Phase 4 Stage 2 — union across every company scanned this run, deduplicated. A dedupe_key is
  // company-scoped by construction (embeds companyId — see src/lib/dedupe.ts), so cross-company
  // collisions are structurally impossible; the Set only guards the same within-company edge case
  // scanCompany() itself already guards against.
  const affectedJobDedupeKeys = Array.from(new Set(results.flatMap((r) => r.affectedJobDedupeKeys)));

  return {
    results,
    jobsNew: results.reduce((sum, r) => sum + r.jobsNew, 0),
    jobsUpdated: results.reduce((sum, r) => sum + r.jobsUpdated, 0),
    jobsClosed: results.reduce((sum, r) => sum + r.jobsClosed, 0),
    jobsArchived: results.reduce((sum, r) => sum + r.jobsArchived, 0) + ageSweep.archived,
    jobsSuppressed: results.reduce((sum, r) => sum + r.jobsSuppressed, 0),
    jobsDeletedByAge: ageSweep.deleted.length,
    errors: results.filter((r) => r.status === "error").length,
    freshnessMetrics: aggregatedFreshness,
    affectedJobDedupeKeys,
  };
}
