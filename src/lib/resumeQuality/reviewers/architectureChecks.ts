import type { ExperienceEntry } from "../../../../tools/tailoring-engine/types";
import { findTechnologyContradictions } from "./technologyGroups";

export interface ArchitectureCheckResult {
  architectureConsistencyScore: number;
  incorrectTechnologyUsage: string[];
  blockingIssues: string[];
}

/**
 * Deterministic-pattern-only architecture consistency — flags exactly the competing-tool
 * combinations the Resume Tailoring System Instructions already name explicitly (see
 * technologyGroups.ts), evaluated per bullet with a migration-language exemption. No broader
 * architectural inference is attempted, per the Stage 8 spec.
 */
export function evaluateArchitectureConsistency(experience: ExperienceEntry[]): ArchitectureCheckResult {
  const incorrectTechnologyUsage: string[] = [];
  const blockingIssues: string[] = [];

  for (const role of experience) {
    for (const bullet of role.bullets) {
      const contradictions = findTechnologyContradictions(bullet);
      for (const c of contradictions) {
        const message = `${role.company}: "${c.foundMembers.join(" + ")}" (${c.group.label}) in one bullet with no migration/integration framing: "${bullet.trim()}"`;
        incorrectTechnologyUsage.push(message);
        blockingIssues.push(message);
      }
    }
  }

  const score = Math.min(100, Math.max(0, 100 - incorrectTechnologyUsage.length * 50));
  return { architectureConsistencyScore: score, incorrectTechnologyUsage, blockingIssues };
}
