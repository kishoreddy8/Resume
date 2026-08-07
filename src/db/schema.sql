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
  pipeline_status TEXT NOT NULL DEFAULT 'New'
    CHECK (pipeline_status IN ('New','Interested','Applied','Interview','Rejected','Offer')),
  pipeline_updated_at TEXT,
  marked_for_tailoring INTEGER NOT NULL DEFAULT 0,
  tailoring_marked_at TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe ON jobs(dedupe_key);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_pipeline ON jobs(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_jobs_h1b ON jobs(h1b_combined_signal);
CREATE INDEX IF NOT EXISTS idx_jobs_active ON jobs(is_active);

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
