import type { RequirementUnit } from "@/lib/match/types";
import { extractCanonicalSkillsFromText } from "./skillAliases";

const CLOUD_PROVIDERS = ["AWS", "Azure", "GCP"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/** A canonical skill set "implies" a cloud provider either by naming it directly (bare "AWS") or by
 *  naming one of its branded sub-products (e.g. "AWS Glue", "Azure Data Factory") — the
 *  non-overlapping-span matching in extractCanonicalSkillsFromText() credits the MORE specific
 *  canonical name (e.g. "AWS Glue") rather than double-crediting the shorter "AWS" too, so a
 *  provider-level check must look at prefixes, not just exact provider-name membership. */
function impliedCloudProviders(canonicalSkills: ReadonlySet<string>): CloudProvider[] {
  return CLOUD_PROVIDERS.filter((provider) => [...canonicalSkills].some((skill) => skill === provider || skill.startsWith(`${provider} `)));
}

export interface SummaryCheckResult {
  summaryIssues: string[];
  insufficientRequirementData: boolean;
}

function dominantStackFrom(jobRequirements: RequirementUnit[]): Set<string> {
  const critical = jobRequirements.filter(
    (u) => (u.kind === "skill" || u.kind === "skill_group") && (u.criticality === "CRITICAL" || u.criticality === "REQUIRED")
  );
  return new Set(critical.flatMap((u) => u.memberSkillNames).slice(0, 8));
}

/** Deterministic-only: word overlap with the JD's dominant stack, and an explicit cloud-provider
 *  contradiction check. Never a semantic "is this summary compelling" judgment. */
export function evaluateSummaryAlignment(summary: string[], jobRequirements: RequirementUnit[] | undefined): SummaryCheckResult {
  const summaryText = summary.join(" ");
  const summaryIssues: string[] = [];

  if (summaryText.trim().length === 0) {
    summaryIssues.push("Professional Summary is empty.");
    return { summaryIssues, insufficientRequirementData: !jobRequirements || jobRequirements.length === 0 };
  }
  if (summaryText.trim().split(/\s+/).length < 12) {
    summaryIssues.push("Professional Summary is very short/generic — likely missing role-specific detail.");
  }

  if (!jobRequirements || jobRequirements.length === 0) {
    return { summaryIssues, insufficientRequirementData: true };
  }

  const dominantStack = dominantStackFrom(jobRequirements);
  const summarySkills = extractCanonicalSkillsFromText(summaryText);

  if (dominantStack.size > 0) {
    const overlap = [...dominantStack].filter((s) => summarySkills.has(s));
    if (overlap.length === 0) {
      summaryIssues.push(`Summary does not mention any of the JD's dominant required technologies (${[...dominantStack].slice(0, 5).join(", ")}).`);
    }
  }

  // Explicit cloud-provider contradiction: summary names a provider the JD's dominant stack never
  // mentions, and the JD DOES have an unambiguous dominant provider.
  const jdProviders = impliedCloudProviders(dominantStack);
  const summaryProviders = impliedCloudProviders(summarySkills);
  if (jdProviders.length === 1 && summaryProviders.length > 0 && !summaryProviders.includes(jdProviders[0])) {
    summaryIssues.push(`Summary emphasizes ${summaryProviders.join("/")} while the JD's dominant cloud platform is ${jdProviders[0]}.`);
  }

  return { summaryIssues, insufficientRequirementData: false };
}
