import { computeTotalYearsExperience } from "@/lib/match/experienceDuration";
import type { CandidateProfile } from "@/lib/match/types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * YEARS-OF-EXPERIENCE AND EDUCATION HONESTY. Two independently checkable directions:
 *   - Inflation: an explicit "N+ years" claim in the resume text that exceeds the REAL total years
 *     derivable from CandidateProfile.experience (Phase 2's own computeTotalYearsExperience —
 *     reused verbatim, not reimplemented) is deterministically provable and always flagged.
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
  masterResumeProfile: CandidateProfile | undefined
): YearsExperienceCheckResult {
  if (!masterResumeProfile) {
    return { inflationIssues: [], educationHidden: false, insufficientProfileData: true };
  }

  const realYears = computeTotalYearsExperience(masterResumeProfile.experience);
  const inflationIssues: string[] = [];

  if (realYears !== null) {
    const searchText = [...resume.summary, ...resume.skillGroups.flatMap((g) => g.items)].join(" ");
    let match: RegExpExecArray | null;
    const re = new RegExp(YEARS_CLAIM_RE);
    while ((match = re.exec(searchText)) !== null) {
      const claimedYears = Number(match[1]);
      // A generous +1 tolerance for rounding ("8 years" for 7.4 actual) — only genuine inflation
      // beyond ordinary rounding is flagged, never a one-year rounding difference.
      if (claimedYears > realYears + 1) {
        inflationIssues.push(`Resume claims "${match[0]}" but the Master Resume's own chronology supports only ~${Math.floor(realYears)} years of total experience.`);
      }
    }
  }

  const educationHidden = masterResumeProfile.education.length > 0 && resume.education.length === 0;

  return { inflationIssues, educationHidden, insufficientProfileData: false };
}
