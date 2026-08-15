import type {
  DescriptionSections,
  H1bCompanyConfidence,
  JobCertification,
  JobSkill,
  RequirementTriState,
  Seniority,
  SponsorshipPolarity,
} from "@/types";
import type { AppSettings } from "@/lib/settings";
import { candidateProfileHash, loadCandidateProfile } from "./candidateProfile";
import { computeCandidateSettingsHash } from "./candidateSettingsHash";
import { decide } from "./decision";
import { evaluateEligibility } from "./eligibility";
import { computeTotalYearsExperience } from "./experienceDuration";
import { hashJdContent } from "./matchIdentity";
import { computeMatchKnowledgeHash } from "./matchKnowledgeHash";
import { normalizeCandidateSkills, unrecognizedCandidateSkillNames } from "./normalizeCandidateSkills";
import {
  buildCertificationUnits,
  buildEducationUnit,
  collapseSkillUnits,
  type EducationRequirementInput,
} from "./requirementUnits";
import {
  computeCoverageDimensionScore,
  computeEmployerEvidencedShare,
  computeOverallScore,
  computeRequirementCoverage,
  criticalGaps as computeCriticalGaps,
  isInsufficientJdSignal,
  MATCH_ENGINE_VERSION,
} from "./scoring";
import { estimateCandidateSeniority, seniorityAlignmentScore } from "./seniority";
import { matchAllRequirementUnits } from "./skillMatching";
import { recommendTrack } from "./trackRecommendation";
import { detectUnclaimedRequirements } from "./unclaimedRequirementDetector";
import type { DimensionScores, EvaluateMatchResult, JobMatchResult } from "./types";

/**
 * The single orchestrator every Phase 2 caller (single-job API, batch API) goes through — pure
 * function, no DB access itself (the caller assembles EvaluateJobMatchInput from Phase 1's own
 * getJob()/getAppSettings() query layers). Never calls AI (zero new AI tasks in V1 — see
 * CAREER_OPS_HANDOFF.md's approved Phase 2 architecture).
 */
export interface EvaluateJobMatchInput {
  jobId: number;
  dedupeKey: string;
  jobTitle: string;
  descriptionText: string | null;
  descriptionSections: DescriptionSections | null;
  skills: JobSkill[];
  certifications: JobCertification[];
  education: EducationRequirementInput;
  sponsorshipPolarity: SponsorshipPolarity;
  companyH1bConfidence: H1bCompanyConfidence;
  clearanceRequired: RequirementTriState | null;
  clearanceLevel: string | null;
  citizenshipRequired: RequirementTriState | null;
  workAuthorizationRequired: RequirementTriState | null;
  jobSeniority: Seniority;
  experienceMinYears: number | null;
}

function clampExperienceScore(candidateYears: number, minYears: number): number {
  if (minYears <= 0) return 1;
  return Math.max(0, Math.min(1, candidateYears / minYears));
}

export function evaluateJobMatch(
  input: EvaluateJobMatchInput,
  candidateSettings: AppSettings["candidate"],
  candidateId: number
): EvaluateMatchResult {
  const profileLoad = loadCandidateProfile(candidateId);
  if (profileLoad.status === "missing") return { status: "unavailable", reason: "missing_candidate_profile" };
  // "invalid" (corrupt/malformed JSON, wrong schema version) is treated the same as missing — never
  // usable, never partially trusted.
  if (profileLoad.status === "invalid") return { status: "unavailable", reason: "missing_candidate_profile" };
  if (profileLoad.status === "stale") return { status: "unavailable", reason: "stale_candidate_profile" };

  const profile = profileLoad.profile;
  const normalizedSkills = normalizeCandidateSkills(profile);

  const skillUnits = collapseSkillUnits(input.skills, input.jobTitle);
  const certUnits = buildCertificationUnits(input.certifications, input.jobTitle);
  const eduUnit = buildEducationUnit(input.education);

  const alreadyClaimedEvidence = [
    ...skillUnits.flatMap((u) => u.evidenceSnippets),
    ...certUnits.flatMap((u) => u.evidenceSnippets),
    ...(eduUnit ? eduUnit.evidenceSnippets : []),
  ];
  const unclaimedUnits = detectUnclaimedRequirements({
    jobTitle: input.jobTitle,
    requiredQualificationsText: input.descriptionSections?.qualifications ?? null,
    preferredQualificationsText: input.descriptionSections?.niceToHave ?? null,
    alreadyClaimedEvidence,
  });

  const allUnits = [...skillUnits, ...certUnits, ...(eduUnit ? [eduUnit] : []), ...unclaimedUnits];
  const allMatches = matchAllRequirementUnits(allUnits, profile, normalizedSkills);
  const requiredMatches = allMatches.filter((m) => m.requirement.requirementLevel === "Required");
  const preferredMatches = allMatches.filter((m) => m.requirement.requirementLevel === "Preferred");

  const seniorityEstimate = estimateCandidateSeniority(profile.experience);
  const seniorityScore = seniorityAlignmentScore(input.jobSeniority, seniorityEstimate.level);
  // Derived deterministically from experience[].startDate/endDate via interval-union math — never
  // trusts a raw profile.totalYearsExperience value even if build-candidate-profile populated one,
  // per that skill's own instructions (it's told to leave this null and let the app compute it).
  const totalYearsExperience = computeTotalYearsExperience(profile.experience);
  const experienceScore =
    input.experienceMinYears === null || totalYearsExperience === null
      ? null
      : clampExperienceScore(totalYearsExperience, input.experienceMinYears) * 100;

  const dimensionScores: DimensionScores = {
    required: computeCoverageDimensionScore(requiredMatches),
    preferred: computeCoverageDimensionScore(preferredMatches),
    experience: experienceScore,
    seniority: seniorityScore === null ? null : seniorityScore * 100,
  };

  const overallScore = computeOverallScore(dimensionScores);
  const requirementCoverage = computeRequirementCoverage(allMatches);
  const employerEvidencedShare = computeEmployerEvidencedShare(requiredMatches);
  const insufficientJdSignal = isInsufficientJdSignal(allMatches);
  const gaps = computeCriticalGaps(allMatches);

  const eligibility = evaluateEligibility(
    {
      sponsorshipPolarity: input.sponsorshipPolarity,
      companyH1bConfidence: input.companyH1bConfidence,
      clearanceRequired: input.clearanceRequired,
      clearanceLevel: input.clearanceLevel,
      citizenshipRequired: input.citizenshipRequired,
      workAuthorizationRequired: input.workAuthorizationRequired,
    },
    candidateSettings
  );

  const { decision, blockingReasons } = decide({
    eligibility,
    insufficientJdSignal,
    criticalGaps: gaps,
    overallScore,
    requirementCoverage,
    employerEvidencedShare,
  });

  const result: JobMatchResult = {
    candidateId,
    jobId: input.jobId,
    dedupeKey: input.dedupeKey,
    matchEngineVersion: MATCH_ENGINE_VERSION,
    matchKnowledgeHash: computeMatchKnowledgeHash(),
    candidateProfileHash: candidateProfileHash(profile),
    candidateSettingsHash: computeCandidateSettingsHash(candidateSettings),
    jdContentHash: hashJdContent(input.jobTitle, input.descriptionText),
    computedAt: new Date().toISOString(),
    eligibility,
    dimensionScores,
    overallScore,
    requirementCoverage,
    employerEvidencedShare,
    insufficientJdSignal,
    employerEvidencedMatches: allMatches.filter((m) => m.matchType === "MATCHED" && m.evidence?.source === "employer"),
    inventoryOnlyMatches: allMatches.filter((m) => m.matchType === "MATCHED" && m.evidence?.source === "inventory_only"),
    transferableMatches: allMatches.filter((m) => m.matchType === "TRANSFERABLE"),
    missingRequirements: allMatches.filter((m) => m.matchType === "MISSING"),
    unresolvedRequirements: allMatches.filter((m) => m.matchType === "UNRESOLVED"),
    criticalGaps: gaps,
    unrecognizedCandidateSkills: unrecognizedCandidateSkillNames(normalizedSkills),
    recommendedTrack: recommendTrack(allUnits),
    decision,
    blockingReasons,
  };

  return { status: "ok", data: result };
}
