import { extractSalaryText } from "@/lib/extractSalary";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import { fetchWithRetry, parseJsonOrThrow } from "@/lib/scan/retry";
import { decodeHtmlEntities, stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface GreenhouseJob {
  id: number;
  title: string;
  updated_at: string;
  absolute_url: string;
  content?: string;
  location?: { name?: string };
  departments?: { name: string }[];
}

interface GreenhouseResponse {
  jobs: GreenhouseJob[];
}

export interface FetchGreenhouseJobsOptions extends FetchWithRetryOptions {
  /** Testing-only: overrides the https://boards-api.greenhouse.io origin so tests can point a real
   *  board token at a local HTTP server instead of the real host. Production callers never pass this. */
  hostOverride?: string;
}

export async function fetchGreenhouseJobs(
  boardToken: string,
  options: FetchGreenhouseJobsOptions = {}
): Promise<NormalizedJob[]> {
  const { hostOverride, ...retryOptions } = options;
  const origin = hostOverride ?? "https://boards-api.greenhouse.io";
  const url = `${origin}/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
  const res = await fetchWithRetry(url, { headers: { Accept: "application/json" } }, retryOptions);
  const data = await parseJsonOrThrow<GreenhouseResponse>(res, url);
  return data.jobs.map((job) => {
    const descriptionText = stripHtml(job.content);
    return {
      externalId: String(job.id),
      title: job.title,
      location: job.location?.name ?? null,
      department: job.departments?.[0]?.name ?? null,
      url: job.absolute_url,
      // Greenhouse double-encodes entities in `content` (e.g. "&lt;div&gt;"); decode so it's real, renderable HTML.
      descriptionHtml: job.content ? decodeHtmlEntities(job.content) : null,
      descriptionText,
      // Greenhouse doesn't expose employment/workplace type as structured fields.
      employmentType: null,
      workplaceType: null,
      salaryText: extractSalaryText(descriptionText),
      // Greenhouse has no dedicated "posted" timestamp; updated_at is the closest signal.
      postedAt: job.updated_at ?? null,
      raw: job,
    };
  });
}
