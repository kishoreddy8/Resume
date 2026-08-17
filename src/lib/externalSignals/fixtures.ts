import type { RawBuiltInResult, RawGoogleJobsResult, RawIndeedResult } from "./normalize";

/**
 * Deterministic, synthetic fixtures — NOT copied from any real provider response. Field shapes match
 * what was verified against the real Apify actors during Stage 7's Phase 4 investigation
 * (borderline/indeed-scraper and johnvc/google-jobs-scraper---pay-per-result), but every value here is
 * invented for testing. Used whenever APIFY_API_TOKEN is unset, so the test suite and shadow-mode
 * default never depend on live provider availability.
 */

export const FIXTURE_INDEED_RESULTS: RawIndeedResult[] = [
  {
    jobKey: "fixture-indeed-001",
    title: "Senior Data Engineer",
    companyName: "Acme Robotics, Inc.",
    companyUrl: "https://www.indeed.com/cmp/Acme-Robotics",
    jobUrl: "https://www.indeed.com/viewjob?jk=fixture-indeed-001",
    applyUrl: "https://boards.greenhouse.io/acmerobotics/jobs/9988776",
    datePublished: "2026-08-10",
    jobType: ["Full-time"],
    isRemote: false,
    descriptionText: "Build and own our core data pipeline. 5+ years experience with Spark and Airflow.",
    location: { formattedAddressShort: "Austin, TX", countryCode: "US" },
    salary: { salaryText: "$140,000 - $180,000 a year" },
  },
  {
    jobKey: "fixture-indeed-002",
    title: "Data Engineer",
    companyName: "Confidential Client via BrightStar Staffing",
    companyUrl: "https://www.indeed.com/cmp/BrightStar-Staffing",
    jobUrl: "https://www.indeed.com/viewjob?jk=fixture-indeed-002",
    applyUrl: "https://brightstarstaffing.com/apply/12345",
    datePublished: "2026-07-01",
    jobType: ["Contract"],
    isRemote: true,
    descriptionText: "Staffing agency posting on behalf of an undisclosed client.",
    location: { formattedAddressShort: "Remote", countryCode: "US" },
  },
];

/** Field shapes verified against real, live builtin.com responses during Stage 10's read-only
 *  feasibility probe (job-detail JobPosting JSON-LD + the Apply button's own href) — every value
 *  below is still invented for testing, not copied. Used by builtInProvider's own unit tests, which
 *  exercise normalizeBuiltInResult() directly rather than through a live search() call. */
export const FIXTURE_BUILT_IN_RESULTS: RawBuiltInResult[] = [
  {
    identifierValue: "fixture-builtin-001",
    title: "Senior Data Engineer",
    hiringOrganizationName: "Acme Robotics, Inc.",
    datePosted: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    description: "Build and own our core data pipeline. 5+ years experience with Spark and Airflow.",
    addressLocality: "Austin",
    addressRegion: "TX",
    addressCountry: "USA",
    jobLocationType: "ONSITE",
    employmentType: "FULL_TIME",
    baseSalaryText: "$140,000 - $180,000",
    listingUrl: "https://builtin.com/job/senior-data-engineer/fixture-builtin-001",
    applyHref: "https://job-boards.greenhouse.io/acmerobotics/jobs/9988776",
  },
  {
    identifierValue: "fixture-builtin-002",
    title: "Machine Learning Engineer",
    hiringOrganizationName: "Nimbus Analytics LLC",
    datePosted: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    description: "Design ML pipelines for real-time inference across our platform.",
    addressCountry: "USA",
    jobLocationType: "TELECOMMUTE",
    employmentType: "FULL_TIME",
    listingUrl: "https://builtin.com/job/machine-learning-engineer/fixture-builtin-002",
    applyHref: "https://nimbusanalytics.com/careers/apply/ml-engineer",
  },
];

export const FIXTURE_GOOGLE_JOBS_RESULTS: RawGoogleJobsResult[] = [
  {
    job_id: "fixture-google-001",
    title: "Senior Data Engineer",
    company_name: "Acme Robotics, Inc.",
    location: "Austin, TX",
    via: "Acme Robotics Careers",
    description: "Build and own our core data pipeline. 5+ years experience with Spark and Airflow.",
    detected_extensions: { posted_at: "3 days ago", schedule_type: "Full-time" },
    apply_options: [{ title: "Acme Robotics", link: "https://boards.greenhouse.io/acmerobotics/jobs/9988776" }],
    source_link: "https://www.google.com/search?q=fixture-google-001",
  },
  {
    job_id: "fixture-google-002",
    title: "Machine Learning Engineer",
    company_name: "Nimbus Analytics LLC",
    location: "Remote (US)",
    via: "LinkedIn",
    description: "Design ML pipelines for real-time inference.",
    detected_extensions: { posted_at: "1 week ago", schedule_type: "Full-time" },
    apply_options: [{ title: "LinkedIn", link: "https://www.linkedin.com/jobs/view/fixture-002" }],
    source_link: "https://www.google.com/search?q=fixture-google-002",
  },
];
