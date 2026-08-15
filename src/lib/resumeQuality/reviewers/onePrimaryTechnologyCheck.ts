import type { ExperienceEntry } from "../../../../tools/tailoring-engine/types";
import { resolveSkillForReview } from "./skillAliases";
import { COMPETING_TECHNOLOGY_GROUPS, hasMigrationSignal } from "./technologyGroups";

/**
 * ONE PRIMARY TECHNOLOGY PER RESPONSIBILITY — deliberately BROADER than
 * architectureChecks.ts/technologyGroups.ts's own same-group pairwise contradiction check. That
 * check only fires when 2+ members of the SAME hardcoded competing group appear together (e.g. two
 * data warehouses). This check catches the canonical instructions' other explicit "Bad" example —
 * "Built Azure Data Factory, AWS Glue, Informatica IICS, and Airflow pipelines" — a laundry-list
 * bullet naming 3+ DISTINCT major platform technologies (drawn from across any of the groups, not
 * necessarily the same one) with no clear single primary responsibility. A bullet legitimately
 * naming two related technologies (e.g. "Built Azure Data Factory pipelines to orchestrate
 * Databricks notebooks") stays well under this threshold.
 */

const MAJOR_PLATFORM_VOCABULARY: readonly string[] = [...new Set(COMPETING_TECHNOLOGY_GROUPS.flatMap((g) => g.members))];

const LAUNDRY_LIST_THRESHOLD = 3;

export interface LaundryListFinding {
  role: string;
  bullet: string;
  technologiesFound: string[];
}

/** Scans one bullet for 3+ DISTINCT major-platform technologies (see MAJOR_PLATFORM_VOCABULARY),
 *  skipping any bullet with a migration signal — same exemption technologyGroups.ts's own
 *  findTechnologyContradictions applies, for the same reason (a migration bullet legitimately names
 *  several tools by design). */
export function findLaundryListTechnologies(text: string): string[] {
  if (hasMigrationSignal(text)) return [];

  const found = new Set<string>();
  for (const member of MAJOR_PLATFORM_VOCABULARY) {
    const resolved = resolveSkillForReview(member);
    const canonical = resolved?.canonical ?? member;
    const regex = new RegExp(`(?<![\\w-])${canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
    if (regex.test(text)) found.add(canonical);
  }
  return [...found];
}

export function evaluateOnePrimaryTechnologyPerResponsibility(experience: ExperienceEntry[]): LaundryListFinding[] {
  const findings: LaundryListFinding[] = [];
  for (const role of experience) {
    for (const bullet of role.bullets) {
      const technologiesFound = findLaundryListTechnologies(bullet);
      if (technologiesFound.length >= LAUNDRY_LIST_THRESHOLD) {
        findings.push({ role: role.company, bullet: bullet.trim(), technologiesFound });
      }
    }
  }
  return findings;
}
