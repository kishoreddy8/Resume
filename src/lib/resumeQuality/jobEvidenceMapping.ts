import type { CandidateAccomplishmentPackage, AccomplishmentUnit } from "./accomplishmentEvidence";
import type { WriterJobIntent } from "./jobIntent";

export interface JdToEvidenceMatch {
  jdPriority: string;
  requirementCriticality: string;
  candidateEvidenceId: string;
  candidateEvidenceText: string;
  employer: string;
  matchStrength: "HIGH" | "MEDIUM" | "SUPPORTING";
  matchReason: string;
}

export interface JdEvidenceMappingResult {
  mappings: JdToEvidenceMatch[];
  unmappedRequirements: string[];
}

/**
 * Deterministically maps structured JD priorities to candidate's verified accomplishment units.
 */
export function mapJdPrioritiesToCandidateEvidence(params: {
  jobIntent: WriterJobIntent;
  accomplishmentPackage: CandidateAccomplishmentPackage;
}): JdEvidenceMappingResult {
  const { jobIntent, accomplishmentPackage } = params;

  const allAccomplishments: AccomplishmentUnit[] = accomplishmentPackage.employers.flatMap(
    (e) => e.verifiedAccomplishments
  );

  const targetPriorities = [
    ...jobIntent.criticalCapabilities.map((c) => ({ name: c.name, criticality: "CRITICAL" })),
    ...jobIntent.requiredCapabilities.map((c) => ({ name: c.name, criticality: "REQUIRED" })),
    ...jobIntent.preferredCapabilities.slice(0, 4).map((c) => ({ name: c.name, criticality: "PREFERRED" })),
  ];

  const mappings: JdToEvidenceMatch[] = [];
  const unmapped: string[] = [];

  for (const priority of targetPriorities) {
    const pNameLower = priority.name.toLowerCase();
    const matchingUnits: Array<{ unit: AccomplishmentUnit; score: number; reason: string }> = [];

    for (const acc of allAccomplishments) {
      const accTextLower = acc.rawText.toLowerCase();
      const techLower = acc.technologies.map((t) => t.toLowerCase());

      if (techLower.includes(pNameLower) || accTextLower.includes(pNameLower)) {
        matchingUnits.push({
          unit: acc,
          score: 10 + acc.importanceScore,
          reason: `Exact match for ${priority.name} in verified accomplishment.`,
        });
      } else if (
        (pNameLower.includes("data warehouse") || pNameLower.includes("lakehouse") || pNameLower.includes("snowflake")) &&
        (accTextLower.includes("snowflake") || accTextLower.includes("delta lake") || accTextLower.includes("medallion"))
      ) {
        matchingUnits.push({
          unit: acc,
          score: 8 + acc.importanceScore,
          reason: `Direct architectural alignment for cloud data warehousing and lakehouse design.`,
        });
      } else if (
        (pNameLower.includes("etl") || pNameLower.includes("pipeline") || pNameLower.includes("python") || pNameLower.includes("sql")) &&
        (accTextLower.includes("pyspark") || accTextLower.includes("python") || accTextLower.includes("pipeline") || accTextLower.includes("ingest"))
      ) {
        matchingUnits.push({
          unit: acc,
          score: 7 + acc.importanceScore,
          reason: `Evidenced data pipeline engineering and transformation responsibilities.`,
        });
      }
    }

    if (matchingUnits.length > 0) {
      // Sort by score descending
      matchingUnits.sort((a, b) => b.score - a.score);
      const topMatch = matchingUnits[0];
      const strength = topMatch.score >= 15 ? "HIGH" : topMatch.score >= 12 ? "MEDIUM" : "SUPPORTING";

      mappings.push({
        jdPriority: priority.name,
        requirementCriticality: priority.criticality,
        candidateEvidenceId: topMatch.unit.id,
        candidateEvidenceText: topMatch.unit.rawText,
        employer: topMatch.unit.employer,
        matchStrength: strength,
        matchReason: topMatch.reason,
      });
    } else {
      unmapped.push(priority.name);
    }
  }

  return {
    mappings,
    unmappedRequirements: unmapped,
  };
}

/** The trailing 0-based index accomplishmentEvidence.ts's `id` generator embeds (`{employerSlug}_acc_
 *  {index}` or the fallback `..._acc_fallback_0`) — the EXACT same index renderAccomplishmentEvidenceSection
 *  numbers that employer's own proof-point list by (`idx + 1`), since both walk the same
 *  `verifiedAccomplishments` array in the same order. Parsing it back out lets this section point at
 *  "employer #N" instead of re-quoting the accomplishment's full text a second time. */
function accomplishmentDisplayNumber(candidateEvidenceId: string): number | null {
  const m = candidateEvidenceId.match(/_(\d+)$/);
  return m ? Number(m[1]) + 1 : null;
}

/**
 * PHASE 6.6 — formats the JD-to-candidate evidence mapping as a compact POINTER into the
 * VERIFIED EMPLOYER ACCOMPLISHMENT EVIDENCE section's own numbered proof points, instead of
 * re-quoting each accomplishment's full text a second time (previously ~100% duplicate content
 * between the two sections for every mapping — the two sections are always rendered together in the
 * same prompt, so the referenced text is never more than a few hundred bytes away).
 */
export function renderJdEvidenceMappingSection(result: JdEvidenceMappingResult): string {
  if (!result.mappings || result.mappings.length === 0) return "";

  const lines: string[] = [
    "## JD-TO-CANDIDATE EVIDENCE MAPPING — PRIORITIZED PROOF POINTS",
    "",
    "Each line points at that employer's own numbered proof point above (VERIFIED EMPLOYER ACCOMPLISHMENT EVIDENCE) — the exact evidence to draw on for that JD priority, not new content.",
    "",
  ];

  for (const map of result.mappings) {
    const num = accomplishmentDisplayNumber(map.candidateEvidenceId);
    const pointer = num !== null ? `proof point #${num}` : map.candidateEvidenceText;
    lines.push(`- **${map.jdPriority}** [${map.requirementCriticality}] → **${map.employer}** ${pointer} [${map.matchStrength}]`);
  }

  return lines.join("\n");
}
