export type SourceType = "greenhouse" | "ashby" | "lever" | "workday" | "career_link";
export type H1bSignal = "High" | "Medium" | "Low" | "Unknown";
export type H1bCombinedSignal = H1bSignal | "Likely" | "Unlikely";
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

export interface Company {
  id: number;
  name: string;
  source_type: SourceType;
  ats_board_token: string | null;
  career_page_url: string | null;
  is_active: 0 | 1;
  notes: string | null;
  h1b_match_employer_name: string | null;
  h1b_match_score: number | null;
  h1b_signal: H1bSignal;
  h1b_lca_count: number;
  last_scanned_at: string | null;
  last_scan_status: string | null;
  last_scan_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DescriptionSections {
  responsibilities?: string;
  qualifications?: string;
  niceToHave?: string;
  skills?: string;
  benefits?: string;
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
  h1b_combined_signal: H1bCombinedSignal;
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
}

export interface JobWithCompany extends Job {
  company_name: string;
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
