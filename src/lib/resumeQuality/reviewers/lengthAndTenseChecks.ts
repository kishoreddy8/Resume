import type { RequiredCorrection } from "../types";
import type { ExperienceEntry } from "../../../../tools/tailoring-engine/types";

/**
 * RESUME LENGTH AND BULLET CAPS + VERB TENSE CONSISTENCY — two independent canonical guardrails,
 * evaluated together because both are pure structural checks over ResumeContent.experience with no
 * shared logic otherwise. ResumeContent.experience is documented (see its own type comment and
 * every existing caller) as "current/most-relevant role first," so position 0 = current role,
 * position 1 = second-most-recent, positions 2+ = older roles — the exact caps the canonical
 * instructions specify per position, not per any other ordering.
 */

const BULLET_CAPS = [8, 6] as const; // index 0 = current role, index 1 = second most recent
const OLDER_ROLE_MAX_BULLETS = 5; // "4-5 each" — 5 is the permitted ceiling, not a violation on its own

export interface BulletCapCheckResult {
  compliant: boolean;
  corrections: RequiredCorrection[];
}

export function evaluateBulletCaps(experience: ExperienceEntry[]): BulletCapCheckResult {
  const corrections: RequiredCorrection[] = [];

  experience.forEach((role, index) => {
    const cap = index < BULLET_CAPS.length ? BULLET_CAPS[index] : OLDER_ROLE_MAX_BULLETS;
    if (role.bullets.length > cap) {
      const roleLabel = index === 0 ? "current/most recent role" : index === 1 ? "second most recent role" : `role #${index + 1}`;
      corrections.push({
        priority: "MEDIUM",
        description: `${role.company || roleLabel} (${roleLabel}) has ${role.bullets.length} bullets, exceeding the ${cap}-bullet cap for this position.`,
      });
    }
  });

  return { compliant: corrections.length === 0, corrections };
}

/**
 * VERB TENSE CONSISTENCY — "past tense throughout Professional Experience, including the current
 * role." Curated, bounded verb-form list rather than a generic "ends in -s" heuristic (which would
 * false-positive on plenty of legitimate past-tense nouns/words) — covers the common resume/
 * engineering verbs the canonical instructions themselves list as approved past-tense examples, plus
 * their present-tense counterparts. Intentionally conservative: a bullet opener not on this list is
 * simply not flagged (never a false FAIL), matching this reviewer's existing "never guess" discipline.
 */
const PRESENT_TO_PAST: Record<string, string> = {
  designs: "Designed",
  builds: "Built",
  develops: "Developed",
  engineers: "Engineered",
  automates: "Automated",
  optimizes: "Optimized",
  migrates: "Migrated",
  implements: "Implemented",
  configures: "Configured",
  partners: "Partnered",
  leads: "Led",
  manages: "Managed",
  drives: "Drove",
  owns: "Owned",
  oversees: "Oversaw",
  maintains: "Maintained",
  supports: "Supported",
  collaborates: "Collaborated",
  creates: "Created",
  delivers: "Delivered",
  ensures: "Ensured",
  provides: "Provided",
  coordinates: "Coordinated",
  facilitates: "Facilitated",
  architects: "Architected",
  administers: "Administered",
  monitors: "Monitored",
  analyzes: "Analyzed",
  plans: "Planned",
  executes: "Executed",
  writes: "Wrote",
  reduces: "Reduced",
  improves: "Improved",
  increases: "Increased",
  streamlines: "Streamlined",
};

function openingWord(text: string): string {
  return (
    text
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^\w]/g, "") ?? ""
  );
}

export interface VerbTenseCheckResult {
  compliant: boolean;
  corrections: RequiredCorrection[];
}

export function evaluateVerbTense(experience: ExperienceEntry[]): VerbTenseCheckResult {
  const corrections: RequiredCorrection[] = [];

  experience.forEach((role) => {
    role.bullets.forEach((bullet) => {
      const trimmed = bullet.trim();
      if (trimmed.length === 0) return;
      const verb = openingWord(trimmed);
      const pastForm = PRESENT_TO_PAST[verb];
      if (pastForm) {
        corrections.push({
          priority: "MEDIUM",
          description: `${role.company || "This role"}: bullet opens with present-tense "${verb}" — use past tense ("${pastForm}") even for the current role: "${trimmed}"`,
        });
      }
    });
  });

  return { compliant: corrections.length === 0, corrections };
}
