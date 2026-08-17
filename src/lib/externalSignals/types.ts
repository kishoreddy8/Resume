/**
 * Stage 7 — External Hiring Signal / Job Beacon architecture.
 *
 * SOURCE TRUST MODEL (Phase 2):
 *   TIER 1 — OFFICIAL: employer's own ATS/career platform, reached via the existing Discovery V2 +
 *     ats_source_proposals + human-approval pipeline. Always preferred, always authoritative.
 *   TIER 2 — HIGH-QUALITY SECONDARY: an external listing whose apply/listing URL resolves to a real,
 *     detectable ATS (detectAtsFromUrlString) for a confidently-matched employer. Strong enough
 *     evidence to become a secondary-sourced `jobs` row (source_type='google_jobs'|'indeed') when no
 *     official equivalent exists yet.
 *   TIER 3 — SECONDARY/EVIDENCE-ONLY: everything else with a confident employer match but no
 *     resolvable direct ATS URL (aggregator-only apply flow, or a generic employer career-page URL).
 *     Real evidence of hiring activity, but not implemented as jobs-table-eligible in Stage 7 —
 *     it feeds the Discovery V2 bridge only. Promoting TIER 3 to ingestible would require inventing a
 *     second, non-ATS job-identity scheme, which Stage 7's own "do not create two unrelated job
 *     systems" principle argues against; TIER 2's reuse of the real dedupeKeyForAts format avoids
 *     that entirely by construction.
 * This ordering is evidence-based, not an assumption: TIER 1 > TIER 2 is exactly "an employer's own
 * posting outranks a re-listing of it," and TIER 2 > TIER 3 is "a listing we can verify resolves to a
 * real ATS outranks one we can only match by name/domain."
 */

export type ExternalSignalSource = "google_jobs" | "indeed" | "built_in";

/** Raw evidence for one external listing, after provider-specific normalization. Deliberately NOT
 *  NormalizedJob and never passed to upsertJob directly — see the module doc comment in pipeline.ts
 *  for why staging is mandatory. */
export interface NormalizedExternalJob {
  source: ExternalSignalSource;
  providerJobId: string | null;
  employerName: string;
  title: string;
  location: string | null;
  description: string | null;
  postedAt: string | null;
  listingUrl: string;
  applyUrl: string | null;
  /** Resolved employer-owned URL if the provider/redirect chain exposes one (distinct from
   *  applyUrl, which may point at the aggregator's own hosted apply flow). */
  directEmployerUrl: string | null;
  employmentType: string | null;
  salaryText: string | null;
  raw: unknown;
}

export type MatchConfidence = "DOMAIN" | "ATS_BOARD" | "ALIAS" | "NAME" | "AMBIGUOUS" | "UNMATCHED";

export interface CompanyMatchResult {
  companyId: number | null;
  confidence: MatchConfidence;
  reason: string;
}

export type EmployerRelationship = "DIRECT_EMPLOYER" | "STAFFING_AGENCY" | "UNKNOWN_EMPLOYER_RELATIONSHIP";

export type UrlClassification = "DIRECT_ATS" | "GENERIC_EMPLOYER" | "AGGREGATOR_ONLY" | "UNKNOWN";

export type SignalClassification =
  | "NO_SIGNAL"
  | "EXTERNAL_HIRING_SIGNAL"
  | "DIRECT_ATS_SIGNAL"
  | "COVERAGE_MISMATCH"
  | "ALREADY_COVERED"
  | "AGENCY_FILTERED"
  | "AMBIGUOUS"
  | "EXPIRED";

export type ObservationDecision =
  | "OFFICIAL_EQUIVALENT_FOUND"
  | "SECONDARY_JOB_CANDIDATE"
  | "DUPLICATE_EXTERNAL"
  | "STAFFING_AGENCY"
  | "AMBIGUOUS_EMPLOYER"
  | "NON_US"
  | "LOW_QUALITY"
  | "STALE"
  | "INVALID"
  | "DISCOVERY_BEACON_ONLY";

/** Cross-source job-identity confidence (Phase 8). Only EXACT/HIGH may ever auto-dedupe; POSSIBLE
 *  must remain two distinct rows/observations rather than risk destroying data on a guess. */
export type CrossSourceMatchConfidence = "EXACT" | "HIGH" | "POSSIBLE" | "DISTINCT";

export interface ExternalHiringObservationRow {
  id: number;
  source: ExternalSignalSource;
  provider_job_id: string | null;
  fingerprint: string;
  observed_employer_name: string;
  observed_title: string;
  observed_location: string | null;
  observed_url: string;
  direct_employer_url: string | null;
  direct_apply_url: string | null;
  employer_domain: string | null;
  posted_at: string | null;
  matched_company_id: number | null;
  match_confidence: MatchConfidence;
  employer_relationship: EmployerRelationship;
  url_classification: UrlClassification;
  detected_ats_provider: string | null;
  detected_ats_board_token: string | null;
  signal_classification: SignalClassification;
  decision: ObservationDecision;
  resulting_job_id: number | null;
  evidence_json: string;
  status: "ACTIVE" | "EXPIRED" | "SUPERSEDED";
  first_observed_at: string;
  last_observed_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** Provider interface (Phase 3). search() returns raw provider-shaped results; normalize() converts
 *  ONE raw result into evidence. Kept as two separate methods (rather than search() returning
 *  NormalizedExternalJob directly) so a provider's raw shape and its normalization logic are each
 *  independently unit-testable against fixtures, matching Phase 21's required test list. */
export interface ExternalHiringSignalProvider {
  readonly source: ExternalSignalSource;
  search(query: SearchQuery): Promise<unknown[]>;
  normalize(rawResult: unknown): NormalizedExternalJob;
}

export interface SearchQuery {
  role: string;
  location?: string;
  limit?: number;
}

/** The default, curated role list for Phase 17's targeted search strategy — CareerOps' own
 *  candidate/skills focus, not an attempt to scrape every job on the internet. */
export const DEFAULT_SEARCH_ROLES: readonly string[] = [
  "Data Engineer",
  "Senior Data Engineer",
  "Azure Data Engineer",
  "AWS Data Engineer",
  "Databricks Engineer",
  "Snowflake Data Engineer",
  "Analytics Engineer",
  "Data Platform Engineer",
  "AI Engineer",
  "ML Engineer",
  "Machine Learning Engineer",
  "Cloud Engineer",
  "Java Developer",
  "Senior Java Developer",
  "Java Full Stack Developer",
  "Software Engineer",
];
