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
   * Technologies the candidate declares but which are NOT written under this employer — available
   * to use here under the Master Skills Inventory rule, when JD-relevant and architecturally
   * plausible.
   *
   * This list used to be called "not evidenced here" and was flatly prohibited. That conflated two
   * different facts: a resume is compressed, so its silence about a technology under one client is
   * not a statement that the candidate never used it there. The Master Skills Inventory is a
   * candidate-authored declaration of technologies genuinely worked with, and it is not scoped to
   * whichever client the resume happened to mention.
   */
  availableViaMsi: string[];
  /**
   * The only real prohibition: technologies the MSI EXPLICITLY limits to other clients. An explicit
   * restriction is a statement about limits, unlike a resume's silence, so it is honoured absolutely.
   */
  prohibitedHere: string[];
}

export interface EmployerEvidenceMap {
  employers: EmployerEvidence[];
  /**
   * Skills present in the Master Skills Inventory with no employer attribution at all. These may be
   * listed as capabilities but must never be presented as work performed AT a named employer.
   */
  inventoryOnlyCount: number;
}

import { evidenceForEmployer } from "./msiEvidence";

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

  const employers: EmployerEvidence[] = profile.experience.map((entry) => {
    const key = normalizeKey(entry.employer);
    const bucket = supportedByEmployer.get(key) ?? new Map<string, string>();
    const supported = [...bucket.values()].sort((a, b) => a.localeCompare(b));

    /* Classification is delegated so there is ONE definition of what MSI evidence means, shared with
     * the deterministic presentation check. Two implementations would eventually disagree, and the
     * disagreement would surface as a resume rejected for a claim the prompt had just permitted. */
    const classified = evidenceForEmployer(profile, entry.employer);
    return {
      employer: entry.employer,
      title: entry.title,
      supported,
      availableViaMsi: classified.availableViaMsi,
      prohibitedHere: classified.prohibitedHere,
    };
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

  let out = "## PER-EMPLOYER EVIDENCE — WHAT IS ALREADY WRITTEN, WHAT MAY BE BROUGHT IN, WHAT MAY NOT\n\n";
  out +=
    "The Master Resume is a compressed presentation of this career, not an exhaustive log of it. The absence of a " +
    "technology under a client therefore does NOT mean the candidate never used it there. The Master Skills " +
    "Inventory is the candidate's own declaration of technologies they have genuinely worked with — it is evidence, " +
    "not a keyword list — and it is not confined to whichever client the resume happens to mention.\n\n";

  for (const employer of map.employers) {
    out += `### ${employer.employer} — ${employer.title}\n`;
    out += `- **Already written here (${employer.supported.length}):** ${employer.supported.join(", ") || "(none recorded)"}\n`;
    if (employer.availableViaMsi.length > 0) {
      out +=
        `- **Available here under the MSI rule (${employer.availableViaMsi.length}):** ` +
        `${employer.availableViaMsi.join(", ")}\n`;
    }
    if (employer.prohibitedHere.length > 0) {
      out +=
        `- **EXPLICITLY SCOPED TO OTHER CLIENTS — never attribute these to ${employer.employer} ` +
        `(${employer.prohibitedHere.length}):** ${employer.prohibitedHere.join(", ")}\n`;
    }
    out += "\n";
  }

  out += "**Rules that follow from the above — all are enforced by CareerOps' own review:**\n";
  out +=
    "1. A bullet under an employer may claim anything listed as Already written OR Available under the MSI rule for " +
    "THAT employer, subject to the MASTER SKILLS INVENTORY RULE above: architecturally compatible with that " +
    "project's real stack, not contradicting a more specific Master Resume fact, not stacking competing tools for " +
    "the same responsibility, realistic for that project's objective, and defensible in an interview.\n" +
    "2. A technology listed as EXPLICITLY SCOPED TO OTHER CLIENTS may never be attributed here. An explicit " +
    "restriction is a statement about limits; a resume's silence is not.\n" +
    "3. Nothing outside both the Master Resume and the Master Skills Inventory may be claimed anywhere, at any " +
    "employer, under any circumstances. That remains a fabrication and is rejected as such.\n" +
    "4. Bringing a technology in does not license keyword stuffing. One PRIMARY technology or capability per bullet " +
    "still applies; supporting technologies appear only where the architecture genuinely requires them.\n" +
    "5. The cover letter is held to a STRICTER rule than this map: every technology it attributes to an employer must " +
    "also appear in the bullets you write for that same employer in THIS resume. Available-but-unused is not enough — " +
    "if you did not put it in that employer's bullets, do not attribute it to them in the cover letter.\n" +
    "6. Employers, titles, dates, education, certifications, project identity and chronology are hard facts. The MSI " +
    "rule widens which TECHNOLOGIES may be discussed; it never touches any of those.\n\n";
  return out;
}
