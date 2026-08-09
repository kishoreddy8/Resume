import { getDb } from "@/db";
import type { H1bEmployerDomainOverride } from "@/types";

/**
 * Query layer for h1b_employer_domain_overrides — Layer 0 of the domain-resolution waterfall
 * (src/lib/companyIdentity/resolveDomain.ts). Mirrors src/db/queries/h1bSponsors.ts's alias
 * functions (findAliasTarget/listAliases/addAlias/removeAlias) exactly, same curated/never-
 * auto-seeded precedent — a row here is a human-reviewed fact, not a guess.
 */

export function findDomainOverride(employerNameNormalized: string): H1bEmployerDomainOverride | undefined {
  return getDb()
    .prepare("SELECT * FROM h1b_employer_domain_overrides WHERE employer_name_normalized = ?")
    .get(employerNameNormalized) as H1bEmployerDomainOverride | undefined;
}

export function listDomainOverrides(): H1bEmployerDomainOverride[] {
  return getDb()
    .prepare("SELECT * FROM h1b_employer_domain_overrides ORDER BY employer_name_normalized")
    .all() as H1bEmployerDomainOverride[];
}

/** Curates an approved override (never called with hardcoded companies by this project's own
 *  code — a deliberate manual/admin action). Upserts on employer_name_normalized so re-approving
 *  the same override with an updated domain/notes is safe to call repeatedly. */
export function addDomainOverride(input: {
  employerNameNormalized: string;
  domain: string;
  notes?: string | null;
}): H1bEmployerDomainOverride {
  const db = getDb();
  db.prepare(
    `INSERT INTO h1b_employer_domain_overrides (employer_name_normalized, domain, notes)
     VALUES (@employerNameNormalized, @domain, @notes)
     ON CONFLICT(employer_name_normalized) DO UPDATE SET
       domain = excluded.domain,
       notes = excluded.notes`
  ).run({
    employerNameNormalized: input.employerNameNormalized,
    domain: input.domain,
    notes: input.notes ?? null,
  });
  return findDomainOverride(input.employerNameNormalized)!;
}

export function removeDomainOverride(employerNameNormalized: string): void {
  getDb().prepare("DELETE FROM h1b_employer_domain_overrides WHERE employer_name_normalized = ?").run(employerNameNormalized);
}
