/**
 * Detects an explicit hands-on/production-experience ask in a requirement's evidence text —
 * distinct from a bare skill mention. When present, inventory-only evidence for that specific unit
 * is credited lower (see scoring.ts): the Master Skills Rule already established in
 * tailor-resume/SKILL.md is explicit that "knowledge alone does NOT automatically mean production
 * experience," and a JD that explicitly asks for hands-on/production experience is asking for
 * exactly the thing inventory-only knowledge does not prove.
 */
export const HANDS_ON_CUES =
  /\b(hands[\s-]on|production experience|proven experience|hands[\s-]on production|must have built|direct experience (building|operating|running))\b/i;

export function isExperienceDepthRequired(evidenceSnippets: string[]): boolean {
  return HANDS_ON_CUES.test(evidenceSnippets.join(" "));
}
