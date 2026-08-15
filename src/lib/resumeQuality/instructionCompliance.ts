import { currentInstructionIdentity } from "./canonicalInstructions";
import type { LaundryListFinding } from "./reviewers/onePrimaryTechnologyCheck";
import type { TechnologyGroupingFinding } from "./reviewers/technologyGroupingCheck";
import type { ComplianceStatus, InstructionComplianceChecks, InstructionComplianceResult, MetricProvenanceResult, RequiredCorrection } from "./types";

/**
 * Phase 3 Resume Quality Hardening — the single place every already-computed check result (existing
 * Stage 8 checks PLUS this hardening pass's new checks) is mapped onto the canonical instruction's
 * 22 named guardrails. Pure synthesis only: this module runs zero checks of its own — every input
 * field here was already computed by an existing or new reviewers/*.ts module, called once by
 * deterministicReviewer.ts. That keeps this file the single source of the CHECK NAME -> RESULT
 * mapping without duplicating any detection logic.
 */

// --- Hard-gate policy (Section 6 of the hardening spec) ---------------------------------------------
//
// A hard-gate check's FAIL always blocks READY (see qualityGate.ts). A soft check's result still
// feeds requiredCorrections/notes and CAN block READY when materially violated (mapped to FAIL, not
// merely REVIEW) — the FAIL/REVIEW distinction itself is what separates "must fix" from "worth a
// human glance," not hard-vs-soft. Hard-gate membership is about which checks get a special
// "zero tolerance, cannot be waived by a high overall score" guarantee.

export const HARD_GATE_CHECKS: readonly (keyof InstructionComplianceChecks)[] = [
  "hardCareerFacts",
  "masterSkillsInventoryCompliance",
  "architectureIntegrity",
  "onePrimaryTechnologyPerResponsibility",
  "metricInferencePolicy",
  "noContradictingTechnologies",
  "crossDocumentConsistency",
  "yearsExperienceEducationHonesty",
  "employmentTypeHandling",
  "atsFormatting",
  "finalValidation",
];

/** Everything else: deepRewrite, technologyGrouping, keywordOptimization, technologyAdaptation,
 *  migrationIntegrity, bulletWriting, everySentenceAtsChecklist, bannedLanguage,
 *  noDuplicateBulletPhrasing, verbTenseConsistency, resumeLengthBulletCaps — quality/style signals
 *  per the spec's own list ("deep rewrite, bullet quality, duplicate phrasing, keyword optimization,
 *  verb diversity may contribute to score/corrections and should block READY when materially
 *  violated"). These still surface as FAIL (not silently downgraded to REVIEW) when a real violation
 *  is found — evaluateQualityGate() requires ALL 22 checks to PASS, hard or soft, so a soft-gate FAIL
 *  still blocks READY exactly as the spec requires; the distinction only matters for how a caller
 *  might choose to prioritize/triage, not for whether READY is reachable. */
export const SOFT_GATE_CHECKS: readonly (keyof InstructionComplianceChecks)[] = [
  "deepRewrite",
  "technologyGrouping",
  "keywordOptimization",
  "technologyAdaptation",
  "migrationIntegrity",
  "bulletWriting",
  "everySentenceAtsChecklist",
  "bannedLanguage",
  "noDuplicateBulletPhrasing",
  "verbTenseConsistency",
  "resumeLengthBulletCaps",
];

export interface EvaluateInstructionComplianceInput {
  // Identity/availability flags
  hasMasterProfile: boolean;
  hasJobRequirements: boolean;
  hasCoverLetter: boolean;

  // Hard facts (from truthfulnessChecks.evaluateTruthfulness)
  employmentOrEducationBlockingIssues: string[]; // truthfulness.blockingIssues
  employmentOrEducationSoftIssues: string[]; // truthfulness.truthfulnessIssues (title/date/edu mismatches)

  // MSI compliance (from msiComplianceChecks.evaluateMsiCompliance)
  ungroundedTechnologies: string[];

  // Deep rewrite (from deepRewriteCheck.evaluateDeepRewrite)
  deepRewriteStatus: ComplianceStatus;

  // Architecture / contradictions (from architectureChecks.evaluateArchitectureConsistency, extended
  // to also scan the cover letter — see deterministicReviewer.ts)
  architectureContradictions: string[]; // resume-only, bullet-level
  coverLetterContradictions: string[]; // cover-letter-only technology contradictions, same group logic

  // Technology grouping (from technologyGroupingCheck.evaluateTechnologyGrouping)
  technologyGroupingFindings: TechnologyGroupingFinding[];

  // One-primary-technology laundry-list bullets (from onePrimaryTechnologyCheck)
  laundryListFindings: LaundryListFinding[];

  // Metric inference policy (from metricProvenanceChecks.evaluateMetricProvenance)
  metricProvenance: MetricProvenanceResult;
  suspiciousRepeatedMetrics: string[]; // truthfulnessChecks' existing checkMetricRealism output

  // Keyword optimization (from atsChecks.evaluateAtsAlignment)
  atsScore: number;
  keywordAlignmentScore: number;
  insufficientRequirementData: boolean;

  // Bullet writing / ATS-sentence checklist (from bulletChecks.evaluateBulletChecks)
  genericBulletsCount: number;
  bannedLanguageInBulletsCount: number;
  overlyLongOrShortCount: number;

  // Banned language in the Professional Summary (from summaryChecks.evaluateSummaryAlignment)
  bannedLanguageInSummaryCount: number;

  // Cross-document consistency (from crossDocumentChecks.evaluateCrossDocumentConsistency)
  crossDocumentStatus: ComplianceStatus;
  crossDocumentContradictions: string[];

  // Duplicate bullet phrasing — derived from bulletChecks' own corrections (HIGH-priority duplicate
  // findings), passed through rather than re-detected.
  duplicateBulletCount: number;

  // Years-of-experience / education honesty (from yearsExperienceChecks)
  yearsInflationIssues: string[];
  educationHidden: boolean;

  // Employment-type handling (from employmentTypeChecks)
  employmentTypeStatus: ComplianceStatus;
  employmentTypeFlags: string[];

  // Resume length / bullet caps + verb tense (from lengthAndTenseChecks)
  bulletCapViolations: number;
  verbTenseViolations: number;

  // ATS/DOCX formatting (structuralChecks.formattingScore/blockingIssues + optional real DOCX
  // validation, when the caller already has rendered files — see ResumeReviewerInput.docxValidation)
  structuralBlockingIssues: string[];
  formattingScore: number;
  docxValidation?: { resume?: { valid: boolean; violations: string[] }; coverLetter?: { valid: boolean; violations: string[] } };

  // Aggregate signal used only for the finalValidation meta-check.
  anyBlockingIssues: boolean;
}

function statusFromCounts(blockingCount: number, softCount: number): ComplianceStatus {
  if (blockingCount > 0) return "FAIL";
  if (softCount > 0) return "REVIEW";
  return "PASS";
}

export function evaluateInstructionCompliance(input: EvaluateInstructionComplianceInput): InstructionComplianceResult {
  const notes: string[] = [];
  const checks = {} as InstructionComplianceChecks;

  // A. Hard career facts
  checks.hardCareerFacts = !input.hasMasterProfile
    ? "REVIEW"
    : statusFromCounts(input.employmentOrEducationBlockingIssues.length, input.employmentOrEducationSoftIssues.length);
  if (!input.hasMasterProfile) notes.push("No Master Resume profile supplied — hard career facts could not be verified.");
  notes.push(...input.employmentOrEducationBlockingIssues, ...input.employmentOrEducationSoftIssues);

  // B. MSI compliance
  checks.masterSkillsInventoryCompliance = !input.hasMasterProfile
    ? "REVIEW"
    : input.ungroundedTechnologies.length > 0
      ? "FAIL"
      : "PASS";
  if (input.ungroundedTechnologies.length > 0) {
    notes.push(`Technologies with no grounding in the Master Resume/Skills Inventory: ${input.ungroundedTechnologies.join(", ")}`);
  }

  // C. Deep rewrite
  checks.deepRewrite = input.deepRewriteStatus;

  // D. Architecture integrity (resume-scoped only — cover letter contradictions live under
  // noContradictingTechnologies per the canonical text's own explicit "scan resume AND cover letter"
  // scope for that specific guardrail).
  checks.architectureIntegrity = input.architectureContradictions.length > 0 ? "FAIL" : "PASS";
  notes.push(...input.architectureContradictions);

  // E. Technology grouping
  checks.technologyGrouping = input.technologyGroupingFindings.length > 0 ? "REVIEW" : "PASS";
  for (const f of input.technologyGroupingFindings) {
    notes.push(`Technical Skills group "${f.groupLabel}" mixes ${f.providersFound.join("/")} without a migration/integration framing.`);
  }

  // F. One primary technology per responsibility
  checks.onePrimaryTechnologyPerResponsibility = input.laundryListFindings.length > 0 ? "FAIL" : "PASS";
  for (const f of input.laundryListFindings) {
    notes.push(`${f.role}: laundry-list bullet names ${f.technologiesFound.length} distinct major technologies with no single clear primary responsibility: "${f.bullet}"`);
  }

  // H. Metric inference policy
  checks.metricInferencePolicy =
    input.metricProvenance.unsupportedCount > 0 || input.suspiciousRepeatedMetrics.length > 0 ? "FAIL" : "PASS";
  for (const e of input.metricProvenance.entries) {
    if (e.category === "UNSUPPORTED") notes.push(`Unsupported metric category: "${e.bullet}" — ${e.reason}`);
  }
  notes.push(...input.suspiciousRepeatedMetrics);

  // I. Keyword optimization
  checks.keywordOptimization = input.insufficientRequirementData
    ? "REVIEW"
    : input.atsScore >= 70 && input.keywordAlignmentScore >= 50
      ? "PASS"
      : "REVIEW";

  // J/K. Technology adaptation / migration integrity — share the same underlying migration-language
  // signal (technologyGroups.ts's hasMigrationSignal, already folded into architectureContradictions/
  // coverLetterContradictions never firing when present). If no contradiction was ever detected at
  // all, there was nothing requiring adaptation/migration framing to begin with — PASS by default,
  // not merely REVIEW, since "no competing tools present" trivially satisfies "any competing tools
  // present are properly framed as migration."
  const hasAnyContradiction = input.architectureContradictions.length > 0 || input.coverLetterContradictions.length > 0;
  checks.technologyAdaptation = hasAnyContradiction ? "FAIL" : "PASS";
  checks.migrationIntegrity = hasAnyContradiction ? "FAIL" : "PASS";

  // L. No contradicting technologies — resume AND cover letter, per the canonical text's explicit
  // scope for this specific guardrail.
  checks.noContradictingTechnologies =
    input.architectureContradictions.length > 0 || input.coverLetterContradictions.length > 0 ? "FAIL" : "PASS";
  notes.push(...input.coverLetterContradictions);

  // M. Bullet writing
  checks.bulletWriting = input.genericBulletsCount > 0 || input.bannedLanguageInBulletsCount > 0 ? "FAIL" : "PASS";

  // N. Every-sentence ATS checklist
  checks.everySentenceAtsChecklist = input.overlyLongOrShortCount > 0 ? "REVIEW" : "PASS";

  // O. Cross-document consistency
  checks.crossDocumentConsistency = input.crossDocumentStatus;
  notes.push(...input.crossDocumentContradictions);

  // P. Banned AI language (bullets + summary, combined)
  const bannedTotal = input.bannedLanguageInBulletsCount + input.bannedLanguageInSummaryCount;
  checks.bannedLanguage = bannedTotal > 0 ? "FAIL" : "PASS";

  // Q. No duplicate bullet phrasing
  checks.noDuplicateBulletPhrasing = input.duplicateBulletCount > 0 ? "FAIL" : "PASS";

  // R. Years of experience / education honesty
  checks.yearsExperienceEducationHonesty = !input.hasMasterProfile
    ? "REVIEW"
    : input.yearsInflationIssues.length > 0 || input.educationHidden
      ? "FAIL"
      : "PASS";
  notes.push(...input.yearsInflationIssues);
  if (input.educationHidden) notes.push("Master Resume records education that is missing entirely from the tailored resume.");

  // S. Employment-type handling
  checks.employmentTypeHandling = input.employmentTypeStatus;
  notes.push(...input.employmentTypeFlags);

  // T. Resume length / bullet caps (verb tense is its own named check, U, below — the canonical
  // standard lists them as two separate guardrails even though one module computes both).
  checks.resumeLengthBulletCaps = input.bulletCapViolations > 0 ? "FAIL" : "PASS";

  // U. Verb tense consistency
  checks.verbTenseConsistency = input.verbTenseViolations > 0 ? "FAIL" : "PASS";

  // V. ATS formatting — structural (always available, from the ResumeContent JSON shape) PLUS real
  // rendered-DOCX validation as an ENHANCEMENT when the caller already has it (see
  // ResumeReviewerInput.docxValidation's own doc comment on why it's often not yet available at
  // review time, and orchestrator.ts for the one call site that supplies it once the .docx actually
  // exists). Absent docxValidation is NOT treated as "unverified, block READY" — the structural JSON
  // check alone is a real, meaningful signal (missing sections, malformed roles), and requiring an
  // already-rendered file to exist before a review can ever PASS would make iteration 1 permanently
  // un-READY-able for any caller that reviews before rendering. A genuine DOCX-level violation, once
  // actually detected, still fails regardless.
  const structuralFail = input.structuralBlockingIssues.length > 0 || input.formattingScore < 70;
  const docxViolations = [...(input.docxValidation?.resume?.violations ?? []), ...(input.docxValidation?.coverLetter?.violations ?? [])];
  checks.atsFormatting = structuralFail || docxViolations.length > 0 ? "FAIL" : "PASS";
  notes.push(...input.structuralBlockingIssues, ...docxViolations);

  // W. Final validation — meta-check: every OTHER hard-gate check must PASS, plus no blocking issues
  // anywhere in the review. This is never independently "found" — it is the synthesis itself.
  const otherHardGateChecks = HARD_GATE_CHECKS.filter((name) => name !== "finalValidation");
  const anyHardGateNotPass = otherHardGateChecks.some((name) => checks[name] !== "PASS");
  checks.finalValidation = input.anyBlockingIssues || anyHardGateNotPass ? "FAIL" : "PASS";

  const identity = currentInstructionIdentity();
  return { instructionVersion: identity.instructionVersion, instructionHash: identity.instructionHash, checks, notes: notes.filter((n) => n.length > 0) };
}

/** Every hard-gate check that is not PASS, formatted as a CRITICAL requiredCorrection — this is what
 *  actually blocks evaluateQualityGate() from returning READY (see qualityGate.ts, which requires
 *  every hard-gate check to PASS in addition to its pre-existing four conditions). */
export function hardGateFailureCorrections(compliance: InstructionComplianceResult): RequiredCorrection[] {
  const corrections: RequiredCorrection[] = [];
  for (const name of HARD_GATE_CHECKS) {
    const status = compliance.checks[name];
    if (status !== "PASS") {
      corrections.push({
        priority: "CRITICAL",
        description: `Canonical instruction compliance — ${name}: ${status}. This is a hard-gate check and must PASS before this resume can be marked READY.`,
      });
    }
  }
  return corrections;
}

/** True only when EVERY one of the 22 named checks is PASS — the exact condition
 *  evaluateQualityGate() requires (soft-gate FAILs block READY too, per the spec; only REVIEW is
 *  tolerated as "not yet verified" rather than "known violation" for genuinely ambiguous evidence —
 *  and REVIEW on a check this function treats as NOT all-PASS, so it still blocks READY, matching
 *  "the writer's self-validation is NOT sufficient" / "never silently mark as compliant"). */
export function allChecksPass(compliance: InstructionComplianceResult): boolean {
  return Object.values(compliance.checks).every((status) => status === "PASS");
}
