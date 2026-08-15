import type { SkillGroup } from "../../../../tools/tailoring-engine/types";
import { extractCanonicalSkillsFromText } from "./skillAliases";
import { hasMigrationSignal } from "./technologyGroups";

/**
 * TECHNOLOGY GROUPING RULE — "keep technologies aligned with their natural ecosystems... do not
 * unnecessarily mix ecosystems" (canonicalInstructions.ts). Deliberately distinct from
 * architectureIntegrity/noContradictingTechnologies (which operate on Professional Experience
 * BULLETS — is one workflow described with competing tools): this check operates on the Technical
 * Skills SECTION organization — is a single skill group internally coherent, or does it casually mix
 * multiple cloud providers with no stated reason. Scoped specifically to the three cloud providers
 * (the sharpest, most defensible "these genuinely don't mix without a reason" signal) rather than a
 * fully general vendor-coherence judgment, which would false-positive constantly (Snowflake + dbt +
 * Airflow in one group is completely normal and not an "ecosystem mixing" problem the way Azure + AWS
 * + GCP all claimed as primary platforms in one group would be).
 */

const CLOUD_PROVIDERS = ["AWS", "Azure", "GCP"] as const;

function impliedProviders(canonicalSkills: ReadonlySet<string>): string[] {
  return CLOUD_PROVIDERS.filter((provider) => [...canonicalSkills].some((skill) => skill === provider || skill.startsWith(`${provider} `)));
}

export interface TechnologyGroupingFinding {
  groupLabel: string;
  providersFound: string[];
}

export function evaluateTechnologyGrouping(skillGroups: SkillGroup[]): TechnologyGroupingFinding[] {
  const findings: TechnologyGroupingFinding[] = [];

  for (const group of skillGroups) {
    if (hasMigrationSignal(group.label)) continue;
    const canonical = extractCanonicalSkillsFromText(group.items.join(" "));
    const providers = impliedProviders(canonical);
    if (providers.length >= 2) {
      findings.push({ groupLabel: group.label, providersFound: providers });
    }
  }

  return findings;
}
