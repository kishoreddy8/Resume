import { fetchAshbyJobs } from "@/lib/ats/ashby";
import { fetchGreenhouseJobs } from "@/lib/ats/greenhouse";
import { fetchLeverJobs } from "@/lib/ats/lever";
import type { Company, NormalizedJob } from "@/types";

export async function fetchJobsForCompany(company: Company): Promise<NormalizedJob[]> {
  switch (company.source_type) {
    case "greenhouse":
      if (!company.ats_board_token) throw new Error("Missing Greenhouse board token");
      return fetchGreenhouseJobs(company.ats_board_token);
    case "ashby":
      if (!company.ats_board_token) throw new Error("Missing Ashby board name");
      return fetchAshbyJobs(company.ats_board_token);
    case "lever":
      if (!company.ats_board_token) throw new Error("Missing Lever company slug");
      return fetchLeverJobs(company.ats_board_token);
    case "career_link": {
      if (!company.career_page_url) throw new Error("Missing career page URL");
      const { scrapeCareerPage } = await import("@/lib/ats/genericPlaywright");
      return scrapeCareerPage(company.career_page_url);
    }
    default:
      throw new Error(`Unsupported source_type: ${company.source_type}`);
  }
}
