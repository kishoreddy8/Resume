import { extractSalaryText } from "@/lib/extractSalary";
import { stripHtml } from "@/lib/stripHtml";
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

export async function fetchAshbyJobs(boardName: string): Promise<NormalizedJob[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardName)}?includeCompensation=true`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Ashby API returned ${res.status} for board "${boardName}"`);
  }
  const data = (await res.json()) as AshbyResponse;
  return data.jobs.map((job) => {
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
}
