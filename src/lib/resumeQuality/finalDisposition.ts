import { selectBestResumeQualityAttempt, type ResumeQualityAttemptSummary } from "./bestAttemptSelection";
import { evaluateQualityGate } from "./qualityGate";
import { HARD_GATE_CHECKS } from "./instructionCompliance";
import type { InstructionComplianceChecks, StructuredResumeReview } from "./types";

/**
 * Stage 28 — the distinction between "SAFE AND TRUTHFUL" and "PERFECTLY OPTIMISED".
 *
 * WHY THIS IS SEPARATE FROM THE GATE. evaluateQualityGate answers "is this flawless?" and its READY
 * contract is unchanged here: every one of its eight conditions still has to hold, and nothing in
 * this module can make a failing review READY. What was missing is the other question a human
 * actually asks — "is this truthful enough that I can send it?" — because CareerOps collapsed
 * "contains a fabrication" and "is honest but scores 78" into the same terminal FAILED state.
 *
 * The product decision this encodes: a truthful resume at ~70-80 optimisation, in the applicant's
 * hands in minutes, is worth more than a third generation chasing 100. The safety half of that
 * sentence is absolute and is NOT relaxed anywhere below — a fabricated 100 must always lose to a
 * truthful 78.
 *
 * SAFETY vs OPTIMISATION. Every Stage 21 signal is classified below into exactly one of the two.
 * The safety set is derived from what each check actually asserts about FACTS, not from how severe
 * it looks:
 *
 *   SAFETY  — typed blocking failures (the reviewer's own named fabrication findings), truthfulness
 *             and architecture-consistency scores, concrete blocking issues, and the compliance
 *             checks that assert something about the candidate's real history: employers/titles/
 *             dates/education, inventory grounding, architecture integrity, contradiction freedom,
 *             cross-document consistency, years/education honesty, metric provenance, employment type.
 *   OPTIMISE — overall/ATS score, recruiter-quality positioning, and the style/presentation checks
 *             (deep rewrite, grouping, keyword optimisation, bullet writing, banned language,
 *             duplicate phrasing, verb tense, length caps, ATS formatting).
 *
 * `finalValidation` is deliberately in NEITHER set: it is a meta-check that fails whenever any other
 * hard gate fails, so counting it would double-count a single real violation — the same reasoning
 * bestAttemptSelection.ts already documents for its own comparator.
 */

/** Compliance checks that assert a FACT about the candidate's history. Non-PASS here is a blocker. */
export const TRUTHFULNESS_COMPLIANCE_CHECKS: readonly (keyof InstructionComplianceChecks)[] = [
  "hardCareerFacts",
  "masterSkillsInventoryCompliance",
  "architectureIntegrity",
  "technologyAdaptation",
  "migrationIntegrity",
  "noContradictingTechnologies",
  "crossDocumentConsistency",
  "yearsExperienceEducationHonesty",
  "metricInferencePolicy",
  "employmentTypeHandling",
];

export type FinalDisposition = "READY" | "SAFE_BEST_ATTEMPT" | "BLOCKED";

export interface SafetyVerdict {
  /** True only when every absolute truthfulness/identity guardrail holds. */
  safe: boolean;
  blockers: string[];
}

export interface FinalDispositionResult {
  disposition: FinalDisposition;
  /** The iteration a human should act on. Null only when there are no iterations at all. */
  selectedIterationNumber: number | null;
  selectionReason: string | null;
  safety: SafetyVerdict;
  /** Optimisation headline for the UI — never presented as a pass/fail threshold. */
  optimizationScore: number | null;
  /** Truthful-but-non-critical findings a human may want to skim before sending. */
  optimizationFindings: string[];
  /** True only when a HUMAN may send this package. CareerOps never sends anything itself. */
  humanMaySend: boolean;
}

/**
 * The absolute blockers, in the order a human cares about them. Absence of evidence is treated as
 * failure throughout — a review that never computed typed blocking failures has not been cleared of
 * them, exactly as qualityGate.ts condition 7 already requires.
 */
export function evaluateSafety(review: StructuredResumeReview): SafetyVerdict {
  const blockers: string[] = [];

  if (review.blockingFailures === undefined) {
    blockers.push(
      "Typed blocking-failure analysis is missing — this package has not been cleared of fabrication, and 'not checked' is not 'passed'."
    );
  } else {
    for (const failure of review.blockingFailures) {
      blockers.push(`${failure.type}: ${failure.description}`);
    }
  }

  if (review.truthfulnessScore !== 100) {
    blockers.push(`Truthfulness score is ${review.truthfulnessScore}, not 100 — the package asserts something the candidate's evidence does not support.`);
  }
  if (review.architectureConsistencyScore !== 100) {
    blockers.push(
      `Architecture consistency score is ${review.architectureConsistencyScore}, not 100 — the package implies experience the evidence does not support.`
    );
  }
  for (const issue of review.blockingIssues) {
    blockers.push(`Blocking issue: ${issue}`);
  }

  const compliance = review.instructionCompliance;
  if (compliance === undefined) {
    blockers.push("Canonical instruction compliance was never computed — the truthfulness checks did not run.");
  } else {
    for (const check of TRUTHFULNESS_COMPLIANCE_CHECKS) {
      const status = compliance.checks[check];
      if (status !== "PASS") {
        const reasons = compliance.checkNotes?.[check] ?? [];
        blockers.push(`Truthfulness check ${check} is ${status}.${reasons.length > 0 ? ` Reason: ${reasons.join(" | ")}` : ""}`);
      }
    }
  }

  return { safe: blockers.length === 0, blockers };
}

/** Truthful-but-weak findings: everything that is NOT in the safety set and is not yet PASS. */
function collectOptimizationFindings(review: StructuredResumeReview): string[] {
  const findings: string[] = [];
  if (review.overallScore < 95) findings.push(`Overall optimisation score is ${review.overallScore} (READY requires 95).`);
  const recruiter = review.recruiterQualityAssessment;
  if (recruiter === undefined) {
    findings.push("Recruiter-quality positioning was never verified against a target role title.");
  } else if (recruiter.status !== "PASS") {
    findings.push(`Recruiter-quality positioning is ${recruiter.status}, not PASS.`);
  }
  const compliance = review.instructionCompliance;
  if (compliance) {
    for (const [name, status] of Object.entries(compliance.checks) as [keyof InstructionComplianceChecks, string][]) {
      if (status === "PASS") continue;
      if (name === "finalValidation") continue; // meta-check; see the module comment
      if (TRUTHFULNESS_COMPLIANCE_CHECKS.includes(name)) continue; // already a safety blocker
      const hard = HARD_GATE_CHECKS.includes(name) ? "hard-gate" : "style";
      findings.push(`Presentation check ${name} is ${status} (${hard}).`);
    }
  }
  return findings;
}

/**
 * The single verdict the UI and the publisher act on, computed from a workflow's whole iteration
 * history. Never calls an AI, never randomises, and never mutates anything.
 *
 * READY is only ever returned when evaluateQualityGate itself says READY for the selected attempt —
 * this function cannot invent it. SAFE_BEST_ATTEMPT means exactly "every absolute guardrail holds,
 * the optimisation bar does not", and is deliberately a DIFFERENT word so nothing downstream can
 * present it as equivalent to READY.
 */
export function determineFinalDisposition(iterations: ResumeQualityAttemptSummary[]): FinalDispositionResult {
  const best = selectBestResumeQualityAttempt(iterations);
  if (!best) {
    return {
      disposition: "BLOCKED",
      selectedIterationNumber: null,
      selectionReason: null,
      safety: { safe: false, blockers: ["No completed tailoring attempt exists for this workflow."] },
      optimizationScore: null,
      optimizationFindings: [],
      humanMaySend: false,
    };
  }

  const chosen = iterations.find((i) => i.iterationNumber === best.iterationNumber)!;
  const safety = evaluateSafety(chosen.review);
  // The gate is asked with the selected attempt's own position, so its answer here means exactly what
  // it means everywhere else. It is consulted, never re-implemented or relaxed.
  const gate = evaluateQualityGate(chosen.review, chosen.iterationNumber, chosen.iterationNumber);

  const disposition: FinalDisposition = !safety.safe ? "BLOCKED" : gate === "READY" ? "READY" : "SAFE_BEST_ATTEMPT";

  return {
    disposition,
    selectedIterationNumber: chosen.iterationNumber,
    selectionReason: best.selectionReason,
    safety,
    optimizationScore: chosen.review.overallScore,
    optimizationFindings: disposition === "READY" ? [] : collectOptimizationFindings(chosen.review),
    // A human may send a package that is READY or a safe best attempt. BLOCKED never.
    humanMaySend: disposition !== "BLOCKED",
  };
}
