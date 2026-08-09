/**
 * Curated, human-approved cross-category transferable-skill mappings — the ONLY source of a
 * TRANSFERABLE match verdict in V1 (Phase 2 Revision 3 §4 / Revision 4 §4). There is deliberately
 * NO same-category auto-transfer rule: same category alone is not sufficient evidence that a
 * candidate's skill genuinely transfers to a missing requirement.
 *
 * Ships EMPTY by design — no Databricks->Snowflake, Snowflake->dbt, Terraform, or any other
 * ecosystem-adjacency pair is seeded here. Populating this list is a deliberate, separate,
 * human-approved decision for a later revision, one curated entry at a time — same discipline as
 * src/db/schema.sql's h1b_employer_aliases table (approved aliases are curated, never hardcoded or
 * auto-generated, so this tier never introduces a false positive on its own).
 *
 * `from`/`to` are directional — a `from: X, to: Y` entry does NOT imply the reverse also holds
 * unless a separate `from: Y, to: X` entry is added.
 */

export interface TransferablePair {
  from: string; // canonical skill the candidate has (employer or inventory)
  to: string; // canonical skill the JD requires
  strength: "strong" | "moderate";
  reason: string; // shown verbatim in the UI breakdown
}

export const TRANSFERABLE_SKILLS: TransferablePair[] = [];

/** `pairs` defaults to the real, shipped (empty) list — production code never overrides it. Tests
 *  pass FIXTURE_TRANSFERABLE_PAIRS to exercise the TRANSFERABLE path without seeding a real mapping. */
export function findTransferablePair(
  candidateCanonicalSkills: string[],
  requiredCanonicalSkill: string,
  pairs: TransferablePair[] = TRANSFERABLE_SKILLS
): TransferablePair | null {
  for (const pair of pairs) {
    if (pair.to === requiredCanonicalSkill && candidateCanonicalSkills.includes(pair.from)) {
      return pair;
    }
  }
  return null;
}
