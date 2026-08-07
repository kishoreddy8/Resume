import { getDb } from "@/db";
import type { H1bSponsor } from "@/types";

export function findCandidateSponsors(normalizedPrefix: string, limit = 25): H1bSponsor[] {
  return getDb()
    .prepare(
      `SELECT * FROM h1b_sponsors WHERE employer_name_normalized LIKE @prefix
       ORDER BY total_lca_certified DESC LIMIT @limit`
    )
    .all({ prefix: `${normalizedPrefix}%`, limit }) as H1bSponsor[];
}

export function upsertSponsor(sponsor: {
  employerNameRaw: string;
  employerNameNormalized: string;
  certified: number;
  denied: number;
  withdrawn: number;
  fiscalYear: number;
  sourceFile: string;
}): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM h1b_sponsors WHERE employer_name_normalized = ?")
    .get(sponsor.employerNameNormalized) as H1bSponsor | undefined;

  if (existing) {
    const years = new Set((existing.fiscal_years_covered ?? "").split(",").filter(Boolean));
    years.add(String(sponsor.fiscalYear));
    db.prepare(
      `UPDATE h1b_sponsors SET
        total_lca_certified = total_lca_certified + @certified,
        total_lca_denied = total_lca_denied + @denied,
        total_lca_withdrawn = total_lca_withdrawn + @withdrawn,
        fiscal_years_covered = @years,
        most_recent_fiscal_year = MAX(most_recent_fiscal_year, @fiscalYear),
        source_file = @sourceFile
       WHERE id = @id`
    ).run({
      id: existing.id,
      certified: sponsor.certified,
      denied: sponsor.denied,
      withdrawn: sponsor.withdrawn,
      years: Array.from(years).join(","),
      fiscalYear: sponsor.fiscalYear,
      sourceFile: sponsor.sourceFile,
    });
  } else {
    db.prepare(
      `INSERT INTO h1b_sponsors (
        employer_name_raw, employer_name_normalized, total_lca_certified,
        total_lca_denied, total_lca_withdrawn, fiscal_years_covered,
        most_recent_fiscal_year, source_file
      ) VALUES (
        @employerNameRaw, @employerNameNormalized, @certified,
        @denied, @withdrawn, @years, @fiscalYear, @sourceFile
      )`
    ).run({
      employerNameRaw: sponsor.employerNameRaw,
      employerNameNormalized: sponsor.employerNameNormalized,
      certified: sponsor.certified,
      denied: sponsor.denied,
      withdrawn: sponsor.withdrawn,
      years: String(sponsor.fiscalYear),
      fiscalYear: sponsor.fiscalYear,
      sourceFile: sponsor.sourceFile,
    });
  }
}

export function countSponsors(): number {
  return (
    getDb().prepare("SELECT COUNT(*) as count FROM h1b_sponsors").get() as { count: number }
  ).count;
}
