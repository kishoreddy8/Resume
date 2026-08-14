import { fetchAshbyJobs } from "@/lib/ats/ashby";
import { fetchAdpWorkforceNowJobs } from "@/lib/ats/adpWorkforceNow";
import { fetchGreenhouseJobs } from "@/lib/ats/greenhouse";
import { fetchLeverJobs } from "@/lib/ats/lever";
import { fetchSmartRecruitersJobs } from "@/lib/ats/smartrecruiters";
import { fetchPaylocityJobs } from "@/lib/ats/paylocity";
import { fetchIcimsJobs } from "@/lib/ats/icims";
import { fetchUkgProJobs } from "@/lib/ats/ukgPro";
import { fetchBambooHrJobs } from "@/lib/ats/bamboohr";
import { fetchOracleRecruitingCloudJobs } from "@/lib/ats/oracleRecruitingCloud";
import { fetchWorkableJobs } from "@/lib/ats/workable";
import { fetchRipplingJobs } from "@/lib/ats/rippling";
import { fetchPaycomJobs } from "@/lib/ats/paycom";
import { fetchJazzHrJobs } from "@/lib/ats/jazzhr";
import { fetchJobviteJobs } from "@/lib/ats/jobvite";
import { fetchBreezyJobs } from "@/lib/ats/breezy";
import { fetchTeamtailorJobs } from "@/lib/ats/teamtailor";
import { fetchApplicantProJobs } from "@/lib/ats/applicantpro";
import { fetchPinpointJobs } from "@/lib/ats/pinpoint";
import { fetchClearCompanyJobs } from "@/lib/ats/clearcompany";
import { fetchPersonioJobs } from "@/lib/ats/personio";
import { fetchApplicantStackJobs } from "@/lib/ats/applicantstack";
import { fetchComeetJobs } from "@/lib/ats/comeet";
import { fetchCatsJobs } from "@/lib/ats/cats";
import { fetchGoHireJobs } from "@/lib/ats/gohire";
import { fetchNewtonJobs } from "@/lib/ats/newton";
import { fetchSilkRoadJobs } from "@/lib/ats/silkroad";
import { fetchJobDivaJobs } from "@/lib/ats/jobdiva";
import { fetchTaleoJobs } from "@/lib/ats/taleo";
import { fetchPhenomJobs } from "@/lib/ats/phenom";
import { fetchAdpRmJobs } from "@/lib/ats/adpRecruitingManagement";
import { fetchEightfoldJobs } from "@/lib/ats/eightfold";
import { fetchCornerstoneJobs } from "@/lib/ats/cornerstone";
import { fetchAvatureJobs } from "@/lib/ats/avature";
import { fetchWorkdayJobs } from "@/lib/ats/workday";
import type { FetchWithRetryOptions } from "@/lib/scan/retry";
import type { LocationFilterOptions } from "@/lib/ats/locationFilter";
import type { Company, NormalizedJob } from "@/types";

export interface FetchJobsForCompanyOptions extends FetchWithRetryOptions, LocationFilterOptions {
  maxJobs?: number;
}

export async function fetchJobsForCompany(
  company: Company,
  options: FetchJobsForCompanyOptions = {}
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
    case "smartrecruiters":
      if (!company.ats_board_token) throw new Error("Missing SmartRecruiters company identifier");
      return fetchSmartRecruitersJobs(company.ats_board_token, options);
    case "adp_wfn":
      if (!company.ats_board_token) throw new Error("Missing ADP Workforce Now career-center token");
      return fetchAdpWorkforceNowJobs(company.ats_board_token, options);
    case "adp_rm":
      if (!company.ats_board_token) throw new Error("Missing ADP Recruiting Management tenant token");
      return fetchAdpRmJobs(company.ats_board_token, options);
    case "eightfold":
      if (!company.ats_board_token) throw new Error("Missing Eightfold host/domain token");
      return fetchEightfoldJobs(company.ats_board_token, options);
    case "cornerstone":
      if (!company.ats_board_token) throw new Error("Missing Cornerstone host/site/corp token");
      return fetchCornerstoneJobs(company.ats_board_token, options);
    case "avature":
      if (!company.ats_board_token) throw new Error("Missing Avature host/mode/portal token");
      return fetchAvatureJobs(company.ats_board_token, options);
    case "paylocity":
      if (!company.ats_board_token) throw new Error("Missing Paylocity company token");
      return fetchPaylocityJobs(company.ats_board_token, options);
    case "icims":
      if (!company.ats_board_token) throw new Error("Missing iCIMS tenant host");
      return fetchIcimsJobs(company.ats_board_token, options);
    case "ukg_pro":
      if (!company.ats_board_token) throw new Error("Missing UKG Pro Recruiting board token");
      return fetchUkgProJobs(company.ats_board_token, options);
    case "bamboohr":
      if (!company.ats_board_token) throw new Error("Missing BambooHR tenant token");
      return fetchBambooHrJobs(company.ats_board_token, options);
    case "oracle_recruiting_cloud":
      if (!company.ats_board_token) throw new Error("Missing Oracle Recruiting Cloud host/site token");
      return fetchOracleRecruitingCloudJobs(company.ats_board_token, options);
    case "workable":
      if (!company.ats_board_token) throw new Error("Missing Workable account slug");
      return fetchWorkableJobs(company.ats_board_token, options);
    case "rippling":
      if (!company.ats_board_token) throw new Error("Missing Rippling job-board slug");
      return fetchRipplingJobs(company.ats_board_token, options);
    case "paycom":
      if (!company.ats_board_token) throw new Error("Missing Paycom client key");
      return fetchPaycomJobs(company.ats_board_token, options);
    case "jazzhr":
      if (!company.ats_board_token) throw new Error("Missing JazzHR tenant");
      return fetchJazzHrJobs(company.ats_board_token, options);
    case "jobvite":
      if (!company.ats_board_token) throw new Error("Missing Jobvite careers-site tenant");
      return fetchJobviteJobs(company.ats_board_token, options);
    case "breezy":
      if (!company.ats_board_token) throw new Error("Missing Breezy HR tenant");
      return fetchBreezyJobs(company.ats_board_token, options);
    case "teamtailor":
      if (!company.ats_board_token) throw new Error("Missing Teamtailor tenant");
      return fetchTeamtailorJobs(company.ats_board_token, options);
    case "applicantpro":
      if (!company.ats_board_token) throw new Error("Missing ApplicantPro tenant");
      return fetchApplicantProJobs(company.ats_board_token, options);
    case "pinpoint":
      if (!company.ats_board_token) throw new Error("Missing Pinpoint tenant");
      return fetchPinpointJobs(company.ats_board_token, options);
    case "clearcompany":
      if (!company.ats_board_token) throw new Error("Missing ClearCompany tenant");
      return fetchClearCompanyJobs(company.ats_board_token, options);
    case "personio":
      if (!company.ats_board_token) throw new Error("Missing Personio tenant");
      return fetchPersonioJobs(company.ats_board_token, options);
    case "applicantstack":
      if (!company.ats_board_token) throw new Error("Missing ApplicantStack tenant");
      return fetchApplicantStackJobs(company.ats_board_token, options);
    case "comeet":
      if (!company.ats_board_token) throw new Error("Missing Comeet slug/company token");
      return fetchComeetJobs(company.ats_board_token, options);
    case "cats":
      if (!company.ats_board_token) throw new Error("Missing CATS host/portal token");
      return fetchCatsJobs(company.ats_board_token, options);
    case "gohire":
      if (!company.ats_board_token) throw new Error("Missing GoHire client hash");
      return fetchGoHireJobs(company.ats_board_token, options);
    case "newton":
      if (!company.ats_board_token) throw new Error("Missing Newton/Paycor client ID");
      return fetchNewtonJobs(company.ats_board_token, options);
    case "silkroad":
      if (!company.ats_board_token) throw new Error("Missing SilkRoad account/site token");
      return fetchSilkRoadJobs(company.ats_board_token, options);
    case "jobdiva":
      if (!company.ats_board_token) throw new Error("Missing JobDiva host/account/company token");
      return fetchJobDivaJobs(company.ats_board_token, options);
    case "taleo":
      if (!company.ats_board_token) throw new Error("Missing Taleo host/career-section token");
      return fetchTaleoJobs(company.ats_board_token, options);
    case "phenom":
      if (!company.ats_board_token) throw new Error("Missing Phenom host/locale token");
      return fetchPhenomJobs(company.ats_board_token, options);
    case "career_link": {
      if (!company.career_page_url) throw new Error("Missing career page URL");
      const { scrapeCareerPage } = await import("@/lib/ats/genericPlaywright");
      return scrapeCareerPage(company.career_page_url);
    }
    default:
      throw new Error(`Unsupported source_type: ${company.source_type}`);
  }
}
