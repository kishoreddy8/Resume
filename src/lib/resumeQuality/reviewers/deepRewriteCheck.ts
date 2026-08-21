import type { RequirementUnit } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";
import type { ComplianceStatus } from "../types";
import { extractCanonicalSkillsFromText } from "./skillAliases";

/**
 * DEEP-REWRITE REQUIREMENT compliance — a deterministic, evidence-based proxy for "was this
 * genuinely rewritten for this JD, or was it lightly keyword-patched." Per the hardening spec's own
 * instruction: use deterministic evidence (does the content materially differ from what came
 * before, does JD-critical terminology appear naturally, is skills ordering reoriented toward the
 * target stack) rather than an arbitrary word-change percentage, and return REVIEW when the evidence
 * is genuinely ambiguous rather than guessing PASS or FAIL.
 *
 * Two evidence modes, in priority order:
 *   1. IMPROVEMENT ITERATIONS (priorResume supplied): the strongest, most direct signal — did the
 *      bullets actually change from what the writer was told to revise? A writer that returns the
 *      same bullets after being handed required corrections has demonstrably not done a deep rewrite,
 *      regardless of how good those bullets look in isolation.
 *   2. FIRST ITERATION (no priorResume; only jobRequirements to compare against): a resume with no
 *      prior version to diff against can only be judged by whether it's oriented toward the JD's
 *      stack at all (dominant-skill presence in the summary, dominant skills not buried in Technical
 *      Skills) — reusing the exact same dominant-stack extraction summaryChecks.ts/
 *      skillsOrderingChecks.ts already compute, not a second implementation of that logic.
 *
 * APPLICABILITY — WHEN A DEEP REWRITE WAS NEVER THE INSTRUCTION.
 *
 * Mode 1 asks "did the bullets change after the writer was handed corrections". That question is
 * only fair when the writer was actually asked to rewrite. Stage 28's repairScope.ts hands it the
 * opposite instruction — "TARGETED REPAIR — CHANGE ONLY WHAT IS LISTED HERE" — and emits that header
 * for EVERY scope, FULL included; FULL means both documents are in scope, not that either should be
 * regenerated. Its closing line is explicit: return both documents, "the unchanged one reproduced
 * verbatim, the repaired one corrected".
 *
 * So a writer that obeys a repair plan will necessarily leave most bullets identical, and mode 1
 * would fail it for exactly that. Two real workflows show the signature: a targeted repair fixed
 * every outstanding finding, took the score to 100 with zero corrections and zero blocking issues,
 * and was then blocked solely by this check at 84% unchanged. One was RESUME_ONLY and one was FULL,
 * which is why the scope VALUE cannot be the discriminator — the presence of a repair contract is.
 *
 * `rewriteExpectation` therefore carries what the writer was told, resolved from the persisted
 * writer_input.json for that iteration. It is never inferred from the output: not from the unchanged
 * percentage, not from the score, not from the correction count, not from the iteration number. When
 * it is absent or unresolvable the check stays FULLY APPLICABLE — an unknown contract must never be
 * read as permission to skip a guardrail.
 */

const UNCHANGED_BULLET_FAIL_THRESHOLD = 0.8; // >=80% byte-identical bullets after a revision request = not a rewrite

function normalizeBullet(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function dominantStackFrom(jobRequirements: RequirementUnit[]): string[] {
  return jobRequirements
    .filter((u) => (u.kind === "skill" || u.kind === "skill_group") && (u.criticality === "CRITICAL" || u.criticality === "REQUIRED"))
    .flatMap((u) => u.memberSkillNames)
    .slice(0, 8);
}

export interface DeepRewriteCheckResult {
  status: ComplianceStatus;
  evidence: string[];
}

/**
 * What the writer was instructed to produce for this iteration.
 *
 * FULL_REWRITE is the default and the fail-closed value: it is what an unknown contract resolves to.
 */
export type RewriteExpectation = "FULL_REWRITE" | "TARGETED_REPAIR";

export function evaluateDeepRewrite(input: {
  resume: ResumeContent;
  priorResume?: ResumeContent;
  jobRequirements?: RequirementUnit[];
  /** Absent = unknown = treated as FULL_REWRITE. */
  rewriteExpectation?: RewriteExpectation;
}): DeepRewriteCheckResult {
  const { resume, priorResume, jobRequirements, rewriteExpectation } = input;

  /* Checked before the diff, not after: the point is that the comparison was never the contract, so
   * running it and then discarding the answer would still record a percentage that means nothing. */
  if (rewriteExpectation === "TARGETED_REPAIR") {
    return {
      status: "NOT_APPLICABLE",
      evidence: [
        "This iteration was governed by a targeted repair plan, which instructed the writer to change only the listed findings and reproduce the rest verbatim. A full-document rewrite was not required, so the deep-rewrite comparison does not apply.",
      ],
    };
  }

  if (priorResume) {
    const priorBullets = new Set(priorResume.experience.flatMap((e) => e.bullets.map(normalizeBullet)));
    const currentBullets = resume.experience.flatMap((e) => e.bullets.map(normalizeBullet));
    if (currentBullets.length === 0) {
      return { status: "REVIEW", evidence: ["No experience bullets present to compare against the prior iteration."] };
    }
    const unchangedCount = currentBullets.filter((b) => priorBullets.has(b)).length;
    const unchangedRatio = unchangedCount / currentBullets.length;

    if (unchangedRatio >= UNCHANGED_BULLET_FAIL_THRESHOLD) {
      return {
        status: "FAIL",
        evidence: [
          `${Math.round(unchangedRatio * 100)}% of experience bullets are byte-identical to the prior iteration — this does not read as a genuine rewrite in response to the required corrections.`,
        ],
      };
    }
    return {
      status: "PASS",
      evidence: [`${Math.round((1 - unchangedRatio) * 100)}% of experience bullets materially differ from the prior iteration.`],
    };
  }

  // No prior resume — this is iteration 1 (or a caller that never supplied one). Judge by JD
  // orientation only; ambiguous evidence returns REVIEW rather than guessing.
  if (!jobRequirements || jobRequirements.length === 0) {
    return { status: "REVIEW", evidence: ["No prior iteration and no job requirements were supplied — deep-rewrite evidence is unavailable, not verified as PASS."] };
  }

  const dominant = dominantStackFrom(jobRequirements);
  if (dominant.length === 0) {
    return { status: "REVIEW", evidence: ["The job requirements contained no CRITICAL/REQUIRED skills to check orientation against."] };
  }

  const summaryText = resume.summary.join(" ");
  const summarySkills = extractCanonicalSkillsFromText(summaryText);
  const summaryOverlap = dominant.some((s) => summarySkills.has(s));

  const evidence: string[] = [];
  if (summaryText.trim().length === 0) {
    return { status: "FAIL", evidence: ["Professional Summary is empty — cannot be JD-oriented."] };
  }
  if (!summaryOverlap) {
    evidence.push("Professional Summary does not mention any of the JD's dominant required technologies.");
  } else {
    evidence.push("Professional Summary mentions at least one of the JD's dominant required technologies.");
  }

  // "Buried" dominant-skill check, mirroring skillsOrderingChecks.ts's own top-3-groups threshold —
  // reused as a signal here, not recomputed with different numbers.
  let buriedOrMissing = 0;
  for (const skillName of dominant) {
    let foundAtIndex: number | null = null;
    for (let i = 0; i < resume.skillGroups.length; i++) {
      if (extractCanonicalSkillsFromText(resume.skillGroups[i].items.join(" ")).has(skillName)) {
        foundAtIndex = i;
        break;
      }
    }
    if (foundAtIndex === null || foundAtIndex > 2) buriedOrMissing++;
  }
  evidence.push(`${dominant.length - buriedOrMissing}/${dominant.length} JD-dominant skills appear near the top of Technical Skills.`);

  if (summaryOverlap && buriedOrMissing <= Math.floor(dominant.length / 2)) {
    return { status: "PASS", evidence };
  }
  if (!summaryOverlap && buriedOrMissing === dominant.length) {
    return { status: "FAIL", evidence };
  }
  return { status: "REVIEW", evidence };
}
