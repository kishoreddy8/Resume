import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface AshbyJob {
  id: string;
  title: string;
  department?: string;
  team?: string;
  location?: string;
  publishedAt?: string;
  jobUrl: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
}

interface AshbyResponse {
  jobs: AshbyJob[];
}

export async function fetchAshbyJobs(boardName: string): Promise<NormalizedJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardName)}?includeCompensation=false`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Ashby API returned ${res.status} for board "${boardName}"`);
  }
  const data = (await res.json()) as AshbyResponse;
  return data.jobs.map((job) => ({
    externalId: job.id,
    title: job.title,
    location: job.location ?? null,
    department: job.department ?? job.team ?? null,
    url: job.jobUrl,
    descriptionHtml: job.descriptionHtml ?? null,
    // Ashby doesn't reliably include full descriptions on the list endpoint for every board.
    descriptionText: job.descriptionPlain ?? stripHtml(job.descriptionHtml) ?? "",
    postedAt: job.publishedAt ?? null,
    raw: job,
  }));
}
