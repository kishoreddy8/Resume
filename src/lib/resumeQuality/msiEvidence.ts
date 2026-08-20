import type { CandidateProfile, CandidateSkillEntry } from "@/lib/match/types";
import { resolveSkillForReview } from "./reviewers/skillAliases";

/**
 * How a technology is evidenced for a given employer.
 *
 * WHY THIS EXISTS. The system previously collapsed two very different facts into one prohibition:
 * "this technology is not written under this employer in the Master Resume" and "the candidate did
 * not work with this technology there". A resume is deliberately compressed — it is a presentation
 * of a career, not an exhaustive log of it — so its silence about a technology under one client is
 * not evidence of absence. Treating it as such rejected true statements.
 *
 * The Master Skills Inventory is a candidate-authored declaration of technologies they have
 * genuinely worked with. It is evidence, not a keyword list, and it is not scoped to whichever
 * client the resume happened to mention.
 *
 * The one thing that IS a statement of limits is an explicit one: an MSI entry that says a
 * technology belongs to a particular client only. That wins, always.
 */
export type MsiEvidenceState =
  /** Written under this employer in the Master Resume — the strongest, most specific evidence. */
  | "EXPLICIT_RESUME_EVIDENCE"
  /** Declared in the Master Skills Inventory with no client restriction — usable here. */
  | "MSI_EVIDENCE"
  /** Declared in the MSI but explicitly limited to other clients — NOT usable here. */
  | "CLIENT_SCOPED_ELSEWHERE"
  /**
   * Declared in the MSI, but this ROLE is not in the same technical domain, so the inventory does
   * not reach it. See roleAcceptsInventoryEvidence.
   */
  | "ROLE_OUT_OF_SCOPE"
  /** Not in the Master Resume and not in the MSI. Nothing supports it anywhere. */
  | "UNSUPPORTED";

function norm(v: string): string {
  return v.trim().toLowerCase();
}

/**
 * Whether the Master Skills Inventory reaches a given role at all.
 *
 * WHY THIS LIMIT EXISTS. The inventory is global, so without a boundary every declared technology
 * became available at every listed employer — including ones in an entirely different field. On
 * real data a "Graduate Engineer Trainee — Electrical Machines Manufacturing & Testing" came back
 * able to support seven cloud data-engineering requirements. The MSI contract permits applying
 * declared skills across clients when technically plausible, and that role is precisely where it is
 * not: an electrical manufacturing traineeship did not run Azure Data Factory.
 *
 * THE TEST. A role is in scope when at least one technology ITS OWN bullets record resolves to a
 * known technology in this app's skill taxonomy. The inventory describes technologies; a role whose
 * recorded work contains no recognisable technology at all is not a technology role, and a
 * technology inventory does not extend to it.
 *
 * Measured on the profile that exposed the problem: the three data/ML roles resolve 15/20, 14/19
 * and 12/12 of their recorded items; the electrical traineeship resolves 0 of 4 — "Heavy electrical
 * machines", "Routine & type testing", "Quality inspection", "Test data sheets".
 *
 * TWO EARLIER ATTEMPTS, AND WHY THEY WERE WRONG.
 *   - "Is the role's technology a declared skill?" is useless: the inventory lists the electrical
 *     skills too, so every role passed trivially.
 *   - "Does the role share a technology with another role?" is too strict. Two genuinely technical
 *     roles on different stacks — Snowflake at one client, SQL at another — share nothing, and the
 *     rule silently blocked exactly the cross-client use Override 2 exists to allow.
 *
 * IT FAILS CLOSED. A role recording no technologies is out of scope: absence of evidence that it is
 * a technology role is not evidence that it is. Such a role keeps everything already written under
 * it and simply gains nothing.
 */
export function roleAcceptsInventoryEvidence(profile: CandidateProfile, employer: string): boolean {
  const emp = norm(employer);
  const role = profile.experience.find((e) => norm(e.employer) === emp);
  if (!role) return false;
  return role.technologies.some((t) => Boolean(resolveSkillForReview(t)));
}

/** The employers a skill is explicitly limited to, or null when it carries no restriction. */
export function explicitRestriction(skill: CandidateSkillEntry): string[] | null {
  const list = (skill.restrictedToEmployers ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
  return list.length > 0 ? list : null;
}

/**
 * Classify one technology against one employer.
 *
 * `employer` may be null to ask the global question ("is this supported at all?"), which is what a
 * skills-section claim needs — those are capabilities, not work performed anywhere in particular.
 */
export function classifyForEmployer(
  profile: CandidateProfile,
  technology: string,
  employer: string | null
): MsiEvidenceState {
  const tech = norm(technology);
  if (tech.length === 0) return "UNSUPPORTED";

  // 1. Explicit resume evidence: this employer's own recorded technologies, or an attribution to it.
  if (employer !== null) {
    const emp = norm(employer);
    const role = profile.experience.find((e) => norm(e.employer) === emp);
    if (role?.technologies.some((t) => norm(t) === tech)) return "EXPLICIT_RESUME_EVIDENCE";
    const attributed = profile.skills.some(
      (s) => norm(s.rawSkillName) === tech && (s.attributedTo ?? []).some((a) => norm(a.employer) === emp)
    );
    if (attributed) return "EXPLICIT_RESUME_EVIDENCE";
  }

  /* 2. The inventory only reaches roles that share technical ground with the rest of the career.
   *    Checked BEFORE anything is granted, not after: an earlier ordering let a technology recorded
   *    in some other role — but not declared as a skill — slip past the boundary and be offered at
   *    an out-of-domain role anyway. */
  if (employer !== null && !roleAcceptsInventoryEvidence(profile, employer)) {
    return "ROLE_OUT_OF_SCOPE";
  }

  // 3. Anything the MSI declares. Both sources count — "employer" and "inventory_only" alike are
  //    technologies the candidate states they have genuinely worked with.
  const declared = profile.skills.filter((s) => norm(s.rawSkillName) === tech);
  if (declared.length === 0) {
    // A technology recorded only under some other employer's role is still real evidence that the
    // candidate has worked with it; it simply is not attributed here.
    const somewhere = profile.experience.some((e) => e.technologies.some((t) => norm(t) === tech));
    return somewhere ? "MSI_EVIDENCE" : "UNSUPPORTED";
  }

  // 4. An explicit restriction is the only thing that limits a declared skill.
  if (employer !== null) {
    const restrictions = declared.map(explicitRestriction).filter((r): r is string[] => r !== null);
    // Restricted only if EVERY declaration that carries a restriction excludes this employer, and at
    // least one does. An unrestricted declaration of the same skill releases it.
    if (restrictions.length === declared.length && restrictions.length > 0) {
      const allowed = new Set(restrictions.flat().map(norm));
      if (!allowed.has(norm(employer))) return "CLIENT_SCOPED_ELSEWHERE";
    }
  }

  return "MSI_EVIDENCE";
}

/** May this technology appear in this employer's bullets or Environment line? */
export function mayUseAtEmployer(profile: CandidateProfile, technology: string, employer: string): boolean {
  const state = classifyForEmployer(profile, technology, employer);
  return state === "EXPLICIT_RESUME_EVIDENCE" || state === "MSI_EVIDENCE";
}

/**
 * Every technology the candidate can evidence at all, split by what it means for one employer.
 *
 * `supported` keeps its original meaning — written under this employer — because the writer prompt
 * and the presentation rules both distinguish "restate what is already here" from "may bring in".
 */
export function evidenceForEmployer(
  profile: CandidateProfile,
  employer: string
): { supported: string[]; availableViaMsi: string[]; prohibitedHere: string[]; inventoryReachesRole: boolean } {
  const seen = new Map<string, string>();
  for (const e of profile.experience) for (const t of e.technologies) if (t.trim()) seen.set(norm(t), t.trim());
  for (const s of profile.skills) if (s.rawSkillName.trim()) seen.set(norm(s.rawSkillName), s.rawSkillName.trim());

  const supported: string[] = [];
  const availableViaMsi: string[] = [];
  const prohibitedHere: string[] = [];

  for (const display of seen.values()) {
    switch (classifyForEmployer(profile, display, employer)) {
      case "EXPLICIT_RESUME_EVIDENCE":
        supported.push(display);
        break;
      case "MSI_EVIDENCE":
        availableViaMsi.push(display);
        break;
      case "CLIENT_SCOPED_ELSEWHERE":
        prohibitedHere.push(display);
        break;
      case "ROLE_OUT_OF_SCOPE":
        /* Deliberately listed in neither bucket. It is not prohibited — the candidate really does
         * know it — it simply has no bearing on a role in another field, and offering it as
         * "available here" would invite exactly the claim this boundary exists to prevent. */
        break;
      default:
        break;
    }
  }

  const asc = (a: string, b: string) => a.localeCompare(b);
  return {
    supported: supported.sort(asc),
    availableViaMsi: availableViaMsi.sort(asc),
    prohibitedHere: prohibitedHere.sort(asc),
    inventoryReachesRole: roleAcceptsInventoryEvidence(profile, employer),
  };
}
