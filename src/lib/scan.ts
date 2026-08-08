import pLimit from "p-limit";
import { updateCompany, updateCompanyScanStatus } from "@/db/queries/companies";
import { closeStaleJobs, upsertJob } from "@/db/queries/jobs";
import { dedupeKeyForAts, dedupeKeyForCareerLink } from "@/lib/dedupe";
import { combineH1bSignal } from "@/lib/h1b/combineSignal";
import { scanSponsorshipLanguage } from "@/lib/h1b/keywordScan";
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

    for (const job of jobs) {
      const dedupeKey =
        company.source_type === "career_link"
          ? dedupeKeyForCareerLink(company.id, job.title, job.url)
          : dedupeKeyForAts(company.source_type, company.id, job.externalId ?? job.url);
      seenDedupeKeys.push(dedupeKey);

      const { mentioned, polarity, snippet } = scanSponsorshipLanguage(job.descriptionText);
      const h1bCombinedSignal = combineH1bSignal(company.h1b_signal, polarity);
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
        h1bCombinedSignal,
      });
      if (outcome === "inserted") jobsNew++;
      else jobsUpdated++;
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
      detectedAts,
    };
  } catch (err) {
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

  return {
    results,
    jobsNew: results.reduce((sum, r) => sum + r.jobsNew, 0),
    jobsUpdated: results.reduce((sum, r) => sum + r.jobsUpdated, 0),
    jobsClosed: results.reduce((sum, r) => sum + r.jobsClosed, 0),
    jobsArchived: results.reduce((sum, r) => sum + r.jobsArchived, 0),
    errors: results.filter((r) => r.status === "error").length,
  };
}
