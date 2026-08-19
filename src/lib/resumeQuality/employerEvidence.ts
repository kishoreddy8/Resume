import type { CandidateProfile } from "@/lib/match/types";

/**
 * Stage 28 — what each employer's own evidence actually supports, and what it does not.
 *
 * THE DEFECT THIS EXISTS FOR. Stage 27's workflow 7 exhausted every content iteration and failed with
 * five EMPLOYER_CONTRADICTION blocking failures: the cover letter attributed Python, Spark, CDC and
 * SCD to Fiserv, and Surrogate Keys to Microgate Technologies. Checked against the candidate's own
 * profile, four of those five were real: Python and Spark are attributed only to Microgate, CDC only
 * to Comerica and Microgate, Surrogate Keys only to Fiserv. Every one of them IS genuinely the
 * candidate's skill — just not at that employer. The writer had the global skills inventory and the
 * master resume, but nothing that said "these are the technologies you may NOT attribute here", so
 * it produced a plausible, well-written, and wrong document three times in a row.
 *
 * The rule this encodes is the one the deterministic reviewer already enforces and the writer was
 * never told: GLOBAL SKILL EVIDENCE IS NOT EMPLOYER-SPECIFIC EXPERIENCE EVIDENCE.
 *
 * Nothing here is inferred or invented — least of all the negative evidence. "Not evidenced at this
 * employer" is derived purely by set difference over what the candidate's own profile already
 * records: `experience[].technologies` (the technologies a role's bullets actually attribute) and
 * `skills[].attributedTo` (explicit per-employer attribution). A technology absent from both is
 * simply absent; this module never claims the candidate lacks a skill, only that THIS EMPLOYER'S
 * evidence does not support attributing it there.
 */

export interface EmployerEvidence {
  employer: string;
  title: string;
  /** Technologies this employer's own evidence supports, sorted for deterministic output. */
  supported: string[];
  /**
   * Technologies evidenced for the candidate at a DIFFERENT employer and not at this one — i.e. the
   * specific, real confusion risks. Deliberately not "every skill the candidate has never used here":
   * the inventory holds hundreds of entries, and listing them all would bury the handful that
   * actually get mis-attributed while making the prompt enormous.
   */
  notEvidencedHere: string[];
}

export interface EmployerEvidenceMap {
  employers: EmployerEvidence[];
  /**
   * Skills present in the Master Skills Inventory with no employer attribution at all. These may be
   * listed as capabilities but must never be presented as work performed AT a named employer.
   */
  inventoryOnlyCount: number;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Builds the per-employer view from the candidate profile alone. Returns an empty map for a profile
 * with no experience entries rather than inventing one.
 */
export function buildEmployerEvidenceMap(profile: CandidateProfile): EmployerEvidenceMap {
  // Start from what each role's own bullets attribute, then fold in explicit per-skill attribution.
  const supportedByEmployer = new Map<string, Map<string, string>>();
  const titleByEmployer = new Map<string, string>();

  for (const entry of profile.experience) {
    const key = normalizeKey(entry.employer);
    titleByEmployer.set(key, entry.title);
    const bucket = supportedByEmployer.get(key) ?? new Map<string, string>();
    for (const tech of entry.technologies) {
      if (tech.trim().length > 0) bucket.set(normalizeKey(tech), tech.trim());
    }
    supportedByEmployer.set(key, bucket);
  }

  for (const skill of profile.skills) {
    for (const attribution of skill.attributedTo ?? []) {
      const key = normalizeKey(attribution.employer);
      // Only employers the profile actually lists as experience get an evidence block — an
      // attribution naming something else is left alone rather than synthesised into a new employer.
      const bucket = supportedByEmployer.get(key);
      if (!bucket) continue;
      if (skill.rawSkillName.trim().length > 0) bucket.set(normalizeKey(skill.rawSkillName), skill.rawSkillName.trim());
    }
  }

  // Every technology evidenced ANYWHERE at a named employer — the universe from which each
  // employer's "not evidenced here" list is the complement.
  const evidencedSomewhere = new Map<string, string>();
  for (const bucket of supportedByEmployer.values()) {
    for (const [key, display] of bucket) evidencedSomewhere.set(key, display);
  }

  const employers: EmployerEvidence[] = profile.experience.map((entry) => {
    const key = normalizeKey(entry.employer);
    const bucket = supportedByEmployer.get(key) ?? new Map<string, string>();
    const supported = [...bucket.values()].sort((a, b) => a.localeCompare(b));
    const notEvidencedHere = [...evidencedSomewhere.entries()]
      .filter(([techKey]) => !bucket.has(techKey))
      .map(([, display]) => display)
      .sort((a, b) => a.localeCompare(b));
    return { employer: entry.employer, title: entry.title, supported, notEvidencedHere };
  });

  return {
    employers,
    inventoryOnlyCount: profile.skills.filter((s) => (s.attributedTo ?? []).length === 0).length,
  };
}

/**
 * Renders the map as the writer-facing contract. Kept as prose the model must follow rather than raw
 * JSON, because the rule ("you may not attribute X here") matters more than the data, and states the
 * cover-letter rule explicitly: the deterministic reviewer validates cover-letter attributions
 * against the RESUME BULLETS THE WRITER JUST WROTE, not against this map, so a technology that is
 * supported here but absent from the finished resume still cannot appear in the cover letter under
 * that employer.
 */
export function renderEmployerEvidenceSection(map: EmployerEvidenceMap): string {
  if (map.employers.length === 0) return "";

  let out = "## EMPLOYER-SCOPED EVIDENCE — WHAT EACH EMPLOYER SUPPORTS, AND WHAT IT DOES NOT\n\n";
  out +=
    "A technology existing somewhere in this candidate's skills inventory does NOT make it attributable to every " +
    "employer. Global skill evidence is not employer-specific experience evidence. For each employer below you may " +
    "only present the technologies under **Supported here**.\n\n";

  for (const employer of map.employers) {
    out += `### ${employer.employer} — ${employer.title}\n`;
    out += `- **Supported here (${employer.supported.length}):** ${employer.supported.join(", ") || "(none recorded)"}\n`;
    if (employer.notEvidencedHere.length > 0) {
      out +=
        `- **NOT evidenced here — never attribute these to ${employer.employer} (${employer.notEvidencedHere.length}):** ` +
        `${employer.notEvidencedHere.join(", ")}\n`;
    }
    out += "\n";
  }

  out += "**Rules that follow from the above — all are enforced by CareerOps' own review:**\n";
  out +=
    "1. A resume bullet under an employer may only claim technologies listed as Supported for THAT employer.\n" +
    `2. ${map.inventoryOnlyCount} further skills exist in the inventory with no employer attribution at all. They may ` +
    "appear in a skills section as capabilities, but must never be described as work performed at a named employer.\n" +
    "3. The cover letter is held to a STRICTER rule than this map: every technology it attributes to an employer must " +
    "also appear in the bullets you write for that same employer in THIS resume. Supported-but-unused is not enough — " +
    "if you did not put it in that employer's bullets, do not attribute it to them in the cover letter.\n" +
    "4. Attributing a real skill to the wrong employer is a fabrication, and is rejected exactly as harshly as " +
    "inventing a technology outright.\n\n";
  return out;
}
