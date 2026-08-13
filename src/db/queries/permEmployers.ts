import { getDb } from "@/db";

export interface PermEmployerFilingInput {
  employerNameRaw: string;
  employerNameNormalized: string;
  fiscalYear: number;
  datasetVariant: string;
  certified: number;
  denied: number;
  withdrawn: number;
  sourceFile: string;
}

/** Replaces one official employer/year/form-dataset aggregate, making repeat imports safe. */
export function upsertPermEmployerFiling(filing: PermEmployerFilingInput): void {
  getDb()
    .prepare(
      `INSERT INTO perm_employer_filings (
         employer_name_raw, employer_name_normalized, fiscal_year, dataset_variant,
         certified, denied, withdrawn, source_file
       ) VALUES (
         @employerNameRaw, @employerNameNormalized, @fiscalYear, @datasetVariant,
         @certified, @denied, @withdrawn, @sourceFile
       )
       ON CONFLICT(employer_name_normalized, fiscal_year, dataset_variant) DO UPDATE SET
         employer_name_raw = excluded.employer_name_raw,
         certified = excluded.certified,
         denied = excluded.denied,
         withdrawn = excluded.withdrawn,
         source_file = excluded.source_file,
         ingested_at = datetime('now')`
    )
    .run(filing);
}

/** Fully rebuilds the read-optimized employer rollup from the durable filing aggregates. */
export function recomputeAllPermEmployerSummaries(): void {
  getDb().exec(`
    INSERT INTO perm_employers (
      employer_name_raw, employer_name_normalized, total_certified, total_denied,
      total_withdrawn, fiscal_years_covered, most_recent_fiscal_year, source_file, ingested_at
    )
    SELECT
      (SELECT f2.employer_name_raw FROM perm_employer_filings f2
       WHERE f2.employer_name_normalized = f.employer_name_normalized
       ORDER BY f2.fiscal_year DESC, f2.dataset_variant DESC LIMIT 1),
      f.employer_name_normalized,
      SUM(f.certified),
      SUM(f.denied),
      SUM(f.withdrawn),
      GROUP_CONCAT(DISTINCT f.fiscal_year),
      MAX(f.fiscal_year),
      (SELECT f3.source_file FROM perm_employer_filings f3
       WHERE f3.employer_name_normalized = f.employer_name_normalized
       ORDER BY f3.fiscal_year DESC, f3.dataset_variant DESC LIMIT 1),
      datetime('now')
    FROM perm_employer_filings f
    GROUP BY f.employer_name_normalized
    ON CONFLICT(employer_name_normalized) DO UPDATE SET
      employer_name_raw = excluded.employer_name_raw,
      total_certified = excluded.total_certified,
      total_denied = excluded.total_denied,
      total_withdrawn = excluded.total_withdrawn,
      fiscal_years_covered = excluded.fiscal_years_covered,
      most_recent_fiscal_year = excluded.most_recent_fiscal_year,
      source_file = excluded.source_file,
      ingested_at = excluded.ingested_at
  `);
}

export function countPermEmployers(): number {
  return (getDb().prepare("SELECT COUNT(*) AS count FROM perm_employers").get() as { count: number })
    .count;
}

export function countPermEmployerFilings(): number {
  return (
    getDb().prepare("SELECT COUNT(*) AS count FROM perm_employer_filings").get() as { count: number }
  ).count;
}
