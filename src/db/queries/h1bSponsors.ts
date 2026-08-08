import { getDb } from "@/db";
import type { H1bEmployerAlias, H1bSponsor, H1bSponsorFiling } from "@/types";

// --- Matching lookups (read path) ----------------------------------------------------------

/** Tier 1 of the layered matcher: O(1) exact lookup via the unique index on employer_name_normalized. */
export function findSponsorByNormalizedName(normalized: string): H1bSponsor | undefined {
  return getDb()
    .prepare("SELECT * FROM h1b_sponsors WHERE employer_name_normalized = ?")
    .get(normalized) as H1bSponsor | undefined;
}

/**
 * Tier 3 candidate set: an indexed prefix narrowing, left to fuzzball to actually rank.
 *
 * Uses GLOB, not LIKE, on purpose — verified against the real ~45k-row imported dataset, not just
 * assumed: SQLite's query planner will NOT use an index for a prefix LIKE unless
 * `PRAGMA case_sensitive_like` is on (LIKE is case-insensitive by default, GLOB is always
 * case-sensitive), and turning that pragma on globally would silently make the unrelated jobs
 * search feature (LIKE-based, in src/db/queries/jobs.ts) case-sensitive too — a real regression to
 * working, unrelated functionality. GLOB is safe here specifically because
 * employer_name_normalized is guaranteed uppercase-ASCII-only by normalizeEmployerName (which
 * strips every non-alphanumeric character, so a normalized prefix can never contain a GLOB
 * metacharacter like * ? [ ] that would need escaping). Measured: ~55ms full table scan (LIKE) vs
 * <1ms indexed seek (GLOB) against the real dataset.
 */
export function findCandidateSponsorsByPrefix(normalizedPrefix: string, limit = 50): H1bSponsor[] {
  return getDb()
    .prepare(
      `SELECT * FROM h1b_sponsors WHERE employer_name_normalized GLOB @prefix
       ORDER BY total_lca_certified DESC LIMIT @limit`
    )
    .all({ prefix: `${normalizedPrefix}*`, limit }) as H1bSponsor[];
}

/** Tier 2: resolves an approved alias to the normalized identity it should match against, or null
 *  if no alias is on file for this exact normalized name. */
export function findAliasTarget(aliasNormalized: string): string | null {
  const row = getDb()
    .prepare("SELECT employer_name_normalized FROM h1b_employer_aliases WHERE alias_normalized = ?")
    .get(aliasNormalized) as { employer_name_normalized: string } | undefined;
  return row?.employer_name_normalized ?? null;
}

export function listAliases(): H1bEmployerAlias[] {
  return getDb()
    .prepare("SELECT * FROM h1b_employer_aliases ORDER BY alias_normalized")
    .all() as H1bEmployerAlias[];
}

/** Curates an approved alias (never called with hardcoded companies by this project's own code —
 *  a deliberate manual/admin action). Upserts on (alias_normalized) so re-approving the same alias
 *  with updated notes/target is safe to call repeatedly. */
export function addAlias(input: {
  aliasNormalized: string;
  employerNameNormalized: string;
  notes?: string | null;
}): H1bEmployerAlias {
  const db = getDb();
  db.prepare(
    `INSERT INTO h1b_employer_aliases (alias_normalized, employer_name_normalized, notes)
     VALUES (@aliasNormalized, @employerNameNormalized, @notes)
     ON CONFLICT(alias_normalized) DO UPDATE SET
       employer_name_normalized = excluded.employer_name_normalized,
       notes = excluded.notes`
  ).run({
    aliasNormalized: input.aliasNormalized,
    employerNameNormalized: input.employerNameNormalized,
    notes: input.notes ?? null,
  });
  return db
    .prepare("SELECT * FROM h1b_employer_aliases WHERE alias_normalized = ?")
    .get(input.aliasNormalized) as H1bEmployerAlias;
}

export function removeAlias(aliasNormalized: string): void {
  getDb().prepare("DELETE FROM h1b_employer_aliases WHERE alias_normalized = ?").run(aliasNormalized);
}

// --- Ingestion (write path) ------------------------------------------------------------------

/**
 * Idempotent, incremental per-(employer, fiscal year) upsert — the durable source of truth
 * scripts/ingest-h1b.ts writes to. Re-ingesting the same fiscal year's file REPLACES that year's
 * certified/denied/withdrawn counts (not additive), so re-running an import is always safe;
 * ingesting a *different* fiscal year for the same employer is a genuine incremental update.
 * Does NOT touch h1b_sponsors itself — call recomputeAllSponsorSummaries() after a batch of these.
 */
export function upsertSponsorFiling(filing: {
  employerNameRaw: string;
  employerNameNormalized: string;
  fiscalYear: number;
  certified: number;
  denied: number;
  withdrawn: number;
  sourceFile: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO h1b_sponsor_filings (
        employer_name_raw, employer_name_normalized, fiscal_year, certified, denied, withdrawn, source_file
      ) VALUES (
        @employerNameRaw, @employerNameNormalized, @fiscalYear, @certified, @denied, @withdrawn, @sourceFile
      )
      ON CONFLICT(employer_name_normalized, fiscal_year) DO UPDATE SET
        employer_name_raw = excluded.employer_name_raw,
        certified = excluded.certified,
        denied = excluded.denied,
        withdrawn = excluded.withdrawn,
        source_file = excluded.source_file,
        ingested_at = datetime('now')`
    )
    .run(filing);
}

/**
 * Recomputes every employer's h1b_sponsors rollup from h1b_sponsor_filings in one bulk statement —
 * SUM across every fiscal year on file per employer, MAX for the most recent year, the raw display
 * name taken from that most-recent year's filing. Correct after any ingest (full or incremental)
 * and fully idempotent; deliberately a single set-based SQL statement rather than one recompute per
 * affected employer — a DOL disclosure file can cover hundreds of thousands of unique employers, so
 * looping per-employer in JS would be far slower for no benefit (this is a batch import script, not
 * a hot request path, so "recompute everyone" is simpler and fast enough rather than tracking which
 * specific employers changed).
 */
export function recomputeAllSponsorSummaries(): void {
  getDb().exec(`
    INSERT INTO h1b_sponsors (
      employer_name_raw, employer_name_normalized, total_lca_certified, total_lca_denied,
      total_lca_withdrawn, fiscal_years_covered, most_recent_fiscal_year, source_file, ingested_at
    )
    SELECT
      (SELECT f2.employer_name_raw FROM h1b_sponsor_filings f2
       WHERE f2.employer_name_normalized = f.employer_name_normalized
       ORDER BY f2.fiscal_year DESC LIMIT 1),
      f.employer_name_normalized,
      SUM(f.certified),
      SUM(f.denied),
      SUM(f.withdrawn),
      GROUP_CONCAT(DISTINCT f.fiscal_year),
      MAX(f.fiscal_year),
      (SELECT f3.source_file FROM h1b_sponsor_filings f3
       WHERE f3.employer_name_normalized = f.employer_name_normalized
       ORDER BY f3.fiscal_year DESC LIMIT 1),
      datetime('now')
    FROM h1b_sponsor_filings f
    GROUP BY f.employer_name_normalized
    ON CONFLICT(employer_name_normalized) DO UPDATE SET
      employer_name_raw = excluded.employer_name_raw,
      total_lca_certified = excluded.total_lca_certified,
      total_lca_denied = excluded.total_lca_denied,
      total_lca_withdrawn = excluded.total_lca_withdrawn,
      fiscal_years_covered = excluded.fiscal_years_covered,
      most_recent_fiscal_year = excluded.most_recent_fiscal_year,
      source_file = excluded.source_file,
      ingested_at = excluded.ingested_at
  `);
}

export function countSponsors(): number {
  return (
    getDb().prepare("SELECT COUNT(*) as count FROM h1b_sponsors").get() as { count: number }
  ).count;
}

export function countFilings(): number {
  return (
    getDb().prepare("SELECT COUNT(*) as count FROM h1b_sponsor_filings").get() as { count: number }
  ).count;
}

/** Every filing on record for one normalized employer, most recent fiscal year first — the
 *  "H1B history" breakdown for a company profile. */
export function getFilingsForEmployer(normalized: string): H1bSponsorFiling[] {
  return getDb()
    .prepare("SELECT * FROM h1b_sponsor_filings WHERE employer_name_normalized = ? ORDER BY fiscal_year DESC")
    .all(normalized) as H1bSponsorFiling[];
}
