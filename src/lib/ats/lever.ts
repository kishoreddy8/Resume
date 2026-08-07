import { stripHtml } from "@/lib/stripHtml";
import type { NormalizedJob } from "@/types";

interface LeverJob {
  id: string;
  text: string;
  categories?: { location?: string; team?: string };
  descriptionPlain?: string;
  description?: string;
  hostedUrl: string;
  createdAt?: number;
}

export async function fetchLeverJobs(companySlug: string): Promise<NormalizedJob[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(companySlug)}?mode=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Lever API returned ${res.status} for company "${companySlug}"`);
  }
  const jobs = (await res.json()) as LeverJob[];
  return jobs.map((job) => ({
    externalId: job.id,
    title: job.text,
    location: job.categories?.location ?? null,
    department: job.categories?.team ?? null,
    url: job.hostedUrl,
    descriptionHtml: job.description ?? null,
    descriptionText: job.descriptionPlain ?? stripHtml(job.description),
    postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    raw: job,
  }));
}
