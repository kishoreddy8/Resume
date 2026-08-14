import type { RequiredCorrection, ResumeReviewerAgent, ResumeReviewerInput, ResumeReviewerOutput, StructuredResumeReview } from "../types";
import { evaluateAtsAlignment } from "./atsChecks";
import { evaluateArchitectureConsistency } from "./architectureChecks";
import { evaluateBulletChecks } from "./bulletChecks";
import { evaluateSkillsOrdering } from "./skillsOrderingChecks";
import { evaluateStructuralChecks } from "./structuralChecks";
import { evaluateSummaryAlignment } from "./summaryChecks";
import { evaluateTruthfulness } from "./truthfulnessChecks";

/**
 * Phase 3 Stage 8 — deterministic, provider-independent ResumeReviewerAgent. Zero network access,
 * zero AI inference, zero Anthropic/OpenAI SDK. A low-cost first-pass quality layer that catches
 * OBJECTIVE defects before (or alongside) a future AI reviewer — see this file's own module doc for
 * the target future architecture (AI Writer -> Deterministic Reviewer -> AI Reviewer -> Quality
 * Gate -> Improvement, only the first two of which exist as of Stage 8).
 *
 * SCORE MODEL (documented, deterministic, reproducible — same input always produces the same
 * output):
 *
 *   atsScore                    = 0.75 * requiredCoverage + 0.25 * preferredCoverage  (see atsChecks.ts)
 *   keywordAlignmentScore       = raw canonical-keyword overlap ratio                  (see atsChecks.ts)
 *   truthfulnessScore           = 100 - 40*(blocking facts) - 15*(title/date/edu issues) - 5*(metric flags)
 *                                  capped at 85 when Master Resume data is unavailable  (see truthfulnessChecks.ts)
 *   architectureConsistencyScore= 100 - 50*(technology-contradiction bullets found)     (see architectureChecks.ts)
 *   recruiterReadabilityScore   = 100 - (generic-opener/length/banned-language/duplicate/repeated-verb deductions)
 *   formattingScore             = 100 - (missing/duplicate/malformed-section deductions)  (see structuralChecks.ts)
 *
 *   overallScore = round(0.15*ats + 0.15*keywordAlignment + 0.25*truthfulness + 0.20*architecture
 *                         + 0.15*recruiterReadability + 0.10*formatting)
 *                  capped at 40 if ANY blockingIssue is present
 *
 * The 40-point cap on a blocking issue is deliberate and documented, per the spec: "Do NOT allow
 * high ATS keyword coverage to hide ... blocking issues ... overallScore should reflect that
 * materially." Truthfulness (25%) and architecture (20%) are weighted higher than the two ATS
 * scores combined (30%) specifically so a factual/architectural problem cannot be outweighed by
 * strong keyword coverage — the weighting is a second, independent line of defense on top of the
 * hard cap.
 *
 * READINESS is intentionally NOT decided here — evaluateQualityGate() (Stage 7,
 * src/lib/resumeQuality/qualityGate.ts) remains the sole authority on READY/IMPROVEMENT_NEEDED/
 * NEEDS_HUMAN_REVIEW; this module only ever produces a StructuredResumeReview for that function to
 * evaluate.
 */

const BLOCKING_ISSUE_OVERALL_CAP = 40;

function clamp(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** The pure core: takes exactly what checks need (resume + optional job requirements + optional
 *  Master Resume profile) and returns a StructuredResumeReview. Exported separately from the
 *  ResumeReviewerAgent wrapper so it's directly callable without constructing filesystem paths —
 *  useful for tests and for any future caller that already has structured data in hand. */
export function reviewResumeDeterministically(input: Pick<ResumeReviewerInput, "resume" | "jobRequirements" | "masterResumeProfile">): StructuredResumeReview {
  const { resume, jobRequirements, masterResumeProfile } = input;

  const ats = evaluateAtsAlignment(resume, jobRequirements);
  const structural = evaluateStructuralChecks(resume);
  const bullets = evaluateBulletChecks(resume.experience);
  const truthfulness = evaluateTruthfulness(resume, masterResumeProfile);
  const architecture = evaluateArchitectureConsistency(resume.experience);
  const summary = evaluateSummaryAlignment(resume.summary, jobRequirements);
  const skillsOrdering = evaluateSkillsOrdering(resume.skillGroups, jobRequirements);

  const recruiterReadabilityScore = clamp(100 - bullets.readabilityDeductions);

  const blockingIssues = [...structural.blockingIssues, ...truthfulness.blockingIssues, ...architecture.blockingIssues];

  const requiredCorrections: RequiredCorrection[] = [...structural.corrections, ...bullets.corrections];
  if (ats.insufficientRequirementData) {
    requiredCorrections.push({ priority: "LOW", description: "No job requirements were supplied to this review — ATS/keyword/skills-ordering/summary-alignment scores are unverified defaults, not real measurements." });
  }
  if (truthfulness.insufficientProfileData) {
    requiredCorrections.push({ priority: "LOW", description: "No Master Resume profile was supplied to this review — truthfulness could not be verified against source-of-truth facts." });
  }
  for (const issue of blockingIssues) {
    requiredCorrections.push({ priority: "CRITICAL", description: issue });
  }

  let overallScore = clamp(
    0.15 * ats.atsScore +
      0.15 * ats.keywordAlignmentScore +
      0.25 * truthfulness.truthfulnessScore +
      0.2 * architecture.architectureConsistencyScore +
      0.15 * recruiterReadabilityScore +
      0.1 * structural.formattingScore
  );
  if (blockingIssues.length > 0) {
    overallScore = Math.min(overallScore, BLOCKING_ISSUE_OVERALL_CAP);
  }

  return {
    overallScore,
    atsScore: clamp(ats.atsScore),
    keywordAlignmentScore: clamp(ats.keywordAlignmentScore),
    truthfulnessScore: clamp(truthfulness.truthfulnessScore),
    architectureConsistencyScore: clamp(architecture.architectureConsistencyScore),
    recruiterReadabilityScore,
    formattingScore: clamp(structural.formattingScore),

    missingRequiredSkills: ats.missingRequiredSkills,
    incorrectTechnologyUsage: architecture.incorrectTechnologyUsage,
    genericBullets: bullets.genericBullets,
    missingImpactEvidence: truthfulness.missingImpactEvidence,
    summaryIssues: summary.summaryIssues,
    skillsOrderingIssues: skillsOrdering.skillsOrderingIssues,
    truthfulnessIssues: truthfulness.truthfulnessIssues,
    blockingIssues,
    requiredCorrections,
  };
}

/** ResumeReviewerAgent implementation. No network, no AI provider — see this file's module doc. */
export class DeterministicResumeReviewer implements ResumeReviewerAgent {
  async review(input: ResumeReviewerInput): Promise<ResumeReviewerOutput> {
    const review = reviewResumeDeterministically(input);
    return { review };
  }
}
