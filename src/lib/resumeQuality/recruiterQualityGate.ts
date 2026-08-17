import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../tools/tailoring-engine/types";
import { evaluateBulletOrdering } from "./bulletRanking";
import type { JdPriorityMatrix } from "./jdPriorityMatrix";
import { evaluatePositioning } from "./positioningEngine";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./reviewers/skillAliases";
import { recommendedSkillOrder } from "./skillRanking";
import type { ComplianceStatus } from "./types";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 8: the Recruiter Quality Gate. Answers the
 * mission's own ten questions deterministically, each mapped to an existing or new Stage 21 check
 * (never a duplicate implementation — target-role-clarity and excessive-secondary-tech-emphasis reuse
 * positioningEngine.ts verbatim; top-bullet-relevance reuses bulletRanking.ts; generic/repetitive
 * language and readability reuse the counts the deterministic reviewer already computes via
 * bulletChecks.ts).
 *
 * "Exaggeration" is deliberately NOT reinvented here — StructuredResumeReview.blockingFailures
 * (UNSUPPORTED_METRIC/UNSUPPORTED_CLAIM) already owns that class of defect with real evidence-search
 * detail; duplicating it into a second, softer taxonomy would risk the two disagreeing.
 *
 * severity: BLOCKING dimensions can fail READY on their own (target role clarity, secondary-tech
 * hijack — the two the mission's own "Prevent the exact failure" language is about); every other
 * dimension is ADVISORY — it lowers the aggregate score and produces a correction, but per the
 * mission's own "a high aggregate score cannot override blocking truthfulness failures" (and,
 * symmetrically, a low advisory score alone cannot block a resume that has no real defect), ADVISORY
 * issues never block READY by themselves.
 */

export interface RecruiterQualityIssue {
  dimension:
    | "targetRoleClarity"
    | "firstTenSecondFit"
    | "topSkillRelevance"
    | "topBulletRelevance"
    | "excessiveSecondaryTechEmphasis"
    | "genericOrRepetitiveLanguage"
    | "underselling"
    | "readability";
  severity: "BLOCKING" | "ADVISORY";
  description: string;
}

export interface RecruiterQualityAssessment {
  status: ComplianceStatus;
  score: number; // 0-100, diagnostic only — never overrides blockingFailures/instructionCompliance
  issues: RecruiterQualityIssue[];
}

export interface EvaluateRecruiterQualityInput {
  resume: ResumeContent;
  matrix: JdPriorityMatrix;
  candidateProfile: CandidateProfile | undefined;
  genericBulletsCount: number;
  bannedLanguageCount: number;
  duplicateBulletCount: number;
  recruiterReadabilityScore: number;
}

function resumeFullText(resume: ResumeContent): string {
  return [resume.tagline, ...resume.summary, ...resume.skillGroups.flatMap((g) => g.items), ...resume.experience.flatMap((e) => e.bullets)].join(
    "\n"
  );
}

/** A strongly-evidenced P1 requirement that never appears ANYWHERE on the resume at all — the
 *  candidate's real strength is being left out entirely, the deterministic proxy for "underselling"
 *  this module uses (never a subjective tone judgment). */
function evaluateUnderselling(resume: ResumeContent, matrix: JdPriorityMatrix): RecruiterQualityIssue[] {
  const present = extractCanonicalSkillsFromText(resumeFullText(resume));
  const missingStrongP1 = matrix.requirements.filter(
    (r) => r.priority === "P1" && r.evidenceStrength === "STRONG" && !r.memberSkillNames.some((m) => present.has(resolveSkillForReview(m)?.canonical ?? m))
  );
  return missingStrongP1.map((r) => ({
    dimension: "underselling" as const,
    severity: "ADVISORY" as const,
    description: `"${r.requirement}" is a P1 (core) JD requirement the candidate has STRONG evidence for (used at a real employer) but it never appears anywhere on the resume — the candidate's genuine strength is being undersold.`,
  }));
}

/** The recommended top-N skills (from skillRanking.ts) should appear somewhere near the top of the
 *  resume's OWN skill listing — checked against the first group's first few items only, the section a
 *  recruiter actually scans first, not the whole resume. */
function evaluateTopSkillRelevance(resume: ResumeContent, candidateProfile: CandidateProfile | undefined, matrix: JdPriorityMatrix): RecruiterQualityIssue[] {
  if (!candidateProfile) return [];
  const topRecommended = recommendedSkillOrder(candidateProfile, matrix).slice(0, 3);
  if (topRecommended.length === 0) return [];
  const firstGroupItems = new Set(
    (resume.skillGroups[0]?.items ?? []).map((i) => resolveSkillForReview(i)?.canonical ?? i)
  );
  const missing = topRecommended.filter((s) => !firstGroupItems.has(s));
  if (missing.length === topRecommended.length) {
    return [
      {
        dimension: "topSkillRelevance",
        severity: "ADVISORY",
        description: `None of the top-ranked skills for this JD (${topRecommended.join(", ")}) appear in the resume's first Technical Skills group — the most JD-relevant skills are not immediately visible.`,
      },
    ];
  }
  return [];
}

export function evaluateRecruiterQuality(input: EvaluateRecruiterQualityInput): RecruiterQualityAssessment {
  const { resume, matrix, candidateProfile } = input;
  const positioning = evaluatePositioning(resume, matrix);
  const bulletOrderingIssues = evaluateBulletOrdering(resume.experience, matrix);

  const issues: RecruiterQualityIssue[] = [];

  for (const issue of positioning.issues) {
    const dimension = issue.includes("secondary technology") ? "excessiveSecondaryTechEmphasis" : "targetRoleClarity";
    issues.push({ dimension, severity: "BLOCKING", description: issue });
  }
  if (positioning.status === "FAIL") {
    issues.push({ dimension: "firstTenSecondFit", severity: "BLOCKING", description: "Positioning failures above mean a recruiter cannot establish role fit within the first ~10 seconds of reading." });
  }

  for (const bulletIssue of bulletOrderingIssues) {
    issues.push({ dimension: "topBulletRelevance", severity: "ADVISORY", description: bulletIssue.description });
  }

  issues.push(...evaluateTopSkillRelevance(resume, candidateProfile, matrix));
  issues.push(...evaluateUnderselling(resume, matrix));

  if (input.genericBulletsCount > 0 || input.bannedLanguageCount > 0 || input.duplicateBulletCount > 0) {
    issues.push({
      dimension: "genericOrRepetitiveLanguage",
      severity: "ADVISORY",
      description: `${input.genericBulletsCount} generic bullet(s), ${input.bannedLanguageCount} banned-language instance(s), ${input.duplicateBulletCount} duplicate bullet(s) detected.`,
    });
  }

  if (input.recruiterReadabilityScore < 70) {
    issues.push({
      dimension: "readability",
      severity: "ADVISORY",
      description: `Recruiter readability score (${input.recruiterReadabilityScore}) is below the 70-point threshold.`,
    });
  }

  const blockingCount = issues.filter((i) => i.severity === "BLOCKING").length;
  const advisoryCount = issues.filter((i) => i.severity === "ADVISORY").length;
  const score = Math.max(0, 100 - blockingCount * 30 - advisoryCount * 10);

  let status: ComplianceStatus = "PASS";
  if (blockingCount > 0) status = "FAIL";
  else if (positioning.status === "REVIEW") status = "REVIEW";

  return { status, score, issues };
}
