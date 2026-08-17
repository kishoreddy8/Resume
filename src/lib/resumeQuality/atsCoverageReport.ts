import type { ResumeContent } from "../../../tools/tailoring-engine/types";
import type { JdPriorityMatrix, JdPriorityTier } from "./jdPriorityMatrix";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./reviewers/skillAliases";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 9: the ATS Coverage Report. Makes explicit,
 * for every JD requirement, WHY it is or isn't on the resume — the exact distinction the mission
 * requires never be collapsed:
 *
 *   SUPPORTED_AND_REPRESENTED — candidate has evidence AND the resume currently states it
 *   SUPPORTED_BUT_MISSING     — candidate has evidence but the CURRENT resume text omits it
 *   UNSUPPORTED               — candidate has no evidence at all; MUST NEVER be "corrected" into a
 *                                resume edit that adds the keyword — that would be fabrication, not
 *                                tailoring. Nothing in this module writes to the resume; it only
 *                                reports.
 */

export const ATS_COVERAGE_STATUSES = ["SUPPORTED_AND_REPRESENTED", "SUPPORTED_BUT_MISSING", "UNSUPPORTED"] as const;
export type AtsCoverageStatus = (typeof ATS_COVERAGE_STATUSES)[number];

export interface AtsCoverageEntry {
  requirement: string;
  priority: JdPriorityTier;
  status: AtsCoverageStatus;
}

export function buildAtsCoverageReport(resume: ResumeContent, matrix: JdPriorityMatrix): AtsCoverageEntry[] {
  const resumeSkills = extractCanonicalSkillsFromText(
    [resume.tagline, ...resume.summary, ...resume.skillGroups.flatMap((g) => g.items), ...resume.experience.flatMap((e) => e.bullets)].join("\n")
  );

  return matrix.requirements.map((req) => {
    if (req.evidenceStrength === "NONE") {
      return { requirement: req.requirement, priority: req.priority, status: "UNSUPPORTED" as const };
    }
    const represented = req.memberSkillNames.some((m) => resumeSkills.has(resolveSkillForReview(m)?.canonical ?? m));
    return {
      requirement: req.requirement,
      priority: req.priority,
      status: represented ? ("SUPPORTED_AND_REPRESENTED" as const) : ("SUPPORTED_BUT_MISSING" as const),
    };
  });
}

/** Human-readable rendering, e.g. for a written report artifact: "Snowflake | P1 | SUPPORTED_AND_REPRESENTED". */
export function renderAtsCoverageReport(entries: AtsCoverageEntry[]): string {
  const lines = ["# ATS Coverage Report", ""];
  for (const entry of entries) {
    lines.push(`${entry.requirement} | ${entry.priority} | ${entry.status}`);
  }
  return `${lines.join("\n")}\n`;
}
