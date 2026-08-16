-- career-ops-project SQLite schema

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- No CHECK enum here on purpose: the provider list keeps growing (see src/lib/ats/), and
  -- app-layer zod validation in the API routes already enforces the valid SourceType set.
  source_type TEXT NOT NULL,
  ats_board_token TEXT,
  career_page_url TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  -- H1B Sponsor Intelligence (see src/lib/h1b/). No CHECK enum here on purpose (same reasoning as
  -- source_type above): confidence vocabulary is Very High/High/Medium/Low/Unknown at the company
  -- level (Not Sponsoring is job-level only — DOL data is purely positive evidence, it never
  -- asserts a company won't sponsor). App-layer zod validation enforces the valid set instead.
  h1b_match_employer_name TEXT,
  -- The normalized form actually matched against (raw DOL employer_name_normalized, or the alias
  -- target if matched via the alias table) — kept distinct from the company's own normalized name
  -- so "what did we match against" stays visible even if match tiers disagree.
  h1b_match_normalized TEXT,
  h1b_match_tier TEXT, -- 'exact' | 'alias' | 'fuzzy' | NULL (no match)
  h1b_match_score REAL,
  h1b_confidence TEXT NOT NULL DEFAULT 'Unknown',
  h1b_lca_count INTEGER NOT NULL DEFAULT 0,
  h1b_latest_fiscal_year INTEGER,
  -- Human-readable justification for h1b_confidence — which tier matched, filing volume, recency.
  -- Distinct from a job's sponsorship_snippet, which is JD-specific evidence, not company history.
  h1b_confidence_evidence TEXT,
  -- When h1b_confidence was last (re)computed — distinct from the generic updated_at, which
  -- changes on any company edit, not specifically an H1B rematch.
  h1b_updated_at TEXT,
  last_scanned_at TEXT,
  last_scan_status TEXT,
  last_scan_error TEXT,
  -- Source/ATS discovery status (Phase 2.5, see src/lib/ats/discovery.ts). Distinct from Phase 2's
  -- candidate-facing NEEDS_REVIEW decision — this describes whether Career-Ops itself could resolve
  -- a scannable source for the company, not whether a candidate is a fit for any of its jobs.
  -- 'VERIFIED' | 'GENERIC_SUPPORTED' | 'UNRESOLVED' | 'NEEDS_ADAPTER' | 'FAILED_TEMPORARY' —
  -- app-layer validated, no CHECK (same "taxonomy may grow" precedent as source_type above).
  resolution_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  discovered_jobs_url TEXT,
  discovery_attempted_at TEXT,
  discovery_reason TEXT,
  suspected_ats TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- idx_companies_resolution_status is NOT declared here: on an existing database, resolution_status
-- doesn't exist until runCompaniesDiscoveryMigrations() adds it (this CREATE TABLE IF NOT EXISTS is
-- a no-op there), and this whole file runs as one db.exec() before that migration step — same
-- reasoning as idx_jobs_archived/idx_jobs_pinned below. src/db/index.ts creates that index
-- explicitly after the migration instead.

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_ats
  ON companies(source_type, ats_board_token) WHERE ats_board_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_career_url
  ON companies(career_page_url) WHERE career_page_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(is_active);

-- 50K employer/ATS registry compatibility foundation. The existing companies table remains the
-- live application interface during the additive transition; these tables separate canonical
-- organization identity from legal-name aliases, domains, and one-or-many job sources. A company
-- row is linked explicitly rather than treated as the canonical identity itself, allowing a later
-- reviewed merge to attach several legacy company/source rows to one organization without changing
-- jobs.company_id or any current route/query contract.
CREATE TABLE IF NOT EXISTS organizations (
  id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_organizations_name ON organizations(canonical_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

CREATE TABLE IF NOT EXISTS organization_company_links (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_organization_company_links_org
  ON organization_company_links(organization_id);

CREATE TABLE IF NOT EXISTS organization_aliases (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  alias_normalized TEXT NOT NULL,
  alias_type TEXT NOT NULL DEFAULT 'legal',
  provenance_source TEXT NOT NULL,
  provenance_key TEXT,
  evidence TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_aliases_provenance
  ON organization_aliases(provenance_source, provenance_key) WHERE provenance_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_aliases_identity
  ON organization_aliases(organization_id, alias_normalized, provenance_source);
CREATE INDEX IF NOT EXISTS idx_organization_aliases_normalized
  ON organization_aliases(alias_normalized);

CREATE TABLE IF NOT EXISTS organization_domains (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  identity_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  resolution_method TEXT,
  resolution_confidence TEXT,
  evidence TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_organization_domains_org_domain
  ON organization_domains(organization_id, domain);
CREATE INDEX IF NOT EXISTS idx_organization_domains_domain ON organization_domains(domain);
CREATE INDEX IF NOT EXISTS idx_organization_domains_status ON organization_domains(identity_status);

CREATE TABLE IF NOT EXISTS job_sources (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  source_key TEXT,
  source_url TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  suspected_ats TEXT,
  is_authoritative INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  -- Automated discovery may identify a structured board, but only a reviewed approval authorizes
  -- the job scanner. This is deliberately independent of provider-level resolution_status.
  review_status TEXT NOT NULL DEFAULT 'PENDING',
  reviewed_at TEXT,
  review_evidence TEXT,
  -- Compatibility pointer while companies remains the live scan interface. Unique because one
  -- legacy company row represents exactly one source; NULL for future native multi-source rows.
  legacy_company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  last_validated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_sources_provider_key
  ON job_sources(provider, source_key) WHERE source_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_sources_url
  ON job_sources(source_url) WHERE source_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_sources_legacy_company
  ON job_sources(legacy_company_id) WHERE legacy_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_sources_org ON job_sources(organization_id);
CREATE INDEX IF NOT EXISTS idx_job_sources_resolution ON job_sources(resolution_status);
CREATE INDEX IF NOT EXISTS idx_job_sources_due_active ON job_sources(is_active);

-- One durable row per canonical organization searched by the registry-wide discovery runner.
-- This generalizes the older H1B-sponsor-only employer_identity_resolutions table so PERM-only
-- organizations participate in the same resumable campaign.
CREATE TABLE IF NOT EXISTS organization_discovery_state (
  organization_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  resolved_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  domain_identity_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  domain TEXT,
  resolution_method TEXT,
  resolution_confidence TEXT,
  evidence TEXT,
  channels_checked TEXT,
  source_resolution_status TEXT,
  discovered_jobs_url TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_organization_discovery_state_status
  ON organization_discovery_state(domain_identity_status, attempted_at);

-- Audited Tier-3/browser second pass for organizations whose domain is already VERIFIED but whose
-- HTTP-only source discovery found only a generic page or no supported ATS. Append-only attempts
-- keep the original first-pass checkpoint intact and make retries/cooldowns independently visible.
CREATE TABLE IF NOT EXISTS organization_source_discovery_attempts (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  pass_type TEXT NOT NULL,
  input_url TEXT NOT NULL,
  prior_status TEXT,
  result_status TEXT NOT NULL,
  provider TEXT,
  source_key TEXT,
  source_url TEXT,
  suspected_ats TEXT,
  reason TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_org_source_attempts_queue
  ON organization_source_discovery_attempts(organization_id, pass_type, finished_at);
CREATE INDEX IF NOT EXISTS idx_org_source_attempts_result
  ON organization_source_discovery_attempts(result_status, finished_at);

-- Append-only connector/generic-source validation evidence. Validation samples deliberately live
-- outside `jobs`: probing a source must never publish test rows to the candidate-facing job board.
-- can_ingest authorizes additive U.S.-only loads; can_close_missing requires separately-proven
-- pagination/completeness and is always 0 for generic career pages.
CREATE TABLE IF NOT EXISTS job_source_validation_runs (
  id INTEGER PRIMARY KEY,
  job_source_id INTEGER NOT NULL REFERENCES job_sources(id) ON DELETE CASCADE,
  validation_kind TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  extractor_type TEXT,
  validation_scope TEXT,
  sample_limit INTEGER NOT NULL DEFAULT 3,
  jobs_seen INTEGER NOT NULL DEFAULT 0,
  us_jobs_seen INTEGER NOT NULL DEFAULT 0,
  samples_saved INTEGER NOT NULL DEFAULT 0,
  pagination_verified INTEGER NOT NULL DEFAULT 0,
  completeness_verified INTEGER NOT NULL DEFAULT 0,
  can_ingest INTEGER NOT NULL DEFAULT 0,
  can_close_missing INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source_validation_runs_source
  ON job_source_validation_runs(job_source_id, finished_at);
CREATE INDEX IF NOT EXISTS idx_source_validation_runs_outcome
  ON job_source_validation_runs(outcome, finished_at);

CREATE TABLE IF NOT EXISTS job_source_validation_samples (
  id INTEGER PRIMARY KEY,
  validation_run_id INTEGER NOT NULL REFERENCES job_source_validation_runs(id) ON DELETE CASCADE,
  sample_index INTEGER NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  location TEXT,
  location_scope TEXT NOT NULL,
  job_url TEXT NOT NULL,
  description_present INTEGER NOT NULL DEFAULT 0,
  posted_at TEXT,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(validation_run_id, sample_index)
);

CREATE INDEX IF NOT EXISTS idx_source_validation_samples_run
  ON job_source_validation_samples(validation_run_id, sample_index);

-- Passive research evidence for recognized ATS families that do not yet have connectors. These
-- runs can identify public endpoint shapes and tenant/pagination clues, but never authorize job
-- ingestion: adapter implementation plus the separate connector validator remain mandatory.
CREATE TABLE IF NOT EXISTS ats_adapter_profile_runs (
  id INTEGER PRIMARY KEY,
  job_source_id INTEGER NOT NULL REFERENCES job_sources(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  suspected_ats TEXT NOT NULL,
  profiler_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  source_host TEXT NOT NULL,
  final_url_shape TEXT,
  http_status INTEGER,
  endpoint_candidates INTEGER NOT NULL DEFAULT 0,
  api_evidence INTEGER NOT NULL DEFAULT 0,
  pagination_evidence INTEGER NOT NULL DEFAULT 0,
  tenant_evidence INTEGER NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL,
  error_category TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_adapter_profile_source
  ON ats_adapter_profile_runs(job_source_id, profiler_version, finished_at);
CREATE INDEX IF NOT EXISTS idx_adapter_profile_provider
  ON ats_adapter_profile_runs(suspected_ats, profiler_version, outcome, finished_at);

-- Read-only health probes for approved structured connectors. This is intentionally separate from
-- scan_runs/company.connector_health: a probe never loads or closes jobs and cannot revoke approval.
CREATE TABLE IF NOT EXISTS connector_health_check_runs (
  id INTEGER PRIMARY KEY,
  job_source_id INTEGER NOT NULL REFERENCES job_sources(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  checker_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  jobs_seen INTEGER NOT NULL DEFAULT 0,
  sample_external_id TEXT,
  sample_title TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  error_message TEXT,
  evidence_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_connector_health_source
  ON connector_health_check_runs(job_source_id, checker_version, finished_at);
CREATE INDEX IF NOT EXISTS idx_connector_health_outcome
  ON connector_health_check_runs(outcome, provider, finished_at);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  external_id TEXT,
  title TEXT NOT NULL,
  location TEXT,
  department TEXT,
  url TEXT NOT NULL,
  description_html TEXT,
  description_text TEXT,
  description_sections TEXT,
  employment_type TEXT,
  workplace_type TEXT,
  salary_text TEXT,
  sponsorship_snippet TEXT,
  posted_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL,
  sponsorship_mentioned INTEGER NOT NULL DEFAULT 0,
  sponsorship_polarity TEXT NOT NULL DEFAULT 'none' CHECK (sponsorship_polarity IN ('positive','negative','none')),
  -- H1B Sponsor Intelligence, job level: company h1b_confidence combined with this posting's own
  -- JD sponsorship language (sponsorship_mentioned/polarity/snippet above), which always wins when
  -- present — see src/lib/h1b/combineSignal.ts. No CHECK enum on purpose (same reasoning as
  -- pipeline_status below): Very High/High/Medium/Low/Unknown/Not Sponsoring, app-layer validated.
  h1b_combined_confidence TEXT NOT NULL DEFAULT 'Unknown',
  -- No CHECK enum here on purpose (same reasoning as companies.source_type above): the status set
  -- has already changed once (Interview -> Interviewing, Rejected -> Employer Rejected, in the
  -- age-based lifecycle policy) and may again. 'Not Interested' is deliberately NOT a value that
  -- ever persists here — see src/db/queries/jobs.ts's markNotInterested(), which deletes the row
  -- instead. App-layer zod validation in the API routes enforces the valid PipelineStatus set.
  pipeline_status TEXT NOT NULL DEFAULT 'New',
  pipeline_updated_at TEXT,
  marked_for_tailoring INTEGER NOT NULL DEFAULT 0,
  tailoring_marked_at TEXT,
  -- Lifecycle management (see src/lib/jobLifecycle.ts for the full policy). Three independent
  -- facts, not a single state machine:
  --   is_active/closed_at   — whether the posting was found in the most recent scan of a live ATS
  --                           board (career-link scrapes never set this; they're not authoritative).
  --   is_archived/archived_at/archived_reason — hidden from the default jobs view. Reached either
  --                           immediately when an unapplied/unpinned job's posting closes, or via
  --                           the age-based sweep (8-10 days old, posted_at/first_seen_at derived,
  --                           never last_seen_at). Rows past 10 days old are deleted outright
  --                           instead (see suppressed_jobs below) rather than staying archived.
  --   pinned                 — manual override: never auto-archived or auto-deleted regardless of
  --                           age or pipeline_status, same protection as Applied/Interviewing/
  --                           Offer/Employer Rejected.
  -- missed_scan_count is retained as diagnostic metadata (how many scans in a row a protected job's
  -- posting has been gone) — it no longer gates archiving; the policy is purely age/status based.
  closed_at TEXT,
  missed_scan_count INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  archived_reason TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- JSON array of strings, e.g. '["remote","high-priority"]'. Stored as raw TEXT (same convention
  -- as description_sections) rather than a separate table since tags are simple per-job labels.
  tags TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_company_active ON jobs(company_id, is_active);
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline ON jobs(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_jobs_h1b ON jobs(h1b_combined_confidence);
CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs(is_active);
-- idx_jobs_archived is NOT declared here: on an existing database, is_archived doesn't exist until
-- runAdditiveMigrations() adds it (this CREATE TABLE IF NOT EXISTS is a no-op there), and this
-- whole file runs as one db.exec() before that migration step. src/db/index.ts creates that index
-- explicitly after migrations instead (see its comment for the full explanation) — same reasoning
-- covers pinned, which is why there's no idx_jobs_pinned declared here either.

-- Full audit trail of pipeline-status changes and lifecycle transitions (Active/Closed/Archived),
-- so "why did this get archived" and "when did this move to Applied" are always answerable. Rows
-- cascade-delete with their job — once a job is deleted (Not Interested, or aged past 10 days
-- unapplied), its history is gone too; suppressed_jobs below is what survives instead.
CREATE TABLE IF NOT EXISTS job_status_history (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL CHECK (change_type IN ('pipeline_status', 'lifecycle', 'tailoring')),
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_status_history_job ON job_status_history(job_id, changed_at DESC);

-- Lightweight fingerprint kept after a job record is deleted (Not Interested, or the age-based
-- sweep deleting an unapplied posting older than 10 days), so the exact same requisition never
-- silently reappears and gets re-inserted as "new" on a later scan. Keyed on dedupe_key, which
-- already encodes the project's identity preference order for a given job (ATS provider + external
-- job ID for ATS-sourced postings, a title+URL hash for career-link scrapes) — see src/lib/dedupe.ts.
-- A genuinely different requisition (different external ID / different dedupe_key) for the same
-- role at the same company is NOT suppressed by this — only an exact identity match is.
CREATE TABLE IF NOT EXISTS suppressed_jobs (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT,
  reason TEXT NOT NULL,
  suppressed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_suppressed_jobs_dedupe ON suppressed_jobs(dedupe_key);

-- Durable, idempotent source of truth for imported DOL H1B/LCA data: one row per
-- (employer, fiscal year). Re-ingesting the same fiscal year's file REPLACES that year's numbers
-- (upsert on the unique key below) rather than adding to them, so re-running an import is always
-- safe; ingesting a *different* fiscal year for the same employer is a genuine incremental update,
-- naturally additive when h1b_sponsors (below) is recomputed from this table. See
-- src/db/queries/h1bSponsors.ts's upsertSponsorFiling / recomputeAllSponsorSummaries and
-- scripts/ingest-h1b.ts.
CREATE TABLE IF NOT EXISTS h1b_sponsor_filings (
  id INTEGER PRIMARY KEY,
  employer_name_raw TEXT NOT NULL,
  employer_name_normalized TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  certified INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  source_file TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_h1b_filings_employer_year
  ON h1b_sponsor_filings(employer_name_normalized, fiscal_year);

-- Fast-lookup rollup, fully recomputed from h1b_sponsor_filings after every ingest (never
-- hand-edited) — matching queries read only from here, never need to aggregate filings at request
-- time. total_lca_certified etc. are SUMs across every fiscal year on file for that employer.
CREATE TABLE IF NOT EXISTS h1b_sponsors (
  id INTEGER PRIMARY KEY,
  employer_name_raw TEXT NOT NULL,
  employer_name_normalized TEXT NOT NULL,
  total_lca_certified INTEGER NOT NULL DEFAULT 0,
  total_lca_denied INTEGER NOT NULL DEFAULT 0,
  total_lca_withdrawn INTEGER NOT NULL DEFAULT 0,
  fiscal_years_covered TEXT,
  most_recent_fiscal_year INTEGER,
  source_file TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_h1b_employer_norm ON h1b_sponsors(employer_name_normalized);

-- PERM employer filings mirror the durable H-1B import pattern above. FY2024 contains separate
-- legacy and revised ETA-9089 disclosure files, so dataset_variant is part of the idempotency key:
-- re-importing one exact dataset replaces its counts while the two official form datasets remain
-- additive. perm_employers is a derived fast-lookup rollup and is never edited directly.
CREATE TABLE IF NOT EXISTS perm_employer_filings (
  id INTEGER PRIMARY KEY,
  employer_name_raw TEXT NOT NULL,
  employer_name_normalized TEXT NOT NULL,
  fiscal_year INTEGER NOT NULL,
  dataset_variant TEXT NOT NULL DEFAULT 'main',
  certified INTEGER NOT NULL DEFAULT 0,
  denied INTEGER NOT NULL DEFAULT 0,
  withdrawn INTEGER NOT NULL DEFAULT 0,
  source_file TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_filings_employer_year_variant
  ON perm_employer_filings(employer_name_normalized, fiscal_year, dataset_variant);

CREATE TABLE IF NOT EXISTS perm_employers (
  id INTEGER PRIMARY KEY,
  employer_name_raw TEXT NOT NULL,
  employer_name_normalized TEXT NOT NULL,
  total_certified INTEGER NOT NULL DEFAULT 0,
  total_denied INTEGER NOT NULL DEFAULT 0,
  total_withdrawn INTEGER NOT NULL DEFAULT 0,
  fiscal_years_covered TEXT,
  most_recent_fiscal_year INTEGER,
  source_file TEXT,
  ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_employer_norm
  ON perm_employers(employer_name_normalized);

-- Explicit provenance links between a public employer record and one canonical organization.
-- The normalized name is retained here for exact cross-source matching and auditability; it is
-- deliberately not a fuzzy/parent-company assertion. A source row can link to exactly one org.
CREATE TABLE IF NOT EXISTS organization_employer_records (
  id INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_record_id INTEGER NOT NULL,
  employer_name_raw TEXT NOT NULL,
  employer_name_normalized TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_type, source_record_id)
);

CREATE INDEX IF NOT EXISTS idx_org_employer_records_org
  ON organization_employer_records(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_employer_records_normalized
  ON organization_employer_records(employer_name_normalized);

-- Approved alias tier for matching (see src/lib/h1b/fuzzyMatch.ts's layered matcher): maps a name
-- variant that normalization alone can't bridge (a former legal name, a common brand name that
-- differs from the DOL filing name, an acquired subsidiary, etc.) to the normalized identity it
-- should resolve to. Deliberately empty by default — approved aliases are curated (by the user, or
-- an admin process), never hardcoded or auto-generated, so this tier never introduces a false
-- positive on its own.
CREATE TABLE IF NOT EXISTS h1b_employer_aliases (
  id INTEGER PRIMARY KEY,
  alias_normalized TEXT NOT NULL,
  employer_name_normalized TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_h1b_aliases_alias ON h1b_employer_aliases(alias_normalized);

-- Structured Job Intelligence (see src/lib/jobIntel/): deterministic, rule-based extraction of
-- skills/experience/education/certifications/seniority/location/compensation/clearance from each
-- job's stored description. Scalar fields live as additive columns on jobs (see
-- JOBS_STRUCTURED_INTEL_ADDITIVE_COLUMNS in src/db/index.ts); skills and certifications are
-- naturally multi-row per job, so they get their own tables rather than a JSON blob.
CREATE TABLE IF NOT EXISTS job_skills (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  skill_name TEXT NOT NULL,
  category TEXT NOT NULL,
  requirement_level TEXT NOT NULL, -- 'Required' | 'Preferred'
  -- Shared across every skill in an "AWS or Azure"-style alternative — lets the UI render one OR
  -- requirement instead of two independent required skills. NULL when the skill wasn't part of an
  -- alternation.
  alternative_group_id TEXT,
  evidence_snippet TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_skills_job ON job_skills(job_id);
CREATE INDEX IF NOT EXISTS idx_job_skills_name ON job_skills(skill_name);
CREATE INDEX IF NOT EXISTS idx_job_skills_requirement ON job_skills(requirement_level);

CREATE TABLE IF NOT EXISTS job_certifications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  requirement_level TEXT NOT NULL, -- 'Required' | 'Preferred'
  evidence_snippet TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_job_certifications_job ON job_certifications(job_id);

-- Scanner Reliability & Observability: one row per company-scan attempt (see src/lib/scan.ts).
-- Both timestamps are already known when the row is written (scanCompany runs to completion, one
-- way or another, before this is ever inserted) so there's no intermediate "running" state to model.
-- No CHECK on status/error_category (same reasoning as companies.source_type above) — the error
-- taxonomy in src/lib/scan/errors.ts may grow, app-layer validated instead.
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL, -- 'success' | 'partial' | 'failed'
  jobs_discovered INTEGER NOT NULL DEFAULT 0,
  jobs_added INTEGER NOT NULL DEFAULT 0,
  jobs_updated INTEGER NOT NULL DEFAULT 0,
  jobs_unchanged INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped INTEGER NOT NULL DEFAULT 0,
  jobs_closed INTEGER NOT NULL DEFAULT 0,
  jobs_archived INTEGER NOT NULL DEFAULT 0,
  -- Always 0 at this per-company level today: deletion only happens via the global,
  -- company-independent runAgeBasedSweep() in src/db/queries/jobs.ts, which isn't attributed back
  -- to any one scan_run. Kept as a column for the full field set this feature was asked to track.
  jobs_deleted INTEGER NOT NULL DEFAULT 0,
  description_failures INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_scan_runs_company ON scan_runs(company_id, started_at DESC);

-- Settings: durable key-value store for user-configurable Lifecycle/Suppression/Scanner values
-- (see src/lib/settings.ts for the typed shape/defaults/validation and src/db/queries/settings.ts
-- for the loader). One row per leaf setting (e.g. 'lifecycle.fresh_days'); a missing key falls back
-- to that setting's default, so an empty table reproduces today's hardcoded behavior exactly. A
-- brand-new table, not an ALTER of any existing one — safe to add via plain CREATE TABLE IF NOT
-- EXISTS on both a fresh install and an existing database.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- AI Infrastructure (see src/lib/ai/): shared, reusable foundation for future AI-assisted features
-- (job-intel enrichment, H1B alias suggestion, sponsorship-language fallback, match scoring, etc.).
-- Deliberately generic across future tasks rather than one table per feature — see
-- src/lib/ai/types.ts's AiTaskDefinition doc comment for why a single shared result table beats
-- both a table-per-task design and an unstructured blob. No feature reads or writes these tables yet
-- (infrastructure-only phase); Phase 1's deterministic pipeline (scan/dedupe/lifecycle/suppression/
-- H1B/jobIntel) never calls into src/lib/ai/ and is completely unaffected by its presence. Three
-- brand-new tables, not an ALTER of any existing one — safe via plain CREATE TABLE IF NOT EXISTS on
-- both a fresh install and an existing database, same as settings above.

-- Immutable per exact (entity, task, task_version, content_hash, provider, model) identity — once a
-- row exists for that exact key, it is NEVER updated (see src/lib/ai/runAiTask.ts): a re-run with
-- identical inputs/task-version/provider/model is always a cache hit, never a rewrite. `status` is
-- the one exception — metadata-only bookkeeping (current vs. superseded/expired, for a future
-- history view), set independently of the row's own generated content and never touching
-- output_json/confidence_value/confidence_band. No CHECK on entity_type/status (same "app-layer
-- validated, taxonomy may grow" precedent as companies.source_type/jobs.pipeline_status above).
--
-- IDENTITY SAFETY (entity_key vs. entity_id): jobs.id/companies.id are plain SQLite INTEGER PRIMARY
-- KEY columns without AUTOINCREMENT, so a numeric id CAN be reused by a later, unrelated row once
-- the original is deleted (Not Interested / aged out — see jobLifecycle.ts). entity_id alone would
-- therefore be unsafe as this table's identity: a stale AI result keyed only on entity_id could
-- silently appear to belong to a brand-new, unrelated entity that happens to reuse the same id.
-- entity_key is the fix — a stable identity SNAPSHOT the calling feature copies from Phase 1's own
-- already-authoritative identity (jobs.dedupe_key for a job; a caller-constructed key from
-- companies' existing unique identity — source_type+ats_board_token, or career_page_url — for a
-- company) at write time, and is what every lookup/uniqueness check actually uses (see
-- idx_ai_enrichments_key below). AI never computes, changes, or influences that identity — it only
-- copies it. entity_id is kept purely as convenient current-row metadata (a breadcrumb of "what
-- numeric row this pointed at when written") — NEVER used for lookup or uniqueness, since it's
-- exactly the piece that can become ambiguous after a delete+reuse.
CREATE TABLE IF NOT EXISTS ai_enrichments (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL, -- 'job' | 'company'
  -- Stable identity snapshot — see the IDENTITY SAFETY comment above. This, not entity_id, is what
  -- idx_ai_enrichments_key enforces uniqueness on and what every cache lookup filters by.
  entity_key TEXT NOT NULL,
  -- Convenience metadata only — the numeric row id at write time. No FK (SQLite can't conditionally
  -- reference one of two parent tables by a discriminator column anyway), and deliberately never
  -- part of any lookup/uniqueness check — see the IDENTITY SAFETY comment above for why.
  entity_id INTEGER NOT NULL,
  task TEXT NOT NULL,
  -- Also serves as the output-schema version by convention: any change to that task's output shape
  -- requires bumping this, so a stored row's output_json always matches what the current code
  -- expects for that exact (task, task_version) pair — same discipline as jobs.structured_extraction_version.
  task_version INTEGER NOT NULL,
  -- sha256 of the task's cache-key projection only (src/lib/ai/types.ts's toCacheKeyInput) —
  -- independent of what was actually sent to the provider (toProviderInput/buildPrompt).
  content_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  -- Written only after passing that task's own Zod output schema — never an unvalidated blob. Every
  -- other AI-relevant fact (task, version, provider, model, hash, timestamp) lives as its own typed
  -- column precisely so nothing load-bearing is buried inside this JSON.
  output_json TEXT NOT NULL,
  confidence_value REAL,
  confidence_band TEXT, -- 'low' | 'review' | 'high'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'superseded' | 'expired' — see comment above
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- entity_key, not entity_id, carries identity here — see the table's IDENTITY SAFETY comment above.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_enrichments_key
  ON ai_enrichments(entity_type, entity_key, task, task_version, content_hash, provider, model_id);
CREATE INDEX IF NOT EXISTS idx_ai_enrichments_entity ON ai_enrichments(entity_type, entity_key);
-- Convenience/debug only — NOT used by any lookup that needs correctness (entity_id can be
-- ambiguous after a delete+reuse; entity_key above is authoritative). Useful for spotting an id-reuse
-- collision itself (two different entity_key values sharing one entity_id) if that's ever needed.
CREATE INDEX IF NOT EXISTS idx_ai_enrichments_entity_id_debug ON ai_enrichments(entity_type, entity_id);

-- Append-only usage/cost ledger — one row per orchestration attempt, including cache hits (logged at
-- exactly zero cost/tokens) and every pre-call short-circuit (disabled/missing credentials/budget
-- exceeded, logged with NULL token/cost fields since no request was ever sent). A response that
-- failed Zod validation still logs its REAL token/cost numbers: the call happened and cost real
-- money even though the output was unusable — see src/lib/ai/runAiTask.ts.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id INTEGER PRIMARY KEY,
  task TEXT NOT NULL,
  provider TEXT,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL,
  error_category TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_log_task_time ON ai_usage_log(task, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_log_time ON ai_usage_log(created_at DESC);

-- Append-only suggestion lifecycle trail. Deliberately separate from job_status_history (that table
-- is the authoritative record of what actually happened to a job; this is the record of what AI
-- suggested and what a human decided, which may never become an authoritative fact at all). Every
-- event is tied to a real, already-generated enrichment row (a failed generation attempt has no
-- suggestion to have a lifecycle, and is instead fully captured by ai_usage_log's success=0 row —
-- see its comment above); this keeps ai_enrichment_id NOT NULL rather than nullable-with-no-other-
-- identifying-context. No ON DELETE CASCADE on purpose: an enrichment row is never deleted by this
-- infrastructure (see ai_enrichments' own comment), and if a future retention feature ever considers
-- pruning one, this FK (SQLite's default NO ACTION, with foreign_keys=ON already set in
-- src/db/index.ts) forces that delete to fail rather than silently destroying audit history — an
-- audit trail must outlive its subject, not cascade away with it.
CREATE TABLE IF NOT EXISTS ai_audit_log (
  id INTEGER PRIMARY KEY,
  ai_enrichment_id INTEGER NOT NULL REFERENCES ai_enrichments(id),
  event TEXT NOT NULL CHECK (event IN ('generated', 'shown', 'accepted', 'rejected', 'superseded', 'expired')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ordered by id, not created_at: SQLite's datetime('now') has only whole-second resolution, so
-- several events recorded in rapid succession can share an identical timestamp — id (autoincrement)
-- is the reliable ordering column, both here and in src/db/queries/aiAudit.ts's getAuditTrail.
CREATE INDEX IF NOT EXISTS idx_ai_audit_log_enrichment ON ai_audit_log(ai_enrichment_id, id DESC);

-- Phase 2 (see src/lib/match/): deterministic Job Eligibility + Candidate Matching + Explainable
-- Scoring + Tailoring Readiness. Two brand-new tables, not an ALTER of any existing one — safe via
-- plain CREATE TABLE IF NOT EXISTS on both a fresh install and an existing database, same as
-- settings/ai_enrichments above. Zero new AI tasks (V1 is 100% deterministic computation); nothing
-- here is written by or read by Phase 1's scan/dedupe/lifecycle/suppression/H1B/jobIntel pipeline.

-- One row per (dedupe_key, match_engine_version, match_knowledge_hash, candidate_profile_hash,
-- candidate_settings_hash, jd_content_hash) — immutable per that exact key, same "never updated,
-- identical inputs are always a cache hit" philosophy as ai_enrichments.
--
-- IDENTITY SAFETY: dedupe_key, not job_id, is authoritative here — same reasoning as
-- ai_enrichments' entity_key vs. entity_id (see that table's comment above). jobs.id lacks
-- AUTOINCREMENT and can be reused by an unrelated later row once the original job is deleted
-- (Not Interested / aged-out sweep). job_id below is therefore deliberately NOT a foreign key at
-- all — not even a non-cascading one: a FK (cascade or NO ACTION) would either destroy this match
-- history the moment the underlying job is deleted, or block that deletion outright, and Phase 2
-- must do neither (match history must survive Phase 1 job deletion; Phase 2 must never alter Phase
-- 1 deletion behavior). job_id is convenience/debug metadata only — every real lookup filters on
-- dedupe_key.
CREATE TABLE IF NOT EXISTS job_match_results (
  id INTEGER PRIMARY KEY,
  -- Phase 2.5: which candidate this result belongs to. Backfilled to 1 (Candidate #1) for every row
  -- that existed before multi-candidate support — see src/db/index.ts's migrateCandidateScoping.
  -- Deliberately no REFERENCES clause, same reasoning as job_id below: convenience/query-scoping
  -- metadata, not the source of correctness (candidate_profile_hash/candidate_settings_hash already
  -- differ per candidate in practice; this column exists so reads can filter directly instead of
  -- relying on hash non-collision).
  candidate_id INTEGER NOT NULL DEFAULT 1,
  dedupe_key TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  match_engine_version INTEGER NOT NULL,
  -- Automatic data-fingerprint hash (src/lib/match/matchKnowledgeHash.ts) over every purely-data
  -- matching constant (skill taxonomy, transferable-skill pairs, credit table, scoring weights,
  -- readiness thresholds, track profiles, hands-on cue regex) — invalidates the cache the moment
  -- any of those change, with no manual version-bump discipline required for data-only edits.
  match_knowledge_hash TEXT NOT NULL,
  -- data/candidates/<candidateId>/master/ manifest's resume+skills sha256 pair, combined
  -- (src/lib/match/candidateProfile.ts).
  candidate_profile_hash TEXT NOT NULL,
  -- Hash of Settings > Candidate (requiresSponsorship/clearance/etc.) at compute time — these are
  -- scoring-relevant facts too, independent of both the resume/skills files and the JD.
  candidate_settings_hash TEXT NOT NULL,
  jd_content_hash TEXT NOT NULL,
  eligibility_status TEXT NOT NULL, -- 'PASS' | 'BLOCKED' | 'UNKNOWN' — PASS means only "no known hard blocker"
  eligibility_reasons TEXT NOT NULL, -- JSON array of strings
  requirement_coverage REAL NOT NULL,
  overall_score REAL NOT NULL, -- honest weighted average, never capped/mutated after the fact
  employer_evidenced_share REAL NOT NULL,
  insufficient_jd_signal INTEGER NOT NULL DEFAULT 0,
  dimension_scores TEXT NOT NULL, -- JSON: {required,preferred,experience,seniority} each 0..100|null
  requirement_breakdown TEXT NOT NULL, -- JSON: employer/inventory/transferable/missing/unresolved buckets
  recommended_track TEXT NOT NULL,
  decision TEXT NOT NULL, -- 'BLOCKED' | 'NEEDS_REVIEW' | 'READY_FOR_TAILORING' — Phase 2's terminal state
  blocking_reasons TEXT NOT NULL, -- JSON array; empty iff decision = 'READY_FOR_TAILORING'
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'superseded' — bookkeeping only, same as ai_enrichments
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_job_match_results_key
  ON job_match_results(candidate_id, dedupe_key, match_engine_version, match_knowledge_hash, candidate_profile_hash, candidate_settings_hash, jd_content_hash);
-- Primary history-lookup path — by (candidate_id, dedupe_key), never by job_id (see IDENTITY SAFETY
-- above). candidate_id first so "this candidate's history for this job" is a single index seek.
CREATE INDEX IF NOT EXISTS idx_job_match_results_dedupe ON job_match_results(candidate_id, dedupe_key, created_at DESC);
-- Convenience/debug only — mirrors idx_ai_enrichments_entity_id_debug's reasoning exactly.
CREATE INDEX IF NOT EXISTS idx_job_match_results_job_id_debug ON job_match_results(job_id);

-- Batch-evaluation observability — one row per batch attempt, mirrors scan_runs' shape/reasoning.
-- Phase 2.5: candidate_id attributes a batch run to the one candidate it evaluated (batches are
-- always single-candidate — see forbidden cross-candidate batching note in evaluateJobMatch call
-- sites). Backfilled to 1 for pre-existing rows, same reasoning as job_match_results.candidate_id.
CREATE TABLE IF NOT EXISTS match_runs (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  jobs_evaluated INTEGER NOT NULL DEFAULT 0,
  jobs_blocked INTEGER NOT NULL DEFAULT 0,
  jobs_needs_review INTEGER NOT NULL DEFAULT 0,
  jobs_ready INTEGER NOT NULL DEFAULT 0,
  jobs_errored INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_match_runs_time ON match_runs(started_at DESC);

-- Phase 2.5 (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record): local multi-candidate support.
-- Companies/jobs/H1B/Job Intelligence remain fully shared/global — everything below scopes ONE
-- candidate's personal relationship to that shared data. Four brand-new tables, not an ALTER of any
-- existing one — safe via plain CREATE TABLE IF NOT EXISTS on both a fresh install and an existing
-- database, same precedent as settings/ai_enrichments/job_match_results above.

CREATE TABLE IF NOT EXISTS candidates (
  -- AUTOINCREMENT (unlike companies.id/jobs.id) so a candidate_id can never be reused even if a row
  -- is ever hard-deleted — this id is threaded into on-disk file paths and every candidate-scoped
  -- table below, so identity safety matters more here than it does for companies/jobs.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  -- 'active' | 'archived' — app-layer validated, no CHECK (same "taxonomy may grow" precedent as
  -- companies.source_type/jobs.pipeline_status).
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);

-- One row per candidate. Splits into two use cases enforced at the TypeScript layer (see
-- src/lib/match/candidateSettingsHash.ts's MatchAffectingCandidateSettings type), not by separate
-- tables:
--   MATCH-AFFECTING: requires_sponsorship/us_citizen/work_authorized_us/clearance_level — consumed
--     by src/lib/match/eligibility.ts and hashed into job_match_results.candidate_settings_hash.
--     Changing one of these legitimately invalidates cached Phase 2 match results.
--   RANKING-ONLY preferences: primary_target_role/secondary_target_roles/location_preference/
--     workplace_preference/employment_type_preference — consumed ONLY by the For You ranking layer
--     (src/lib/rank/forYou.ts), NEVER passed to computeCandidateSettingsHash or eligibility.ts.
--     Changing one of these must never invalidate a Phase 2 match result.
CREATE TABLE IF NOT EXISTS candidate_settings (
  candidate_id INTEGER PRIMARY KEY REFERENCES candidates(id),
  requires_sponsorship INTEGER NOT NULL DEFAULT 1,
  us_citizen INTEGER NOT NULL DEFAULT 0,
  work_authorized_us INTEGER NOT NULL DEFAULT 0,
  clearance_level TEXT NOT NULL DEFAULT 'None',
  primary_target_role TEXT,
  secondary_target_roles TEXT, -- JSON array of strings
  location_preference TEXT,
  workplace_preference TEXT, -- JSON array of strings, e.g. '["remote","hybrid"]'
  employment_type_preference TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Candidate-scoped "my relationship to this shared job" — see CAREER_OPS_HANDOFF.md's Phase 2.5
-- design record for the full field-by-field GLOBAL-vs-CANDIDATE-SPECIFIC classification (pipeline
-- status/pinned/marked_for_tailoring/notes/tags/not_interested are personal; is_active/is_archived/
-- posted_at/etc. on jobs itself stay global). Keyed on (candidate_id, dedupe_key), NOT job_id — same
-- identity-safety philosophy as job_match_results/suppressed_jobs: this row survives the underlying
-- job being deleted by the age-based sweep. Legacy jobs.pipeline_status/pinned/notes/tags/
-- marked_for_tailoring columns are NOT removed by this migration — they stay as a frozen, read-only
-- snapshot of Candidate #1's state at migration time; the application stops writing to them once
-- this table is live (see src/db/queries/candidateJobState.ts).
CREATE TABLE IF NOT EXISTS candidate_job_state (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  dedupe_key TEXT NOT NULL,
  pipeline_status TEXT NOT NULL DEFAULT 'New',
  pipeline_updated_at TEXT,
  marked_for_tailoring INTEGER NOT NULL DEFAULT 0,
  tailoring_marked_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  not_interested INTEGER NOT NULL DEFAULT 0,
  not_interested_at TEXT,
  not_interested_reason TEXT,
  notes TEXT,
  tags TEXT, -- JSON array of strings, same convention as the legacy jobs.tags column
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_job_state_key ON candidate_job_state(candidate_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_candidate_job_state_pipeline ON candidate_job_state(candidate_id, pipeline_status);
CREATE INDEX IF NOT EXISTS idx_candidate_job_state_not_interested ON candidate_job_state(candidate_id, not_interested);

-- Candidate-personal history split off job_status_history, which keeps recording ONLY 'lifecycle'
-- change_type rows going forward (a global job fact, untouched by this migration). Keyed on
-- (candidate_id, dedupe_key), not job_id, so it survives the underlying job's deletion —
-- job_status_history does not (it cascade-deletes with its job), which is correct for a global fact
-- but would have been wrong here.
CREATE TABLE IF NOT EXISTS candidate_job_state_history (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  dedupe_key TEXT NOT NULL,
  change_type TEXT NOT NULL CHECK (change_type IN ('pipeline_status', 'tailoring', 'pinned', 'not_interested')),
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_candidate_job_state_history_lookup
  ON candidate_job_state_history(candidate_id, dedupe_key, changed_at DESC);

-- Phase 4 Stage 4 — in-app candidate job-match notifications (see src/lib/notifications/). Keyed on
-- (candidate_id, dedupe_key), not job_id, same reasoning as candidate_job_state_history above: a
-- notification about a job must survive that job's later deletion (suppressed_jobs/age-sweep), and
-- dedupe_key is the stable identity throughout this schema, never job_id.
--
-- IDENTITY/DEDUP INVARIANT: UNIQUE(candidate_id, dedupe_key, type) is the load-bearing constraint —
-- even if notification-generation code accidentally runs twice for the same pair, a duplicate
-- notification is structurally impossible at the database level, not just prevented by application
-- logic (see createNotificationIfAbsent's INSERT ... ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  dedupe_key TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup ON notifications(candidate_id, dedupe_key, type);
CREATE INDEX IF NOT EXISTS idx_notifications_candidate_unread ON notifications(candidate_id, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_candidate_created ON notifications(candidate_id, created_at DESC);

-- H1B Employer Source Discovery + ATS Hardening (see src/lib/companyIdentity/). Three brand-new
-- tables plus additive companies columns (added via migration in src/db/index.ts, since companies
-- pre-dates this feature) — safe via plain CREATE TABLE IF NOT EXISTS on both a fresh install and
-- an existing database, same precedent as every other additive feature above.
--
-- CRITICAL BOUNDARY: nothing below this line is ever read by, written by, or allowed to influence
-- h1b_confidence/h1b_combined_confidence, src/lib/h1b/combineSignal.ts, Phase 2 eligibility, or any
-- job_match_results/candidate_settings_hash row. This is source/identity DISCOVERY only — where to
-- find a company's jobs — never sponsorship EVIDENCE. See employerIdentityResolutions.test.ts's
-- boundary regression test.

-- Curated employer -> official domain override — the highest-trust Layer 0 of the domain
-- resolution waterfall. Deliberately empty by default, never auto-seeded or hardcoded — same
-- precedent as h1b_employer_aliases above. A row here is a human-reviewed fact, not a guess.
CREATE TABLE IF NOT EXISTS h1b_employer_domain_overrides (
  id INTEGER PRIMARY KEY,
  employer_name_normalized TEXT NOT NULL,
  domain TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_h1b_employer_domain_overrides_name
  ON h1b_employer_domain_overrides(employer_name_normalized);

-- One row per h1b_sponsors.id — current-state table (latest attempt's outcome), mirroring
-- companies' own resolution_status/discovery_attempted_at pattern rather than an append-only log.
-- This is the SOURCE-DISCOVERY mapping from an H1B legal filer identity to a resolved public
-- company/domain — deliberately many-h1b_sponsors-rows-to-one-companies-row capable (a parent +
-- several subsidiary legal filers may share one resolved_company_id), and deliberately NEVER a
-- 1:1 identity merge. domain_identity_status is its own axis, fully independent of
-- companies.resolution_status (see that column's own comment below) — a company's official domain
-- can be VERIFIED while careers/ATS discovery for it is FAILED_TEMPORARY, and that is a valid,
-- expected, and common state, not a contradiction.
CREATE TABLE IF NOT EXISTS employer_identity_resolutions (
  id INTEGER PRIMARY KEY,
  h1b_sponsor_id INTEGER NOT NULL REFERENCES h1b_sponsors(id),
  -- Nullable: a FAILED_TEMPORARY/UNRESOLVED/AMBIGUOUS attempt has no resolved company yet.
  resolved_company_id INTEGER REFERENCES companies(id),
  -- 'VERIFIED' | 'AMBIGUOUS' | 'UNRESOLVED' | 'FAILED_TEMPORARY' — app-layer validated, no CHECK
  -- (same "taxonomy may grow" precedent as companies.source_type above).
  domain_identity_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  domain TEXT,
  -- 'curated' | 'wikidata' | 'sec_corroborated' | 'redirect_corroborated' |
  -- 'generated_verified_multisignal' | 'unresolved' — app-layer validated.
  resolution_method TEXT,
  -- 'high' | 'medium' | 'low' — Path A (authoritative) resolves at 'high', Path B (multi-signal
  -- first-party, no external registry) resolves at 'medium' by design; never higher, since it has
  -- a weaker evidentiary basis than an external registry hit. See verifyDomain.ts.
  resolution_confidence TEXT,
  -- JSON array of strings, e.g. '["jsonld_legalname_match","footer_copyright_match"]'.
  evidence TEXT,
  -- JSON object: {jsonLd, footer, aboutPage, termsPrivacyPage}, each 'match'|'no_match'|'conflict'|
  -- 'not_checked' — makes Path B's "≥2 distinct channels" rule independently auditable rather than
  -- trusting evidence's free-text strings to prove channel-distinctness. See verifyDomain.ts.
  channels_checked TEXT,
  -- Optional, additive snapshot of a careers/ATS discovery attempt against this row's domain — NEVER
  -- read by, and never a gate on, domain_identity_status above (see verifyDomain.ts's Step
  -- ordering). Purely a convenience cache so a future batch run doesn't have to re-run
  -- discoverCompanySource to know it was already attempted.
  careers_checked_at TEXT,
  careers_source_resolution_status TEXT,
  discovered_jobs_url TEXT,
  attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Set when domain_identity_status reaches a terminal outcome (VERIFIED/AMBIGUOUS/UNRESOLVED);
  -- left NULL for FAILED_TEMPORARY, which is retry-eligible rather than terminal.
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_employer_identity_resolutions_sponsor
  ON employer_identity_resolutions(h1b_sponsor_id);
CREATE INDEX IF NOT EXISTS idx_employer_identity_resolutions_status
  ON employer_identity_resolutions(domain_identity_status);
CREATE INDEX IF NOT EXISTS idx_employer_identity_resolutions_company
  ON employer_identity_resolutions(resolved_company_id);

-- Batch-level discovery observability — one row per bounded batch run (src/lib/discovery/batch.ts),
-- mirrors scan_runs'/match_runs' shape/reasoning exactly. Per-employer detail lives on
-- employer_identity_resolutions/companies themselves, not duplicated here.
CREATE TABLE IF NOT EXISTS discovery_runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  employers_attempted INTEGER NOT NULL DEFAULT 0,
  domains_verified INTEGER NOT NULL DEFAULT 0,
  domains_ambiguous INTEGER NOT NULL DEFAULT 0,
  domains_unresolved INTEGER NOT NULL DEFAULT 0,
  domains_failed_temporary INTEGER NOT NULL DEFAULT 0,
  careers_pages_resolved INTEGER NOT NULL DEFAULT 0,
  ats_verified INTEGER NOT NULL DEFAULT 0,
  needs_adapter INTEGER NOT NULL DEFAULT 0,
  source_unresolved INTEGER NOT NULL DEFAULT 0,
  source_failed_temporary INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE INDEX IF NOT EXISTS idx_discovery_runs_time ON discovery_runs(started_at DESC);

-- Phase 3 V1 — Tailoring Run Persistence (see the approved Phase 3 V1 architecture: tailoring
-- REASONING runs entirely in Claude Code or Codex via the repository-local /tailor-resume or
-- $tailor-resume skill and the shared deterministic engine at tools/tailoring-engine/ — no
-- Anthropic/OpenAI API involvement. This table is the application's own record of that work: it
-- never generates content and never calls an LLM itself.
--
-- IDENTITY: candidate_id + dedupe_key is the authoritative candidate/job relationship, same
-- philosophy as job_match_results/candidate_job_state (see their own IDENTITY SAFETY comments).
-- job_id is convenience/debug metadata only, deliberately NOT a foreign key — jobs.id lacks
-- AUTOINCREMENT and can be reused by an unrelated later row once the original job is deleted.
--
-- LIFECYCLE: two-phase, append-only per attempt — a row is created with status='started' the
-- moment a human approves tailoring (before Claude Code/Codex is even invoked), then updated
-- exactly once to 'completed' or 'failed'. A 'completed' row is never updated again afterward
-- (the application layer enforces this, not a DB constraint — see tailoringRuns.ts). This is what
-- gives "run 2 cannot overwrite run 1" its real meaning: each run's own row (and, in a later
-- stage, its own output directory keyed by this row's id) exists independently of every other run
-- for the same candidate/job.
--
-- APPROVAL PROVENANCE: approval_type/decision_at_approval are a PERMANENT COPY of
-- candidate_job_state.tailoring_approval_type/tailoring_approved_decision at the moment this run
-- was started — never re-derived later. If the candidate later un-marks and re-approves
-- differently, or Phase 2 re-evaluates and the decision changes, already-completed runs' recorded
-- provenance is untouched. This table never writes to job_match_results — Phase 2's decision stays
-- authoritative and immutable from this workflow.
--
-- No provider/model/API-token/API-cost columns — Phase 3 V1 does not call the Anthropic or OpenAI
-- APIs for tailoring at all; those fields would be speculative infrastructure for a capability
-- that doesn't exist yet, not real observability. Add them only if/when that changes.
CREATE TABLE IF NOT EXISTS tailoring_runs (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  dedupe_key TEXT NOT NULL,
  job_id INTEGER, -- convenience/debug only, never authoritative — see comment above

  -- Approval provenance (copied from candidate_job_state at the moment this run was started)
  approval_type TEXT NOT NULL, -- 'READY_DIRECT' | 'NEEDS_REVIEW_OVERRIDE' — app-layer validated
  decision_at_approval TEXT NOT NULL, -- 'READY_FOR_TAILORING' | 'NEEDS_REVIEW' (BLOCKED never reaches here)
  approved_at TEXT NOT NULL,

  -- Source-material provenance — exactly what this run was tailored against
  master_resume_hash TEXT,
  master_skills_hash TEXT,
  candidate_profile_hash TEXT,
  jd_content_hash TEXT,
  match_engine_version INTEGER,

  -- Track
  recommended_track TEXT, -- from job_match_results at run time
  selected_track TEXT, -- what the skill actually tailored toward

  -- System versioning (this project's own methodology/engine versions — not an LLM provider/model)
  methodology_version INTEGER,
  renderer_version INTEGER,

  executed_by TEXT, -- 'claude-code' | 'codex' — free text, app-layer validated, taxonomy may grow

  -- Outcome — NULL while status='started', set exactly once on completion or failure
  status TEXT NOT NULL DEFAULT 'started', -- 'started' | 'completed' | 'failed'
  job_fit_classification TEXT, -- 'STRONG APPLY' | 'APPLY' | 'STRETCH' | 'LOW MATCH'
  output_files TEXT, -- JSON array of filenames, set on completion
  validation_passed INTEGER, -- 0/1, set on completion
  failure_reason TEXT, -- set only if status='failed'

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tailoring_runs_candidate_dedupe ON tailoring_runs(candidate_id, dedupe_key, created_at DESC);

-- Phase 3 Stage 7 — foundation for a future multi-stage AI resume quality pipeline:
-- Application -> Tailoring Run -> AI Writer -> AI Reviewer -> Improvement -> Reviewer -> Final
-- Approved Resume. FOUNDATION ONLY: no row in either table below is ever written by an AI call in
-- this stage — nothing here executes a writer/reviewer, it only persists the state/data shape a
-- future orchestrator will populate.
--
-- APPLICATION IDENTITY: this project does not have (and Stage 7 deliberately does not invent) a
-- dedicated "applications" table. candidate_job_state already IS the durable, unique-per-
-- (candidate_id, dedupe_key) identity for "this candidate's relationship to this job" — its own
-- `id` is reused here as application_id rather than creating a second, competing concept. Every
-- tailoring_runs row already requires marked_for_tailoring=1 on that same candidate_job_state row
-- (see tailoringRuns.ts/tailoringExecution.ts), so a candidate_job_state row is guaranteed to exist
-- for every tailoring_run — application_id is never dangling.
--
-- HIERARCHY: candidates -> candidate_job_state (application) -> tailoring_runs (run) ->
-- resume_quality_workflows (one quality-improvement attempt over a run's output) ->
-- resume_quality_iterations (one immutable snapshot per improvement cycle, 1..max_iterations).
-- candidate_id/dedupe_key are denormalized onto both new tables (never derived only via a join),
-- matching job_match_results/candidate_job_state/tailoring_runs' own established identity-safety
-- discipline — every candidate-scoped query filters on candidate_id explicitly.
CREATE TABLE IF NOT EXISTS resume_quality_workflows (
  id INTEGER PRIMARY KEY,
  candidate_id INTEGER NOT NULL REFERENCES candidates(id),
  application_id INTEGER NOT NULL REFERENCES candidate_job_state(id),
  tailoring_run_id INTEGER NOT NULL REFERENCES tailoring_runs(id),
  dedupe_key TEXT NOT NULL, -- convenience/debug, mirrors tailoring_runs' own identity discipline

  -- CREATED | WRITER_RUNNING | WRITER_COMPLETED | REVIEW_RUNNING | REVIEW_COMPLETED |
  -- IMPROVEMENT_RUNNING | READY | FAILED — see src/lib/resumeQuality/stateMachine.ts for the legal
  -- transition graph between these; enforced at the query layer, not a DB CHECK/trigger.
  status TEXT NOT NULL DEFAULT 'CREATED',
  current_iteration INTEGER NOT NULL DEFAULT 0,
  max_iterations INTEGER NOT NULL DEFAULT 3,
  latest_overall_score REAL,
  final_approved_iteration INTEGER, -- set only once status reaches READY

  failure_reason TEXT, -- set only if status='FAILED' — includes the "max iterations reached, gate
                        -- still failing, human review required" case; there is no separate terminal
                        -- status for that case, by design (see the Stage 7 spec's fixed 8-status list)

  -- Provider/model metadata — deliberately generic (no Anthropic/OpenAI-specific columns or CHECK
  -- constraints). NULL until a future stage actually wires an agent implementation.
  writer_provider TEXT,
  writer_model TEXT,
  reviewer_provider TEXT,
  reviewer_model TEXT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_resume_quality_workflows_candidate_run
  ON resume_quality_workflows(candidate_id, tailoring_run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resume_quality_workflows_application
  ON resume_quality_workflows(candidate_id, application_id);

-- One immutable row per completed improvement cycle. "Immutable" is enforced at the query layer
-- (resumeQualityWorkflows.ts's createResumeQualityIteration only ever INSERTs, never UPDATEs an
-- existing iteration_number) plus the UNIQUE constraint below as a second, DB-level guarantee —
-- iteration 2 can never overwrite iteration 1's row.
CREATE TABLE IF NOT EXISTS resume_quality_iterations (
  id INTEGER PRIMARY KEY,
  workflow_id INTEGER NOT NULL REFERENCES resume_quality_workflows(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id), -- denormalized, same discipline as above
  iteration_number INTEGER NOT NULL, -- 1, 2, 3 (default max) — never 0, never reused within a workflow

  output_files TEXT, -- JSON array of relative filenames only (e.g. ["Resume.docx","CoverLetter.docx",
                      -- "review.json","review_feedback.md"]) — same portability contract as
                      -- tailoring_runs.output_files; never an absolute path.
  review_json TEXT,   -- full StructuredResumeReview (src/lib/resumeQuality/types.ts), authoritative

  -- Denormalized from review_json for cheap gate-checking without JSON parsing — mirrors
  -- job_match_results' own "dedicated columns for gate-relevant scalars, full detail in one JSON
  -- bucket" convention.
  overall_score REAL,
  ats_score REAL,
  keyword_alignment_score REAL,
  truthfulness_score REAL,
  architecture_consistency_score REAL,
  recruiter_readability_score REAL,
  formatting_score REAL,
  blocking_issue_count INTEGER NOT NULL DEFAULT 0,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(workflow_id, iteration_number)
);

CREATE INDEX IF NOT EXISTS idx_resume_quality_iterations_workflow
  ON resume_quality_iterations(candidate_id, workflow_id, iteration_number);

-- Discovery V2 Stage 3: durable source-replacement proposals, review/approval workflow. Deliberately
-- its own table rather than reusing job_source_validation_runs — that table's "latest row per
-- job_source" read pattern (see listGenericAdditiveReadyCompanies in organizationRegistry.ts) treats
-- ANY new row as the current authoritative validation state for a career_link source, so writing a
-- shadow/proposal row there could silently break a real, currently-additive-loading company. A
-- proposal here is evidence about a CANDIDATE replacement source, never itself production
-- validation state, and never applied automatically (see the approval service in companies.ts /
-- atsSourceProposals.ts) — approval is a separate, explicit, human-triggered action that then reuses
-- the existing recordDiscoveryResult/reviewJobSource machinery, the same functions any other
-- discovery result goes through.
CREATE TABLE IF NOT EXISTS ats_source_proposals (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_source_id INTEGER REFERENCES job_sources(id) ON DELETE CASCADE,
  -- Snapshot of the company's source identity AT THE MOMENT this proposal was created — the
  -- staleness/supersession check (see the approval service) compares this against the company's
  -- LIVE source_type/ats_board_token at approval time; a mismatch means the source changed after
  -- this proposal was created and the proposal must not be approved as-is.
  current_source_type TEXT,
  current_board_token TEXT,
  proposed_source_type TEXT NOT NULL,
  proposed_board_token TEXT NOT NULL,
  proposed_canonical_url TEXT,
  -- Mirrors DiscoveryV2Candidate's own confidence/validationStatus/recommendation exactly — no new
  -- vocabulary invented here.
  confidence TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  discovery_source TEXT NOT NULL DEFAULT 'discovery_v2',
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW', -- PENDING_REVIEW | APPROVED | REJECTED | SUPERSEDED
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  review_note TEXT
);

-- Only one PENDING_REVIEW row may exist for the same (company, exact candidate identity) at once —
-- a repeated identical Discovery V2 result must not spam duplicate pending rows. Historical
-- APPROVED/REJECTED/SUPERSEDED rows for the same identity are unrestricted (audit trail).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ats_source_proposals_pending_identity
  ON ats_source_proposals(company_id, proposed_source_type, proposed_board_token)
  WHERE status = 'PENDING_REVIEW';

CREATE INDEX IF NOT EXISTS idx_ats_source_proposals_company
  ON ats_source_proposals(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ats_source_proposals_status
  ON ats_source_proposals(status, created_at DESC);

-- Stage 7 — external hiring-signal observations (Google Jobs, Indeed, future sources). This table is
-- a STAGING/EVIDENCE layer only: a row here is never itself an authoritative CareerOps job. It exists
-- to answer "does external evidence suggest company X is hiring, and does CareerOps already reflect
-- that?" — see src/lib/externalSignals/ for the full pipeline that reads/writes this table.
--
-- Deliberately NOT reusing organization_source_discovery_attempts (that table logs CareerOps' OWN
-- discovery passes — pass_type/result_status against a company already being investigated) or
-- ats_source_proposals (that table is a proposed SOURCE REPLACEMENT with its own approval lifecycle).
-- An external listing is neither: it's raw third-party evidence about a job, most of which will never
-- become a proposal or a CareerOps job at all. A dedicated table keeps that evidence's own lifecycle
-- (dedup, TTL/expiry, agency/quality classification) from leaking into either existing table's schema
-- or invariants.
--
-- resulting_job_id is set only for the rare, explicitly-bounded case where this observation was
-- actually staged into `jobs` as a secondary-sourced row (source_type='google_jobs'/'indeed' — see
-- src/lib/externalSignals/secondaryIngestion.ts). Most rows never reach that point; they stop at
-- DISCOVERY_BEACON_ONLY (feeding the Discovery V2 bridge) or an earlier rejection decision.
CREATE TABLE IF NOT EXISTS external_hiring_observations (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL, -- 'google_jobs' | 'indeed' (future: 'linkedin' | 'dice' | ...)
  provider_job_id TEXT, -- stable external listing ID, when the provider supplies one
  -- Deterministic dedup key: provider_job_id when available, else a hash of
  -- employer+title+location+listing_url. Computed once at normalization time, never recomputed —
  -- see src/lib/externalSignals/normalize.ts's fingerprintFor().
  fingerprint TEXT NOT NULL,
  observed_employer_name TEXT NOT NULL,
  observed_title TEXT NOT NULL,
  observed_location TEXT,
  observed_url TEXT NOT NULL,
  direct_employer_url TEXT,
  direct_apply_url TEXT,
  employer_domain TEXT,
  posted_at TEXT,
  matched_company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  -- Strongest evidence tier that produced (or failed to produce) matched_company_id — see
  -- src/lib/externalSignals/companyMatch.ts. 'DOMAIN' | 'ALIAS' | 'NAME' | 'AMBIGUOUS' | 'UNMATCHED'.
  match_confidence TEXT NOT NULL DEFAULT 'UNMATCHED',
  -- 'DIRECT_EMPLOYER' | 'STAFFING_AGENCY' | 'UNKNOWN_EMPLOYER_RELATIONSHIP' — see
  -- src/lib/externalSignals/classify.ts. Conservative: uncertain cases stay UNKNOWN, never guessed.
  employer_relationship TEXT NOT NULL DEFAULT 'UNKNOWN_EMPLOYER_RELATIONSHIP',
  -- 'DIRECT_ATS' | 'GENERIC_EMPLOYER' | 'AGGREGATOR_ONLY' | 'UNKNOWN' — reuses
  -- detectAtsFromUrlString (src/lib/ats/detect.ts), never a second detector.
  url_classification TEXT NOT NULL DEFAULT 'UNKNOWN',
  detected_ats_provider TEXT,
  detected_ats_board_token TEXT,
  -- NO_SIGNAL | EXTERNAL_HIRING_SIGNAL | DIRECT_ATS_SIGNAL | COVERAGE_MISMATCH | ALREADY_COVERED |
  -- AGENCY_FILTERED | AMBIGUOUS | EXPIRED
  signal_classification TEXT NOT NULL DEFAULT 'NO_SIGNAL',
  -- OFFICIAL_EQUIVALENT_FOUND | SECONDARY_JOB_CANDIDATE | DUPLICATE_EXTERNAL | STAFFING_AGENCY |
  -- AMBIGUOUS_EMPLOYER | NON_US | LOW_QUALITY | STALE | INVALID | DISCOVERY_BEACON_ONLY
  decision TEXT NOT NULL DEFAULT 'DISCOVERY_BEACON_ONLY',
  resulting_job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE | EXPIRED | SUPERSEDED
  first_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Repeated sightings of the same listing refresh last_observed_at/expires_at in place rather than
-- creating unlimited duplicate rows — see upsertExternalHiringObservation.
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_hiring_observations_fingerprint
  ON external_hiring_observations(source, fingerprint);
CREATE INDEX IF NOT EXISTS idx_external_hiring_observations_company
  ON external_hiring_observations(matched_company_id, decision);
CREATE INDEX IF NOT EXISTS idx_external_hiring_observations_signal
  ON external_hiring_observations(signal_classification, status);
CREATE INDEX IF NOT EXISTS idx_external_hiring_observations_expiry
  ON external_hiring_observations(status, expires_at);
