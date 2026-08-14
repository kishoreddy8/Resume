import { resolveSkillForReview } from "./skillAliases";

/**
 * Competing-technology groups, sourced from the "GUARDRAIL — NO TWO COMPETING/EQUIVALENT TOOLS IN
 * THE SAME LINE OR SAME PROJECT RESPONSIBILITY" section of the Resume Tailoring System Instructions
 * — reused verbatim as the authoritative rule set, not reinvented. Two or more canonical names from
 * the SAME group appearing in one bullet, with no migration-language signal present, is flagged as a
 * deterministic architecture contradiction (see architectureChecks.ts).
 */
export interface CompetingGroup {
  /** Canonical skill names (must match SKILL_TAXONOMY/skillAliases canonical output exactly). */
  members: readonly string[];
  /** Human-readable label for the issue text. */
  label: string;
}

export const COMPETING_TECHNOLOGY_GROUPS: readonly CompetingGroup[] = [
  { members: ["Azure Data Factory", "AWS Glue"], label: "Azure Data Factory + AWS Glue" },
  { members: ["Azure Synapse Analytics", "Redshift", "BigQuery", "Snowflake"], label: "competing data warehouses positioned as primary" },
  { members: ["Azure DevOps", "Jenkins", "GitHub Actions", "GitLab CI"], label: "competing CI/CD platforms" },
  { members: ["Databricks", "EMR"], label: "Databricks + EMR" },
];

const MIGRATION_SIGNAL_RE = /\b(migrat\w*|moved to|transition\w*|integrat\w*)\b/i;

/** True when the given text explicitly signals a migration/integration — the one exemption the
 *  source guardrail allows for otherwise-competing tools appearing together. */
export function hasMigrationSignal(text: string): boolean {
  return MIGRATION_SIGNAL_RE.test(text);
}

export interface TechnologyContradiction {
  group: CompetingGroup;
  foundMembers: string[];
}

/** Scans one block of text (typically one bullet) for 2+ members of the same competing group,
 *  skipping any block that has a migration signal. Conservative by construction: only flags a
 *  contradiction when the SAME group's members are found together in the SAME text block, never
 *  across unrelated bullets/roles. */
export function findTechnologyContradictions(text: string): TechnologyContradiction[] {
  if (hasMigrationSignal(text)) return [];

  const canonicalInText = new Set<string>();
  for (const group of COMPETING_TECHNOLOGY_GROUPS) {
    for (const member of group.members) {
      const resolved = resolveSkillForReview(member);
      const canonical = resolved?.canonical ?? member;
      const regex = new RegExp(`(?<![\\w-])${canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
      if (regex.test(text)) canonicalInText.add(canonical);
    }
  }

  const contradictions: TechnologyContradiction[] = [];
  for (const group of COMPETING_TECHNOLOGY_GROUPS) {
    const foundMembers = group.members.filter((m) => canonicalInText.has(m));
    if (foundMembers.length >= 2) contradictions.push({ group, foundMembers });
  }
  return contradictions;
}
