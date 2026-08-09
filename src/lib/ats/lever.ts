import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface LeverJob {
  id: string;
  text: string;
  categories?: { location?: string; team?: string; commitment?: string };
  workplaceType?: string;
  descriptionPlain?: string;
  description?: string;
  additionalPlain?: string;
  hostedUrl: string;
  createdAt?: number;
}

export interface FetchLeverJobsOptions extends FetchWithRetryOptions {
  /** Testing-only: overrides the https://api.lever.co origin so tests can point a real company
   *  slug at a local HTTP server instead of the real host. Production callers never pass this. */
  hostOverride?: string;
}

export async function fetchLeverJobs(
  companySlug: string,
  options: FetchLeverJobsOptions = {}
): Promise<NormalizedJob[]> {
  const { hostOverride, ...retryOptions } = options;
  const origin = hostOverride ?? "https://api.lever.co";
  const url = `${origin}/v0/postings/${encodeURIComponent(companySlug)}?mode=json`;
  const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, retryOptions);
  const jobs = await parseJsonOrThrow<LeverJob[]>(res, url);
  return jobs.map((job) => {
    const descriptionText = job.descriptionPlain ?? stripHtml(job.description);
    // Lever has no structured salary field; check the main description and the "additional"
    // block (where compensation/benefits info often lives) before giving up.
    const salaryText =
      extractSalaryText(descriptionText) ?? extractSalaryText(job.additionalPlain);
    return {
      externalId: job.id,
      title: job.text,
      location: job.categories?.location ?? null,
      department: job.categories?.team ?? null,
      url: job.hostedUrl,
      descriptionHtml: job.description ?? null,
      descriptionText,
      employmentType: job.categories?.commitment ?? null,
      workplaceType: job.workplaceType ?? null,
      salaryText,
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      raw: job,
    };
  });
}
