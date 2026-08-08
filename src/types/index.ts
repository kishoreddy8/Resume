export type SourceType = "greenhouse" | "ashby" | "lever" | "workday" | "career_link";

/**
 * Company-level H1B sponsorship confidence, derived purely from historical DOL H1B/LCA filing data
 * (see src/lib/h1b/fuzzyMatch.ts). Deliberately excludes "Not Sponsoring" — DOL data is positive
 * evidence only (filings that happened); it never asserts a company categorically won't sponsor.
 * "Not Sponsoring" only ever appears at the job level, driven by explicit JD language.
 */
export type H1bCompanyConfidence = "Very High" | "High" | "Medium" | "Low" | "Unknown";

/** Job-level confidence: company confidence combined with this posting's own JD sponsorship
 *  language, which always overrides when present — see src/lib/h1b/combineSignal.ts. */
export type H1bJobConfidence = H1bCompanyConfidence | "Not Sponsoring";

/** Which layer of the matcher resolved a company to a DOL sponsor record — see the layered
 *  matching algorithm in src/lib/h1b/fuzzyMatch.ts. Never surfaced without also surfacing evidence. */
export type H1bMatchTier = "exact" | "alias" | "fuzzy";

export type SponsorshipPolarity = "positive" | "negative" | "none";
/**
 * "Not Interested" is deliberately not a member of this type — it's an action, not a persisted
 * status: marking a job Not Interested deletes its record immediately (see markNotInterested in
 * src/db/queries/jobs.ts), so a row's pipeline_status never actually holds that value.
 */
export type PipelineStatus =
  | "New"
  | "Interested"
  | "Applied"
  | "Interviewing"
  | "Offer"
  | "Employer Rejected";

/**
 * Scanner Reliability & Observability (see src/lib/scan/): categorized cause of a scan-run/company
 * failure, used both by the retry layer (which categories are worth retrying — see
 * src/lib/scan/retry.ts) and by the dashboard (src/app/scanner/page.tsx). No CHECK enum on the
 * scan_runs/companies columns that store this (same reasoning as SourceType above) — the taxonomy
 * may grow; app-layer only.
 */
export type ErrorCategory =
  | "timeout"
  | "rate_limited"
  | "network"
  | "provider_5xx"
  | "parse_error"
  | "invalid_config"
  | "blocked"
  | "unknown";

export type ScanRunStatus = "success" | "partial" | "failed";

/** Rollup label derived from a company's consecutive_failures — see
 *  src/lib/scan/health.ts's computeConnectorHealth. */
export type ConnectorHealth = "healthy" | "degraded" | "down" | "unknown";

export interface Company {
  id: number;
  name: string;
  source_type: SourceType;
  ats_board_token: string | null;
  career_page_url: string | null;
  is_active: 0 | 1;
  notes: string | null;
  /** The raw DOL employer name actually matched (whichever tier resolved it). */
  h1b_match_employer_name: string | null;
  /** The normalized identity actually matched against — the alias target when tier is "alias". */
  h1b_match_normalized: string | null;
  h1b_match_tier: H1bMatchTier | null;
  /** 100 for exact/alias tiers; the fuzzball similarity score (0-100) for fuzzy. */
  h1b_match_score: number | null;
  h1b_confidence: H1bCompanyConfidence;
  /** Total certified LCAs across every fiscal year on file for the matched employer. */
  h1b_lca_count: number;
  h1b_latest_fiscal_year: number | null;
  /** Human-readable justification for h1b_confidence — tier, filing volume, recency. */
  h1b_confidence_evidence: string | null;
  /** When h1b_confidence was last (re)computed — distinct from the generic updated_at. */
  h1b_updated_at: string | null;
  last_scanned_at: string | null;
  last_scan_status: string | null;
  last_scan_error: string | null;
  // --- Scanner Reliability & Observability (additive; see src/db/queries/companies.ts's
  // recordScanSuccess/recordScanPartial/recordScanFailure) ------------------------------------
  last_successful_scan_at: string | null;
  last_failed_scan_at: string | null;
  /** Resets to 0 on a successful scan; untouched by a partial scan (not a clean success, but not
   *  a failure either); increments on a failed scan. */
  consecutive_failures: number;
  last_error_category: ErrorCategory | null;
  last_error_message: string | null;
  connector_health: ConnectorHealth;
  created_at: string;
  updated_at: string;
}

/** One row per company-scan attempt — see src/db/queries/scanRuns.ts and src/lib/scan.ts. Written
 *  once, after the attempt finishes one way or another (no intermediate "running" row). */
export interface ScanRun {
  id: number;
  company_id: number;
  provider: SourceType;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  status: ScanRunStatus;
  jobs_discovered: number;
  jobs_added: number;
  jobs_updated: number;
  jobs_unchanged: number;
  duplicates_skipped: number;
  jobs_closed: number;
  jobs_archived: number;
  /** Always 0 today — see the jobs_deleted column comment in schema.sql. */
  jobs_deleted: number;
  description_failures: number;
  retry_count: number;
  error_category: ErrorCategory | null;
  error_message: string | null;
}

export interface ScanRunWithCompany extends ScanRun {
  company_name: string;
}

export interface DescriptionSections {
  responsibilities?: string;
  qualifications?: string;
  niceToHave?: string;
  skills?: string;
  benefits?: string;
}

// --- Structured Job Intelligence (see src/lib/jobIntel/) ------------------------------------
// Deterministic, rule-based extraction of structured metadata from each job's stored description.
// Every field is nullable/"Unknown" by design — extraction never fabricates a value it can't find
// evidence for. See src/lib/jobIntel/types.ts for the extractor's own working types; these are the
// persisted (DB row) shapes.

export type Seniority =
  | "Intern"
  | "Entry"
  | "Junior"
  | "Mid"
  | "Senior"
  | "Staff"
  | "Principal"
  | "Lead"
  | "Manager"
  | "Director"
  | "Unknown";

export type EmploymentTypeNormalized =
  | "Full-Time"
  | "Part-Time"
  | "Contract"
  | "Temporary"
  | "Internship"
  | "Contract-to-Hire"
  | "Unknown";

export type WorkplaceTypeNormalized = "Remote" | "Hybrid" | "Onsite" | "Unknown";

/** Requirement level for a single extracted skill or certification. */
export type RequirementLevel = "Required" | "Preferred";

/** Tri-state used for clearance/citizenship/work-authorization: these are binary asks in real JDs
 *  ("clearance required" or not) rather than a Required/Preferred spectrum like skills. */
export type RequirementTriState = "Required" | "Not Required" | "Unknown";

export const SKILL_CATEGORIES = [
  "Programming Languages",
  "Databases",
  "Cloud Platforms",
  "Data Engineering",
  "Big Data",
  "Warehousing",
  "Orchestration",
  "AI / ML",
  "DevOps",
  "Infrastructure",
  "BI / Reporting",
  "APIs",
  "Governance",
  "Security",
  "Monitoring",
  "Testing",
  "Other",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface JobSkill {
  id: number;
  job_id: number;
  skill_name: string;
  category: SkillCategory;
  requirement_level: RequirementLevel;
  /** Shared across every skill in an "AWS or Azure"-style alternative; NULL if not alternated. */
  alternative_group_id: string | null;
  evidence_snippet: string | null;
  created_at: string;
}

export interface JobCertification {
  id: number;
  job_id: number;
  name: string;
  requirement_level: RequirementLevel;
  evidence_snippet: string | null;
  created_at: string;
}

export interface Job {
  id: number;
  company_id: number;
  source_type: SourceType;
  external_id: string | null;
  title: string;
  location: string | null;
  department: string | null;
  url: string;
  description_html: string | null;
  description_text: string | null;
  /** JSON-encoded DescriptionSections, best-effort heading-based extraction. */
  description_sections: string | null;
  employment_type: string | null;
  workplace_type: string | null;
  salary_text: string | null;
  sponsorship_snippet: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  is_active: 0 | 1;
  dedupe_key: string;
  sponsorship_mentioned: 0 | 1;
  sponsorship_polarity: SponsorshipPolarity;
  h1b_combined_confidence: H1bJobConfidence;
  pipeline_status: PipelineStatus;
  pipeline_updated_at: string | null;
  marked_for_tailoring: 0 | 1;
  tailoring_marked_at: string | null;
  /** When is_active last flipped to 0 (not found in the latest scan of a live ATS board). */
  closed_at: string | null;
  /** Diagnostic only under the age-based policy — no longer gates archiving. */
  missed_scan_count: number;
  is_archived: 0 | 1;
  archived_at: string | null;
  archived_reason: string | null;
  /** Manual override: never auto-archived or auto-deleted regardless of age or pipeline_status. */
  pinned: 0 | 1;
  notes: string | null;
  /** JSON-encoded string array, e.g. '["remote","referral"]'. */
  tags: string | null;
  raw_json: string | null;
  created_at: string;
  updated_at: string;

  // --- Structured Job Intelligence (additive; see src/lib/jobIntel/) ------------------------
  seniority: Seniority | null;
  seniority_evidence: string | null;
  /** Normalized vocabulary derived from the raw `employment_type` column above (ATS-native first,
   *  JD text fallback) — the raw column is left untouched as the original source value. */
  employment_type_normalized: EmploymentTypeNormalized | null;
  /** Normalized vocabulary derived from the raw `workplace_type` column above. */
  workplace_type_normalized: WorkplaceTypeNormalized | null;
  workplace_office_days: string | null;
  location_city: string | null;
  location_state: string | null;
  location_country: string | null;
  /** JSON-encoded array of {city, state, country} for postings listing multiple locations. */
  location_list_json: string | null;
  location_relocation: string | null;
  location_travel_pct: string | null;
  experience_min_years: number | null;
  experience_preferred_years: number | null;
  /** JSON-encoded array of {technology, years}. */
  experience_by_tech_json: string | null;
  experience_evidence: string | null;
  education_level: string | null;
  education_field: string | null;
  education_requirement: RequirementLevel | "Unknown" | null;
  education_equivalent_experience_allowed: 0 | 1 | null;
  education_evidence: string | null;
  /** Structured, parsed from the existing salary_text column above — never a new raw-text scan. */
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  salary_period: "annual" | "hourly" | null;
  salary_bonus: string | null;
  salary_commission: string | null;
  salary_equity: string | null;
  clearance_required: RequirementTriState | null;
  clearance_level: string | null;
  citizenship_required: RequirementTriState | null;
  work_authorization_required: RequirementTriState | null;
  clearance_evidence: string | null;
  industry_domain: string | null;
  industry_domain_evidence: string | null;
  /** JSON-encoded string array of evidence-based flags, e.g. '["W2 Only","Clearance Required"]'. */
  job_quality_flags: string | null;
  structured_extraction_version: number | null;
  structured_extracted_at: string | null;
}

export interface JobWithCompany extends Job {
  company_name: string;
  /** The company's own historical H1B confidence — the "Historical Sponsor" the job detail page
   *  shows alongside this job's own (possibly JD-overridden) h1b_combined_confidence. */
  company_h1b_confidence: H1bCompanyConfidence;
  company_h1b_confidence_evidence: string | null;
  company_h1b_match_employer_name: string | null;
  company_h1b_match_tier: H1bMatchTier | null;
  company_h1b_lca_count: number;
  company_h1b_latest_fiscal_year: number | null;
}

/** Age band computed live from posted_at (preferred) or first_seen_at — never persisted, never
 *  derived from last_seen_at. See src/lib/jobLifecycle.ts. */
export type JobAgeBand = "fresh" | "active" | "aging" | "stale";

/** Identifies a job that was deleted (Not Interested, or aged out unapplied) for the caller to
 *  clean up its generated-files directory — the DB layer never touches the filesystem itself. */
export interface DeletedJobRef {
  jobId: number;
  companyName: string;
  dedupeKey: string;
}

export interface AgeSweepResult {
  archived: number;
  deleted: DeletedJobRef[];
}

export type JobHistoryChangeType = "pipeline_status" | "lifecycle" | "tailoring";

export interface JobStatusHistoryEntry {
  id: number;
  job_id: number;
  change_type: JobHistoryChangeType;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  changed_at: string;
}

/** Rollup/summary row — fully recomputed from H1bSponsorFiling rows after every ingest, never
 *  hand-edited. What matching queries actually read; see src/db/queries/h1bSponsors.ts. */
export interface H1bSponsor {
  id: number;
  employer_name_raw: string;
  employer_name_normalized: string;
  total_lca_certified: number;
  total_lca_denied: number;
  total_lca_withdrawn: number;
  fiscal_years_covered: string | null;
  most_recent_fiscal_year: number | null;
  source_file: string | null;
  ingested_at: string;
}

/** Durable, idempotent per-(employer, fiscal year) source-of-truth fact — the source data
 *  h1b_sponsors is derived from. One row per employer per fiscal year; re-ingesting the same year
 *  replaces this row rather than accumulating on top of it. */
export interface H1bSponsorFiling {
  id: number;
  employer_name_raw: string;
  employer_name_normalized: string;
  fiscal_year: number;
  certified: number;
  denied: number;
  withdrawn: number;
  source_file: string | null;
  ingested_at: string;
}

/** Approved alias mapping for the matcher's alias tier — deliberately never seeded with hardcoded
 *  companies; empty until a user/admin curates one. */
export interface H1bEmployerAlias {
  id: number;
  alias_normalized: string;
  employer_name_normalized: string;
  notes: string | null;
  created_at: string;
}

/** Result of matchCompanyToSponsor's layered lookup — the tier plus enough of the matched sponsor
 *  to score confidence and build an evidence string from. */
export interface H1bMatchResult {
  tier: H1bMatchTier;
  sponsor: H1bSponsor;
  /** 100 for exact/alias; the fuzzball similarity score (0-100) for fuzzy. */
  score: number;
  /** The normalized identity actually matched against (== sponsor.employer_name_normalized for
   *  exact/fuzzy; the alias's target for alias tier — kept explicit for evidence text). */
  matchedNormalized: string;
}

export interface H1bCompanyConfidenceResult {
  confidence: H1bCompanyConfidence;
  evidence: string;
}

export interface NormalizedJob {
  externalId: string | null;
  title: string;
  location: string | null;
  department: string | null;
  url: string;
  descriptionHtml: string | null;
  descriptionText: string | null;
  employmentType: string | null;
  workplaceType: string | null;
  salaryText: string | null;
  postedAt: string | null;
  raw: unknown;
}

export interface ScanResult {
  companyId: number;
  companyName: string;
  sourceType: SourceType;
  status: "ok" | "error";
  error?: string;
  jobsNew: number;
  jobsUpdated: number;
  jobsClosed: number;
  jobsArchived: number;
  /** Postings whose exact identity (dedupe_key) was previously deleted (Not Interested, or aged
   *  out unapplied) and so were not re-inserted as "new" this scan. */
  jobsSuppressed: number;
  /** Set when a career_link scrape found most links funnel through one embedded ATS board. */
  detectedAts?: { source: string; token: string };
}

export interface ScanSummary {
  results: ScanResult[];
  jobsNew: number;
  jobsUpdated: number;
  jobsClosed: number;
  jobsArchived: number;
  jobsSuppressed: number;
  /** Jobs the age-based sweep deleted this run (unapplied/unpinned, older than 10 days). Sweep
   *  runs once per runScan() call, across all companies, not per-company. */
  jobsDeletedByAge: number;
  errors: number;
}
