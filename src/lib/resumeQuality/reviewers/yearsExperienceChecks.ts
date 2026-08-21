import { computeTotalYearsExperience } from "@/lib/match/experienceDuration";
import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * YEARS-OF-EXPERIENCE AND EDUCATION HONESTY. Two independently checkable directions:
 *   - Inflation: an explicit "N+ years" claim in the resume text is checked first against an
 *     authoritative total explicitly stated by the Master Resume (CandidateProfile's
 *     totalYearsExperience). When no stated total exists, Phase 2's own
 *     computeTotalYearsExperience is reused verbatim as the fallback.
 *     Downplaying (claiming FEWER years than actual) has no analogous deterministic proof — a resume
 *     is never required to state a years figure at all, so silence is never evidence of dishonesty —
 *     and is intentionally not flagged, matching the spec's own "detected where deterministically
 *     provable" scoping (test item 42).
 *   - Education: a Master Resume with recorded education must not have an EMPTY resume.education —
 *     that is the one deterministically provable "hidden degree" signal available without semantic
 *     comparison of degree levels.
 */

export interface YearsExperienceCheckResult {
  inflationIssues: string[];
  educationHidden: boolean;
  insufficientProfileData: boolean;
}

const YEARS_CLAIM_RE = /\b(\d{1,2})\+?\s*years?\b/gi;

export function evaluateYearsExperienceAndEducationHonesty(
  resume: ResumeContent,
  masterResumeProfile: CandidateProfile | undefined,
  now: Date = new Date()
): YearsExperienceCheckResult {
  if (!masterResumeProfile) {
    return { inflationIssues: [], educationHidden: false, insufficientProfileData: true };
  }

  const statedYears = masterResumeProfile.totalYearsExperience;
  const hasAuthoritativeTotal = statedYears !== null && Number.isFinite(statedYears) && statedYears > 0;
  const supportedYears = hasAuthoritativeTotal
    ? statedYears
    : computeTotalYearsExperience(masterResumeProfile.experience, now);
  const inflationIssues: string[] = [];

  if (supportedYears !== null) {
    const searchText = [...resume.summary, ...resume.skillGroups.flatMap((g) => g.items)].join(" ");
    let match: RegExpExecArray | null;
    const re = new RegExp(YEARS_CLAIM_RE);
    while ((match = re.exec(searchText)) !== null) {
      const claimedYears = Number(match[1]);
      // An explicit Master Resume total is already the controlling rounded career claim, so it is a
      // hard ceiling. Derived chronology keeps the existing +1 tolerance for ordinary rounding.
      const exceedsEvidence = hasAuthoritativeTotal
        ? claimedYears > supportedYears
        : claimedYears > supportedYears + 1;
      if (exceedsEvidence) {
        const evidenceDescription = hasAuthoritativeTotal
          ? `the Master Resume explicitly supports ${supportedYears} years of total experience`
          : `the Master Resume's own chronology supports only ~${supportedYears.toFixed(1)} years of total experience`;
        inflationIssues.push(`Resume claims "${match[0]}" but ${evidenceDescription}.`);
      }
    }
  }

  const educationHidden = masterResumeProfile.education.length > 0 && resume.education.length === 0;

  return { inflationIssues, educationHidden, insufficientProfileData: false };
}
