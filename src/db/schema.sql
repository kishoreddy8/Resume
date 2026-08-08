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
  h1b_match_employer_name TEXT,
  h1b_match_score REAL,
  h1b_signal TEXT NOT NULL DEFAULT 'Unknown' CHECK (h1b_signal IN ('High','Medium','Low','Unknown')),
  h1b_lca_count INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT,
  last_scan_status TEXT,
  last_scan_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_ats
  ON companies(source_type, ats_board_token) WHERE ats_board_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_career_url
  ON companies(career_page_url) WHERE career_page_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_active ON companies(is_active);

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
  h1b_combined_signal TEXT NOT NULL DEFAULT 'Unknown'
    CHECK (h1b_combined_signal IN ('High','Medium','Low','Unknown','Likely','Unlikely')),
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
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline ON jobs(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_jobs_h1b ON jobs(h1b_combined_signal);
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
