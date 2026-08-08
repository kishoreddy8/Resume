import { fetchAshbyJobs } from "@/lib/ats/ashby";
import { fetchGreenhouseJobs } from "@/lib/ats/greenhouse";
import { fetchLeverJobs } from "@/lib/ats/lever";
import { fetchWorkdayJobs } from "@/lib/ats/workday";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import type { Company, NormalizedJob } from "@/types";

export async function fetchJobsForCompany(
  company: Company,
  options: FetchWithRetryOptions = {}
): Promise<NormalizedJob[]> {
  switch (company.source_type) {
    case "greenhouse":
      if (!company.ats_board_token) throw new Error("Missing Greenhouse board token");
      return fetchGreenhouseJobs(company.ats_board_token, options);
    case "ashby":
      if (!company.ats_board_token) throw new Error("Missing Ashby board name");
      return fetchAshbyJobs(company.ats_board_token, options);
    case "lever":
      if (!company.ats_board_token) throw new Error("Missing Lever company slug");
      return fetchLeverJobs(company.ats_board_token, options);
    case "workday":
      if (!company.ats_board_token) throw new Error("Missing Workday tenant/host/site token");
      return fetchWorkdayJobs(company.ats_board_token, options);
    case "career_link": {
      if (!company.career_page_url) throw new Error("Missing career page URL");
      const { scrapeCareerPage } = await import("@/lib/ats/genericPlaywright");
      return scrapeCareerPage(company.career_page_url);
    }
    default:
      throw new Error(`Unsupported source_type: ${company.source_type}`);
  }
}
