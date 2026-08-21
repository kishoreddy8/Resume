import { buildAtsCoverageReport } from "../atsCoverageReport";
import { buildJdPriorityMatrix } from "../jdPriorityMatrix";
import { evaluateInstructionCompliance, hardGateFailureCorrections } from "../instructionCompliance";
import { evaluateRecruiterQuality } from "../recruiterQualityGate";
import type { RequiredCorrection, ResumeReviewerAgent, ResumeReviewerInput, ResumeReviewerOutput, StructuredResumeReview } from "../types";
import { evaluateAtsAlignment } from "./atsChecks";
import { evaluateArchitectureConsistency } from "./architectureChecks";
import { buildBlockingFailures } from "./blockingFailureSynthesis";
import { evaluateBulletChecks } from "./bulletChecks";
import { evaluateCrossDocumentConsistency } from "./crossDocumentChecks";
import { evaluateDeepRewrite } from "./deepRewriteCheck";
import { evaluateEmploymentTypeHandling } from "./employmentTypeChecks";
import { evaluateBulletCaps, evaluateVerbTense } from "./lengthAndTenseChecks";
import { evaluateMetricProvenance } from "./metricProvenanceChecks";
import { evaluateMsiCompliance } from "./msiComplianceChecks";
import { evaluateOnePrimaryTechnologyPerResponsibility } from "./onePrimaryTechnologyCheck";
import { evaluatePlaceholderIntegrity } from "./placeholderChecks";
import { evaluateSkillsOrdering } from "./skillsOrderingChecks";
import { evaluateStructuralChecks } from "./structuralChecks";
import { evaluatePresentationContract } from "../presentationContract";
import { findThirdPersonNarration } from "../professionalIdentity";
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
  input: Pick<
    ResumeReviewerInput,
    | "resume"
    | "jobRequirements"
    | "masterResumeProfile"
    | "coverLetter"
    | "priorResume"
    | "docxValidation"
    | "targetRoleTitle"
    | "rewriteExpectation"
  >
): StructuredResumeReview {
  const { resume, jobRequirements, masterResumeProfile, coverLetter, priorResume, docxValidation, targetRoleTitle, rewriteExpectation } =
    input;

  const ats = evaluateAtsAlignment(resume, jobRequirements);
  const structural = evaluateStructuralChecks(resume, masterResumeProfile);
  const bullets = evaluateBulletChecks(resume.experience);
  const truthfulness = evaluateTruthfulness(resume, masterResumeProfile);
  const architecture = evaluateArchitectureConsistency(resume.experience);
  const summary = evaluateSummaryAlignment(resume.summary, jobRequirements);
  const skillsOrdering = evaluateSkillsOrdering(resume.skillGroups, jobRequirements);

  const recruiterReadabilityScore = clamp(100 - bullets.readabilityDeductions);

  const blockingIssues = [...structural.blockingIssues, ...truthfulness.blockingIssues, ...architecture.blockingIssues];

  // Stage 31.1 — the presentation contract: role-only headline, one-paragraph summary in resume
  // voice, no em/en dash prose punctuation, Technical Skills that are an ecosystem rather than a
  // transcription of the posting. Writing rules, so they reach the writer as corrections and cost
  // formatting score below; none of them is a truthfulness finding and none changes gate semantics.
  const contract = evaluatePresentationContract({ resume, coverLetter, masterResumeProfile, jobRequirements });

  // Stage 31.1 correction — these two defects need TEETH, not just a deduction.
  //
  // Third-person narration ("Owns ETL delivery…", "Works directly with…") and em/en dash prose
  // punctuation were originally reported as capped formatting findings, on the reasoning that a
  // writing flaw should not fail a factually sound resume. That reasoning produced a resume which
  // scored 100/100 and reached the human-review package still carrying all three defects: a
  // correction the gate does not enforce is a correction the writer is free to ignore.
  //
  // They belong in `bannedLanguage` — an EXISTING soft-gate check whose whole purpose is banned
  // style, and which evaluateQualityGate() already requires to PASS. Nothing about Stage 21 is
  // restructured, no gate condition is added, and truthfulness is untouched; these findings simply
  // land in the check that already governs language the resume may not use.
  const summaryNarration = findThirdPersonNarration(resume.summary);
  // A summary that is a keyword dump, or four sentences in the same frame, is a style failure of the
  // same order as narration: reported-only, it was simply ignored. Length stays a correction — a
  // long-but-well-written summary is a trim, not a defect worth refusing the whole resume over.
  // SUMMARY_FORMULAIC is deliberately NOT gate-blocking. Stem openings are only a problem when the
  // sentences behind them carry no substance; a summary of four well-written capability statements
  // is good writing, and refusing it would reject the register the candidate's own master resume
  // uses. Technology-dumping is the signal that actually separates positioning from inventory, so
  // that is the one with teeth. Stem-stacking still reaches the writer as a correction.
  const gateBlockingStyle = contract.filter(
    (i) => i.kind === "AI_DASH_PUNCTUATION" || i.kind === "SUMMARY_TECHNOLOGY_DUMP"
  );
  const bannedStyleCount = summaryNarration.length + gateBlockingStyle.length;
  const contractCorrections: RequiredCorrection[] = contract.map((issue) => ({
    priority: issue.severity,
    description: issue.message,
  }));
  // Capped for the same reason the Stage 31 structure findings are: a presentation defect must be
  // impossible to miss and equally impossible to fail a factually sound resume on by itself.
  const contractFormattingPenalty = Math.min(15, contract.reduce((sum, i) => sum + (i.severity === "HIGH" ? 6 : i.severity === "MEDIUM" ? 4 : 2), 0));

  const requiredCorrections: RequiredCorrection[] = [...structural.corrections, ...bullets.corrections, ...contractCorrections];
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
      0.1 * clamp(structural.formattingScore - contractFormattingPenalty)
  );
  if (blockingIssues.length > 0) {
    overallScore = Math.min(overallScore, BLOCKING_ISSUE_OVERALL_CAP);
  }

  // --- Resume Quality Hardening: canonical instruction compliance (additive) --------------------

  const msi = evaluateMsiCompliance(resume, masterResumeProfile);
  const deepRewrite = evaluateDeepRewrite({ resume, priorResume, jobRequirements, rewriteExpectation });
  const technologyGroupingFindings = evaluateTechnologyGrouping(resume.skillGroups);
  const laundryListFindings = evaluateOnePrimaryTechnologyPerResponsibility(resume.experience);
  const metricProvenance = evaluateMetricProvenance(resume.experience, priorResume?.experience);
  const suspiciousRepeatedMetrics = checkMetricRealism(resume.experience);
  const crossDocument = evaluateCrossDocumentConsistency(resume, coverLetter);
  const employmentType = evaluateEmploymentTypeHandling(resume.experience, coverLetter);
  const years = evaluateYearsExperienceAndEducationHonesty(resume, masterResumeProfile);
  const bulletCaps = evaluateBulletCaps(resume.experience);
  const verbTense = evaluateVerbTense(resume.experience);

  // Cover-letter-side technology contradictions — same detection logic as architectureChecks.ts,
  // but evaluated per sentence. A cover-letter paragraph commonly summarizes several employers;
  // treating the whole paragraph as one responsibility collapses truthful, chronologically distinct
  // architectures into a false contradiction. Sentence scope preserves real same-responsibility
  // conflicts while keeping separate employer sentences independent.
  const coverLetterSentences = (coverLetter?.paragraphs ?? []).flatMap((paragraph) =>
    paragraph.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean)
  );
  const coverLetterContradictions = coverLetterSentences.flatMap((sentence) =>
    findTechnologyContradictions(sentence).map(
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
    deepRewriteEvidence: deepRewrite.evidence,
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
    bannedLanguageInSummaryCount: summary.bannedLanguageFound.length + bannedStyleCount,
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
    formattingScore: clamp(structural.formattingScore - contractFormattingPenalty),
    docxValidation,
    anyBlockingIssues: blockingIssues.length > 0,
  });

  requiredCorrections.push(...bulletCaps.corrections, ...verbTense.corrections);
  // Every hard-gate compliance FAIL becomes an actionable CRITICAL correction — without this, a
  // writer/human could see requiredCorrections come back empty while the gate still silently blocks
  // READY over e.g. an ungrounded MSI technology or a cross-document contradiction that never
  // touched blockingIssues above.
  requiredCorrections.push(...hardGateFailureCorrections(instructionCompliance));

  // --- Stage 21 (Evidence-Grounded Resume Quality V2): typed blocking failures -------------------
  // A structured, named-taxonomy VIEW of facts already reflected in blockingIssues/requiredCorrections
  // above (never a second independent source of truth) — see instructionCompliance.ts/
  // blockingFailureSynthesis.ts's own "pure synthesis, detects nothing new" design. Consumed directly
  // by evaluateQualityGate() and Phase 17's failure-explanation rendering; deliberately NOT re-pushed
  // into requiredCorrections a second time, since that would just duplicate the same facts under a
  // different string.
  const placeholderFindings = evaluatePlaceholderIntegrity(resume, coverLetter);
  const blockingFailures = buildBlockingFailures({
    ungroundedTechnologies: msi.ungroundedTechnologies,
    metricProvenance,
    placeholderFindings,
    employerScopedContradictions: crossDocument.employerScopedContradictions,
    generalContradictions: crossDocument.generalContradictions,
    truthfulnessBlockingIssues: truthfulness.blockingIssues,
  });

  // --- Stage 21 NEXT 1-9: JD Priority Matrix, positioning/ranking, recruiter quality, ATS coverage ---
  // The JD is NEVER treated as candidate evidence here — buildJdPriorityMatrix only classifies JD
  // requirements by tier; evidenceStrength for every one of them is computed against
  // masterResumeProfile exclusively (see jdPriorityMatrix.ts).
  const jdPriorityMatrixResult = buildJdPriorityMatrix(jobRequirements, targetRoleTitle ?? null, masterResumeProfile);
  const recruiterQualityAssessment = evaluateRecruiterQuality({
    resume,
    matrix: jdPriorityMatrixResult,
    candidateProfile: masterResumeProfile,
    genericBulletsCount: bullets.genericBullets.length,
    bannedLanguageCount: bullets.bannedLanguageCount,
    duplicateBulletCount: bullets.duplicateBulletCount,
    recruiterReadabilityScore,
  });
  const atsCoverageReportResult = buildAtsCoverageReport(resume, jdPriorityMatrixResult);

  return {
    overallScore,
    atsScore: clamp(ats.atsScore),
    keywordAlignmentScore: clamp(ats.keywordAlignmentScore),
    truthfulnessScore: clamp(truthfulness.truthfulnessScore),
    architectureConsistencyScore: clamp(architecture.architectureConsistencyScore),
    recruiterReadabilityScore,
    formattingScore: clamp(structural.formattingScore - contractFormattingPenalty),

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
    blockingFailures,
    jdPriorityMatrix: jdPriorityMatrixResult,
    recruiterQualityAssessment,
    atsCoverageReport: atsCoverageReportResult,
  };
}

/** ResumeReviewerAgent implementation. No network, no AI provider — see this file's module doc. */
export class DeterministicResumeReviewer implements ResumeReviewerAgent {
  async review(input: ResumeReviewerInput): Promise<ResumeReviewerOutput> {
    const review = reviewResumeDeterministically(input);
    return { review };
  }
}
