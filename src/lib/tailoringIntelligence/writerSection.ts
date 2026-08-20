import type { TailoringPlan } from "./plan";

/**
 * The one piece of Tailoring Intelligence the writer prompt does not already carry.
 *
 * WHY SO NARROW. The handoff already embeds the JD Priority Matrix (requirements, tiers and
 * evidence strength), the positioning recommendation, the recommended skill order, the ATS coverage
 * report and the full per-employer evidence map. Repeating any of that here would inflate the
 * prompt and, worse, create a second statement of the same facts that could drift from the first.
 *
 * What is genuinely missing is job-specific ORDER: the employer map says what each employer
 * supports in general, and the priority matrix says what this job wants, but nothing tells the
 * writer which roles carry the most weight for THIS posting. That is what this adds — a count of
 * overlap, nothing else.
 *
 * ADDITIVE BY CONSTRUCTION. Returns "" when there is no ranking worth stating, and the caller
 * passes it as an optional field, so a package built without it is byte-for-byte what it was
 * before. It grants the writer no new latitude: it names only employers and requirements that are
 * already established evidence, and it cannot introduce an employer, skill, project or year.
 */
export function renderExperienceEmphasisSection(plan: TailoringPlan): string {
  const ranked = plan.employerEmphasis.filter((e) => e.overlapping.length > 0);
  if (ranked.length === 0) return "";

  let out = "## EXPERIENCE EMPHASIS FOR THIS POSTING — WHICH ROLES CARRY THE MOST WEIGHT\n\n";
  out +=
    "Ordered by how many of THIS job's evidenced requirements each role's own evidence already " +
    "supports. This is a count over the match engine's output, not a judgement about the role and " +
    "not a licence to expand one: every technology named below is already attributed to that " +
    "employer in the candidate's own resume. Give the higher-overlap roles the fuller treatment; " +
    "do not delete or diminish the others, and do not move evidence between them.\n\n";

  ranked.forEach((e, i) => {
    out += `${i + 1}. **${e.employer}** — ${e.title}\n`;
    out += `   - Supports ${e.overlapping.length} of this posting's requirements: ${e.overlapping.join(", ")}\n`;
  });

  const noOverlap = plan.employerEmphasis.filter((e) => e.overlapping.length === 0);
  if (noOverlap.length > 0) {
    out +=
      `\nRoles supporting none of this posting's stated requirements: ` +
      `${noOverlap.map((e) => e.employer).join(", ")}. Keep them factual and brief; there is no ` +
      `evidence basis for leading with them here.\n`;
  }

  if (plan.doNotClaim.length > 0) {
    out +=
      `\n**Requirements with NO supporting evidence anywhere in this candidate's documents — never ` +
      `claim these, at any employer:** ${plan.doNotClaim.map((r) => r.label).join(", ")}\n`;
  }

  return out;
}
