import { evaluateInstructionCompliance, hardGateFailureCorrections } from "../instructionCompliance";
import type { RequiredCorrection, ResumeReviewerAgent, ResumeReviewerInput, ResumeReviewerOutput, StructuredResumeReview } from "../types";
import { evaluateAtsAlignment } from "./atsChecks";
import { evaluateArchitectureConsistency } from "./architectureChecks";
import { evaluateBulletChecks } from "./bulletChecks";
import { evaluateCrossDocumentConsistency } from "./crossDocumentChecks";
import { evaluateDeepRewrite } from "./deepRewriteCheck";
import { evaluateEmploymentTypeHandling } from "./employmentTypeChecks";
import { evaluateBulletCaps, evaluateVerbTense } from "./lengthAndTenseChecks";
import { evaluateMetricProvenance } from "./metricProvenanceChecks";
import { evaluateMsiCompliance } from "./msiComplianceChecks";
import { evaluateOnePrimaryTechnologyPerResponsibility } from "./onePrimaryTechnologyCheck";
import { evaluateSkillsOrdering } from "./skillsOrderingChecks";
import { evaluateStructuralChecks } from "./structuralChecks";
import { evaluateSummaryAlignment } from "./summaryChecks";
import { findTechnologyContradictions } from "./technologyGroups";
import { evaluateTechnologyGrouping } from "./technologyGroupingCheck";
import { checkMetricRealism, evaluateTruthfulness } from "./truthfulnessChecks";
import { evaluateYearsExperienceAndEducationHonesty } from "./yearsExperienceChecks";

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

/** The pure core: takes exactly what checks need (resume + optional job requirements/Master Resume
 *  profile/cover letter/prior iteration/DOCX validation) and returns a StructuredResumeReview.
 *  Exported separately from the ResumeReviewerAgent wrapper so it's directly callable without
 *  constructing filesystem paths — useful for tests and for any future caller that already has
 *  structured data in hand.
 *
 *  Resume Quality Hardening: this function's ORIGINAL Stage 8 scores/issue-array computation below
 *  (atsScore, truthfulnessScore, architectureConsistencyScore, blockingIssues, etc.) is byte-for-byte
 *  unchanged — every new check added by this hardening pass feeds ONLY the additive
 *  instructionCompliance/metricProvenance fields, never the original scoring formula or
 *  blockingIssues array. See qualityGate.ts for how instructionCompliance becomes a SEPARATE,
 *  additional READY requirement rather than folding into (and potentially distorting) the original
 *  four-condition gate. */
export function reviewResumeDeterministically(
  input: Pick<ResumeReviewerInput, "resume" | "jobRequirements" | "masterResumeProfile" | "coverLetter" | "priorResume" | "docxValidation">
): StructuredResumeReview {
  const { resume, jobRequirements, masterResumeProfile, coverLetter, priorResume, docxValidation } = input;

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

  // --- Resume Quality Hardening: canonical instruction compliance (additive) --------------------

  const msi = evaluateMsiCompliance(resume, masterResumeProfile);
  const deepRewrite = evaluateDeepRewrite({ resume, priorResume, jobRequirements });
  const technologyGroupingFindings = evaluateTechnologyGrouping(resume.skillGroups);
  const laundryListFindings = evaluateOnePrimaryTechnologyPerResponsibility(resume.experience);
  const metricProvenance = evaluateMetricProvenance(resume.experience, priorResume?.experience);
  const suspiciousRepeatedMetrics = checkMetricRealism(resume.experience);
  const crossDocument = evaluateCrossDocumentConsistency(resume, coverLetter);
  const employmentType = evaluateEmploymentTypeHandling(resume.experience, coverLetter);
  const years = evaluateYearsExperienceAndEducationHonesty(resume, masterResumeProfile);
  const bulletCaps = evaluateBulletCaps(resume.experience);
  const verbTense = evaluateVerbTense(resume.experience);

  // Cover-letter-side technology contradictions — same detection logic as architectureChecks.ts
  // (findTechnologyContradictions), applied to cover letter paragraphs instead of resume bullets, per
  // the canonical instructions' explicit "scan resume AND cover letter" scope for this ONE guardrail
  // (noContradictingTechnologies) specifically. Not folded into architectureIntegrity, which stays
  // resume-experience-scoped exactly as Stage 8 originally defined it.
  const coverLetterContradictions = (coverLetter?.paragraphs ?? []).flatMap((paragraph) =>
    findTechnologyContradictions(paragraph).map(
      (c) => `Cover letter: "${c.foundMembers.join(" + ")}" (${c.group.label}) with no migration/integration framing.`
    )
  );

  const instructionCompliance = evaluateInstructionCompliance({
    hasMasterProfile: masterResumeProfile !== undefined,
    hasJobRequirements: (jobRequirements?.length ?? 0) > 0,
    hasCoverLetter: coverLetter !== undefined,
    employmentOrEducationBlockingIssues: truthfulness.blockingIssues,
    employmentOrEducationSoftIssues: truthfulness.truthfulnessIssues,
    ungroundedTechnologies: msi.ungroundedTechnologies,
    deepRewriteStatus: deepRewrite.status,
    architectureContradictions: architecture.incorrectTechnologyUsage,
    coverLetterContradictions,
    technologyGroupingFindings,
    laundryListFindings,
    metricProvenance,
    suspiciousRepeatedMetrics,
    atsScore: ats.atsScore,
    keywordAlignmentScore: ats.keywordAlignmentScore,
    insufficientRequirementData: ats.insufficientRequirementData,
    genericBulletsCount: bullets.genericBullets.length,
    bannedLanguageInBulletsCount: bullets.bannedLanguageCount,
    overlyLongOrShortCount: bullets.lengthViolationCount,
    bannedLanguageInSummaryCount: summary.bannedLanguageFound.length,
    crossDocumentStatus: crossDocument.status,
    crossDocumentContradictions: crossDocument.contradictions,
    duplicateBulletCount: bullets.duplicateBulletCount,
    yearsInflationIssues: years.inflationIssues,
    educationHidden: years.educationHidden,
    employmentTypeStatus: employmentType.status,
    employmentTypeFlags: employmentType.flaggedPhrases,
    bulletCapViolations: bulletCaps.corrections.length,
    verbTenseViolations: verbTense.corrections.length,
    structuralBlockingIssues: structural.blockingIssues,
    formattingScore: structural.formattingScore,
    docxValidation,
    anyBlockingIssues: blockingIssues.length > 0,
  });

  requiredCorrections.push(...bulletCaps.corrections, ...verbTense.corrections);
  // Every hard-gate compliance FAIL becomes an actionable CRITICAL correction — without this, a
  // writer/human could see requiredCorrections come back empty while the gate still silently blocks
  // READY over e.g. an ungrounded MSI technology or a cross-document contradiction that never
  // touched blockingIssues above.
  requiredCorrections.push(...hardGateFailureCorrections(instructionCompliance));

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
    instructionCompliance,
    metricProvenance,
  };
}

/** ResumeReviewerAgent implementation. No network, no AI provider — see this file's module doc. */
export class DeterministicResumeReviewer implements ResumeReviewerAgent {
  async review(input: ResumeReviewerInput): Promise<ResumeReviewerOutput> {
    const review = reviewResumeDeterministically(input);
    return { review };
  }
}
