import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import { filterJobsToUs, type LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { NormalizedJob } from "@/types";

interface AshbyCompensation {
  scrapeableCompensationSalarySummary?: string | null;
  compensationTierSummary?: string | null;
}

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  location?: string;
  employmentType?: string;
  workplaceType?: string;
  publishedAt?: string;
  jobUrl: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: AshbyCompensation;
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

export interface FetchAshbyJobsOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
  /** Testing-only: overrides the https://api.ashbyhq.com origin so tests can point a real board
   *  name at a local HTTP server instead of the real host. Production callers never pass this. */
  hostOverride?: string;
}

export async function fetchAshbyJobs(
  boardName: string,
  options: FetchAshbyJobsOptions = {}
): Promise<NormalizedJob[]> {
  const { hostOverride, maxJobs, usOnly, existingExternalIds, onLocationFiltered, ...retryOptions } = options;
  const origin = hostOverride ?? "https://api.ashbyhq.com";
  const url = `${origin}/posting-api/job-board/${encodeURIComponent(boardName)}?includeCompensation=true`;
  const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, retryOptions);
  const data = await parseJsonOrThrow<AshbyResponse>(res, url);
  const normalized = data.jobs.map((job) => {
    // Ashby doesn't reliably include full descriptions on the list endpoint for every board.
    const descriptionText = job.descriptionPlain || stripHtml(job.descriptionHtml) || "";
    const salaryText =
      job.compensation?.scrapeableCompensationSalarySummary ||
      job.compensation?.compensationTierSummary ||
      extractSalaryText(descriptionText);
    return {
      externalId: job.id,
      title: job.title,
      location: job.location ?? null,
      department: job.department ?? job.team ?? null,
      url: job.jobUrl,
      descriptionHtml: job.descriptionHtml ?? null,
      descriptionText,
      employmentType: job.employmentType ?? null,
      workplaceType: job.workplaceType ?? null,
      salaryText: salaryText ?? null,
      postedAt: job.publishedAt ?? null,
      raw: job,
    };
  });
  return filterJobsToUs(normalized, { usOnly, existingExternalIds, onLocationFiltered }, maxJobs);
}
