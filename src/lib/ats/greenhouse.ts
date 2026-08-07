import { extractSalaryText } from "@/lib/extractSalary";
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

export async function fetchGreenhouseJobs(boardToken: string): Promise<NormalizedJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs?content=true`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Greenhouse API returned ${res.status} for board "${boardToken}"`);
  }
  const data = (await res.json()) as GreenhouseResponse;
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
