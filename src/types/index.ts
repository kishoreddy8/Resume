export type SourceType = "greenhouse" | "ashby" | "lever" | "workday" | "smartrecruiters" | "adp_wfn" | "adp_rm" | "eightfold" | "cornerstone" | "avature" | "paylocity" | "icims" | "ukg_pro" | "bamboohr" | "oracle_recruiting_cloud" | "workable" | "rippling" | "paycom" | "jazzhr" | "jobvite" | "breezy" | "teamtailor" | "applicantpro" | "pinpoint" | "clearcompany" | "personio" | "applicantstack" | "comeet" | "cats" | "gohire" | "newton" | "silkroad" | "jobdiva" | "taleo" | "phenom" | "successfactors" | "career_link";

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
 * Phase 3 V1 tailoring approval model. READY_DIRECT = the job was READY_FOR_TAILORING and approved
 * without an override; NEEDS_REVIEW_OVERRIDE = the job was NEEDS_REVIEW and a human explicitly
 * approved tailoring anyway, with the real blockingReasons shown first. BLOCKED jobs never reach
 * either value — there is no approval path for them in V1. See candidate_job_state.tailoring_approval_type
 * and tailoring_runs.approval_type.
 */
export type TailoringApprovalType = "READY_DIRECT" | "NEEDS_REVIEW_OVERRIDE";

/** tailoring_runs.status — two-phase lifecycle: every row starts 'started', then transitions
 *  exactly once to 'completed' or 'failed'. Terminal states are immutable at the query layer. */
export type TailoringRunStatus = "started" | "completed" | "failed";

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
  | "unsafe_url"
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
  // --- Source/ATS discovery (Phase 2.5; see src/lib/ats/discovery.ts) --------------------------
  // Whether Career-Ops itself could resolve a scannable source for this company. Distinct from
  // Phase 2's candidate-facing NEEDS_REVIEW match decision — this is company-registry state, not
  // per-candidate job fit.
  resolution_status: CompanyResolutionStatus;
  discovered_jobs_url: string | null;
  discovery_attempted_at: string | null;
  discovery_reason: string | null;
  /** Set only when resolution_status is NEEDS_ADAPTER — a recognized-but-unsupported ATS platform. */
  suspected_ats: string | null;
  // --- Domain identity (H1B Employer Source Discovery + ATS Hardening; see
  // src/lib/companyIdentity/) — a DIFFERENT axis from resolution_status above. resolution_status
  // answers "did we find its careers/ATS source"; domain_identity_status answers "did we identify
  // the real public company/domain." Neither ever gates or overwrites the other — a company can be
  // domain_identity_status=VERIFIED while resolution_status=FAILED_TEMPORARY, and that is valid.
  verified_domain: string | null;
  domain_identity_status: DomainIdentityStatus;
  last_successful_discovery_at: string | null;
  created_at: string;
  updated_at: string;
}

// --- 50K organization / multi-source registry -----------------------------------------------
// Additive compatibility model: companies remains the live scan interface while these entities
// separate canonical organization identity from aliases, domains, and one-or-many job sources.
export interface Organization {
  id: number;
  canonical_name: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface OrganizationAlias {
  id: number;
  organization_id: number;
  alias: string;
  alias_normalized: string;
  alias_type: string;
  provenance_source: string;
  provenance_key: string | null;
  evidence: string | null;
  is_primary: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface OrganizationDomain {
  id: number;
  organization_id: number;
  domain: string;
  identity_status: DomainIdentityStatus;
  resolution_method: string | null;
  resolution_confidence: string | null;
  evidence: string | null;
  is_primary: 0 | 1;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobSource {
  id: number;
  organization_id: number;
  provider: string;
  source_key: string | null;
  source_url: string | null;
  resolution_status: CompanyResolutionStatus;
  suspected_ats: string | null;
  is_authoritative: 0 | 1;
  is_active: 0 | 1;
  review_status: "PENDING" | "APPROVED" | "REJECTED";
  reviewed_at: string | null;
  review_evidence: string | null;
  legacy_company_id: number | null;
  last_validated_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CompanyResolutionStatus = "VERIFIED" | "GENERIC_SUPPORTED" | "UNRESOLVED" | "NEEDS_ADAPTER" | "FAILED_TEMPORARY";

/** Discovery V2 Stage 3 — a durable, reviewable proposal to replace a company's current ATS source
 *  with a candidate Discovery V2 found. Never applied automatically; see
 *  src/db/queries/atsSourceProposals.ts's approveProposal for the only path that ever mutates a
 *  company/job_source from one of these. */
export type AtsSourceProposalStatus = "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "SUPERSEDED";

export interface AtsSourceProposal {
  id: number;
  company_id: number;
  job_source_id: number | null;
  current_source_type: SourceType | null;
  current_board_token: string | null;
  proposed_source_type: Exclude<SourceType, "career_link">;
  proposed_board_token: string;
  proposed_canonical_url: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  validation_status: string;
  recommendation: string;
  evidence_json: string;
  discovery_source: string;
  status: AtsSourceProposalStatus;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  review_note: string | null;
}

/** "Did we identify the real public company/domain for this employer?" — fully independent of
 *  CompanyResolutionStatus above (see companies.domain_identity_status's comment). AMBIGUOUS is
 *  distinct from UNRESOLVED: it means multiple plausible entities were found and none was
 *  confidently chosen — an honest "we found candidates but won't guess," not "we found nothing." */
export type DomainIdentityStatus = "VERIFIED" | "AMBIGUOUS" | "UNRESOLVED" | "FAILED_TEMPORARY";

/** Which evidence path a VERIFIED/AMBIGUOUS domain_identity_status was reached through — see
 *  src/lib/companyIdentity/verifyDomain.ts. 'generated_verified_multisignal' is Path B (private
 *  companies with no Wikidata/SEC record, verified via ≥2 independent first-party channels); the
 *  rest are Path A (authoritative). */
export type DomainResolutionMethod =
  | "curated"
  | "wikidata"
  | "sec_corroborated"
  | "redirect_corroborated"
  | "generated_verified_multisignal"
  | "unresolved";

export type DomainResolutionConfidence = "high" | "medium" | "low";

/** Each of verifyDomain.ts's four strong first-party channels (CH1-CH4) — independently checked,
 *  never inferred from one another. 'conflict' means the channel was checked and named a DIFFERENT
 *  legal identity than what's being verified — distinct from 'no_match' (checked, said nothing
 *  useful) and 'not_checked' (never reached, e.g. because Path A already resolved it). */
export type DomainEvidenceChannelResult = "match" | "no_match" | "conflict" | "not_checked";

export interface DomainIdentityChannelsChecked {
  jsonLd: DomainEvidenceChannelResult;
  footer: DomainEvidenceChannelResult;
  aboutPage: DomainEvidenceChannelResult;
  termsPrivacyPage: DomainEvidenceChannelResult;
}

/** Optional, additive-only careers/ATS discovery snapshot attached to a DomainIdentityResult —
 *  NEVER read by, and never a gate on, domain identity status. See verifyDomain.ts. */
export interface CareersEvidence {
  checkedAt: string;
  sourceResolutionStatus: CompanyResolutionStatus | null;
  discoveredJobsUrl: string | null;
}

/** Result of running the domain-resolution waterfall (src/lib/companyIdentity/resolveDomain.ts)
 *  for one employer name. Persisted 1:1 onto EmployerIdentityResolution — see that interface's own
 *  comment for the schema-level shape/reasoning. */
export interface DomainIdentityResult {
  status: DomainIdentityStatus;
  domain: string | null;
  method: DomainResolutionMethod;
  confidence: DomainResolutionConfidence | null;
  evidence: string[];
  channelsChecked: DomainIdentityChannelsChecked;
  careersEvidence: CareersEvidence | null;
}

/** Persisted row — one per h1b_sponsors.id, current-state (latest attempt), mirroring companies'
 *  own resolution_status/discovery_attempted_at pattern. SOURCE-DISCOVERY mapping only — see
 *  schema.sql's CRITICAL BOUNDARY comment above this table: never read by H1B sponsorship scoring. */
export interface EmployerIdentityResolution {
  id: number;
  h1b_sponsor_id: number;
  resolved_company_id: number | null;
  domain_identity_status: DomainIdentityStatus;
  domain: string | null;
  resolution_method: DomainResolutionMethod | null;
  resolution_confidence: DomainResolutionConfidence | null;
  /** JSON-encoded string array — see DomainIdentityResult.evidence. */
  evidence: string | null;
  /** JSON-encoded DomainIdentityChannelsChecked. */
  channels_checked: string | null;
  careers_checked_at: string | null;
  careers_source_resolution_status: CompanyResolutionStatus | null;
  discovered_jobs_url: string | null;
  attempted_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Curated employer -> official domain override — Layer 0 of the resolution waterfall, the
 *  highest-trust source. Deliberately empty by default, never auto-seeded — same precedent as
 *  H1bEmployerAlias. */
export interface H1bEmployerDomainOverride {
  id: number;
  employer_name_normalized: string;
  domain: string;
  notes: string | null;
  created_at: string;
}

/** Batch-level discovery observability — one row per bounded batch run
 *  (src/lib/discovery/batch.ts). Mirrors ScanRun/match_runs' shape/reasoning. */
export interface DiscoveryRun {
  id: number;
  started_at: string;
  finished_at: string;
  employers_attempted: number;
  domains_verified: number;
  domains_ambiguous: number;
  domains_unresolved: number;
  domains_failed_temporary: number;
  careers_pages_resolved: number;
  ats_verified: number;
  needs_adapter: number;
  source_unresolved: number;
  source_failed_temporary: number;
  duration_ms: number;
  error_summary: string | null;
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
  /** ATS Health Semantics V2 — see src/db/queries/scanRuns.ts's RecordScanRunInput doc comments. */
  unknown_location_count: number;
  is_sample_scan: number;
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
  /** Only present when the query was scoped to a candidateId (see JobFilters.candidateId on
   *  listJobs/getJob) — this candidate's candidate_job_state.not_interested overlay. No legacy
   *  jobs.* counterpart, unlike pipeline_status/pinned/notes/tags. */
  not_interested?: 0 | 1;
}

/**
 * Lightweight projection of a job row for list views and ranking feeds.
 * Omits heavy multi-KB text/HTML/JSON blobs (description_html, description_sections, raw_json).
 * Preserves all metadata, title, department, location, compensation, dates, flags, company, and H1B fields.
 */
export interface JobWithCompanySummary
  extends Omit<JobWithCompany, "description_html" | "description_sections" | "raw_json"> {
  description_html?: never;
  description_sections?: never;
  raw_json?: never;
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

export type FreshnessDateType =
  | "POSTED"
  | "PUBLISHED"
  | "CREATED"
  | "UPDATED"
  | "FIRST_SEEN"
  | "UNKNOWN";

export type FreshnessConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface FreshnessProvenance {
  dateType: FreshnessDateType;
  confidence: FreshnessConfidence;
  basisDate: string | null;
  rawDate: string | null;
  ageDays: number | null;
  reason: string;
}

export interface ScanFreshnessMetrics {
  providerDateFresh: number;
  firstSeenFallbackFresh: number;
  staleRejected: number;
  invalidDateCount: number;
  futureDateCount: number;
  unknownDateCount: number;
  existingJobBypass: number;
  foreignFiltered: number;
  pseudoJobFiltered: number;
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
  /** Explicit provenance if set by adapter, otherwise derived from provider date type. */
  freshnessDateType?: FreshnessDateType;
  freshnessConfidence?: FreshnessConfidence;
  freshnessBasisDate?: string | null;
  /** Provider confirmed this requisition still exists but omitted fields required for a safe
   *  insert/update. The scanner counts it as seen and marks the run partial without overwriting
   *  previously stored job content. */
  sightingOnly?: boolean;
  /** The provider confirmed this existing posting still exists, but the active scan scope excludes
   * it (for example, a U.S.-only scan saw an explicitly non-U.S. location). Refresh lifecycle
   * state without changing stored content or treating the scan as partial. */
  lifecycleOnly?: boolean;
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
  /** Detailed freshness and filter counts for observability during production scans. */
  freshnessMetrics?: ScanFreshnessMetrics;
  /** Set when a career_link scrape found most links funnel through one embedded ATS board. */
  detectedAts?: { source: string; token: string };
  /** Phase 4 Stage 2 — canonical dedupe_key of every job newly inserted or materially changed
   *  (see src/lib/scan/status.ts's hasContentChanged) by this company's scan. Excludes unchanged
   *  re-seen jobs, stale-rejected jobs, foreign-filtered jobs, pseudo-jobs, and suppressed jobs —
   *  see src/lib/scan.ts's scanCompany() for exactly where each dedupeKey is added. Unique within
   *  this array; never raw title/company text, only the existing stable identity string. */
  affectedJobDedupeKeys: string[];
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
  /** Aggregated freshness and filter counts across all companies scanned. */
  freshnessMetrics?: ScanFreshnessMetrics;
  /** Phase 4 Stage 2 — union of every ScanResult.affectedJobDedupeKeys across all companies scanned
   *  this run, deduplicated. This is the exact input incremental matching (see
   *  src/lib/match/incrementalMatch.ts) consumes — see scanCompany()'s doc comment for the precise
   *  inclusion/exclusion rules. A company whose scan errored contributes nothing here (its
   *  ScanResult never reaches the per-job loop that populates this list). */
  affectedJobDedupeKeys: string[];
}
