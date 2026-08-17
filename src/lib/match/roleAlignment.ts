import type { SkillCategory } from "@/types";
import { CRITICALITY_WEIGHT } from "./scoring";
import type { CandidateExperienceEntry, RequirementMatch } from "./types";

/**
 * Stage 24B — deterministic ROLE ALIGNMENT: "is this the same kind of job the candidate actually
 * does?", scored from the candidate's OWN employment history, never from a declared preference.
 *
 * WHY THIS EXISTS (Stage 24B Phase 4). Before Stage 24B the overall score had four dimensions —
 * required/preferred coverage, experience, seniority — and none of them carried role identity at
 * all. Measured against the real 19,665-job production corpus for candidate 1, that produced a
 * top-of-list consisting of "Cust Care Rep II", "Mammography Technologist", "Classroom Floater" and
 * "Actuarial Analyst", every one of them at overallScore 100. Skill overlap alone (a JD asking for
 * SQL, or nothing but a years-of-experience minimum) was enough to beat a genuinely aligned Senior
 * Data Engineer posting. Role identity has to participate in the score for the score to mean
 * anything.
 *
 * EVIDENCE SOURCE. The candidate's role identity is `CandidateProfile.experience[].title` — the
 * titles the Master Resume actually states. candidate_settings.primary_target_role is deliberately
 * NOT used: it is an aspiration, it is not part of getMatchAffectingSettings()/candidateSettingsHash
 * (see src/db/queries/candidateSettings.ts), and scoring off it would let a preference edit silently
 * change scores with no cache invalidation. Target roles keep doing exactly what they already did —
 * ordering the For You feed via src/lib/rank/roleFamily.ts — and nothing more.
 *
 * TWO INDEPENDENT PATHS, best-of. Phase 4 requires that title matching not be naive substring
 * matching and that a genuinely aligned role with an unusual title ("Software Engineer — Data
 * Platform") still compete, while brittle title-only rejection is avoided:
 *   1. TITLE alignment — role-noun + modifier-set comparison (see scoreTitleAlignment).
 *   2. RESPONSIBILITY alignment — earned only when the JD's OWN Required-level skill requirements are
 *      broadly satisfied by EMPLOYER-ATTRIBUTED candidate evidence (see scoreResponsibilityAlignment).
 * The dimension is max(title, responsibility). Responsibility is capped below 1.0 on purpose so a
 * title-aligned role always edges out a title-mismatched one at equal skill evidence.
 *
 * NEVER fabricates candidate evidence: every input is either the JD's own extracted requirements or
 * a title/skill the candidate's profile already states. A JD requirement the candidate cannot
 * evidence lowers responsibility alignment; it is never read back as a candidate skill.
 */

/** Titles are compared on their role NOUN plus their MODIFIER set. Seniority/level words carry no
 *  role identity (that is the seniority dimension's job, not this one) and are stripped first, so
 *  "Senior Data Engineer II" and "Data Engineer" have the same role identity. */
const LEVEL_WORDS = new Set([
  "senior", "sr", "junior", "jr", "staff", "principal", "lead", "entry", "associate", "assoc",
  "mid", "intern", "internship", "trainee", "apprentice", "i", "ii", "iii", "iv", "v",
  "1", "2", "3", "4", "5", "level",
]);

const NOISE_WORDS = new Set([
  "the", "a", "an", "of", "and", "or", "for", "in", "on", "at", "to", "with", "remote", "hybrid",
  "onsite", "usa", "us", "contract", "fulltime", "parttime", "w2", "c2c", "hiring", "opening",
  "position", "job", "role", "opportunity", "new", "team", "department", "division", "group",
]);

/** The token that carries the "what kind of professional is this" signal. Curated and small on
 *  purpose — an unrecognised title falls back to its last significant token, never to a guess. */
const ROLE_NOUNS = new Set([
  "engineer", "engineering", "developer", "programmer", "architect", "analyst", "scientist",
  "administrator", "admin", "consultant", "specialist", "manager", "director", "designer",
  "researcher", "technician", "operator", "accountant", "attorney", "counsel", "nurse",
  "physician", "therapist", "teacher", "instructor", "recruiter", "representative", "rep",
  "assistant", "coordinator", "supervisor", "clerk", "cashier", "driver", "mechanic", "planner",
  "buyer", "auditor", "controller", "strategist", "writer", "editor", "producer", "marketer",
]);

/** Role nouns that name the same profession for alignment purposes. Curated and directional-free —
 *  a small, human-approved list, same discipline as transferableSkills.ts. Deliberately does NOT
 *  merge "analyst" with "engineer": an analyst role is a different job, and the responsibility path
 *  below exists precisely so a genuinely engineering-shaped analyst posting can still align. */
const ROLE_NOUN_SYNONYMS: Record<string, string> = {
  engineering: "engineer",
  engineer: "engineer",
  developer: "engineer",
  programmer: "engineer",
  admin: "administrator",
  administrator: "administrator",
  rep: "representative",
  representative: "representative",
};

function canonicalRoleNoun(token: string): string {
  return ROLE_NOUN_SYNONYMS[token] ?? token;
}

export interface RoleIdentity {
  /** Canonicalised role noun, or null when the title yielded no significant token at all. */
  roleNoun: string | null;
  /** Every significant, non-level token that is not the role noun — the "what flavour of this role". */
  modifiers: Set<string>;
}

function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !LEVEL_WORDS.has(t) && !NOISE_WORDS.has(t));
}

/** Pure, exported for testing and for the UI's "why" text. */
export function parseRoleIdentity(title: string): RoleIdentity {
  const tokens = tokenize(title);
  if (tokens.length === 0) return { roleNoun: null, modifiers: new Set() };

  // Prefer the LAST recognised role noun ("Software Engineer — Data Platform" -> "engineer", not
  // "platform"); fall back to the last token so an unrecognised profession still gets a stable
  // identity rather than being silently treated as unmatchable.
  let nounIndex = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (ROLE_NOUNS.has(tokens[i])) {
      nounIndex = i;
      break;
    }
  }
  if (nounIndex === -1) nounIndex = tokens.length - 1;

  const roleNoun = canonicalRoleNoun(tokens[nounIndex]);
  const modifiers = new Set(tokens.filter((_, i) => i !== nounIndex).map((t) => canonicalRoleNoun(t)));
  return { roleNoun, modifiers };
}

/**
 * TITLE alignment, 0..1. Requires the SAME role noun first — a Data Engineer and a Mammography
 * Technologist are not the same job however many words they share. Given that:
 *   1.0  the candidate's modifier set is fully contained in the JD's ("Data Engineer" candidate vs
 *        "Snowflake Data Engineer" / "Azure Data Engineer" / "Data Platform Engineer" JD), i.e. the
 *        JD is the candidate's role, possibly specialised further.
 *   0.75 the modifier sets overlap but neither contains the other ("Software Engineer — Data
 *        Platform": shares "data", adds "software"/"platform").
 *   0.35 same profession, no shared flavour at all ("Software Engineer" vs "Data Engineer") — real
 *        but weak alignment, never zero, so title alone can't hard-reject.
 *   0    different profession.
 * A JD with no parseable title token at all scores 0 — those postings are ingestion artefacts and
 * are already flagged by insufficientJdSignal.
 */
export function scoreTitleAlignment(jobTitle: string, candidateTitles: string[]): number {
  const job = parseRoleIdentity(jobTitle);
  if (job.roleNoun === null) return 0;

  let best = 0;
  for (const candidateTitle of candidateTitles) {
    const candidate = parseRoleIdentity(candidateTitle);
    if (candidate.roleNoun === null || candidate.roleNoun !== job.roleNoun) continue;

    let score: number;
    if (candidate.modifiers.size > 0 && [...candidate.modifiers].every((m) => job.modifiers.has(m))) {
      score = 1;
    } else if (candidate.modifiers.size === 0 && job.modifiers.size === 0) {
      // Both are the bare profession ("Engineer" vs "Engineer") — same role, nothing specialising
      // either side. Containment is vacuously true; treat it as a full match, not an empty one.
      score = 1;
    } else if ([...candidate.modifiers].some((m) => job.modifiers.has(m))) {
      score = 0.75;
    } else {
      score = 0.35;
    }
    if (score > best) best = score;
  }
  return best;
}

/** Minimum number of DISTINCT Required-level skill units the candidate must satisfy with
 *  employer-attributed evidence before responsibility alignment can be earned at all. Breadth is the
 *  point: one matched skill is not evidence that the job is the candidate's job. */
export const RESPONSIBILITY_MIN_EMPLOYER_MATCHED_UNITS = 3;

/**
 * SKILL_TAXONOMY categories that carry no role identity because essentially every technical or
 * analytical profession asks for them. Found empirically on the real corpus: with breadth alone as
 * the rule, "Sr. Financial Analyst, GPO Finance" (Power BI + Oracle + SQL), "Pricing Analyst"
 * (Power BI + Python + SQL), "Actuarial Business Analyst III" (SQL Server + Python + SQL) and
 * "Sr Applications Administrator" (Oracle + SQL Server + Shell + Python + SQL) all earned
 * responsibility alignment — and the Financial Analyst role reached READY_FOR_TAILORING. Generic
 * data tooling is not evidence that a posting is the candidate's job.
 *
 * The complement (Cloud Platforms, Data Engineering, Big Data, Warehousing, Orchestration, AI / ML,
 * Infrastructure, Governance, Monitoring) is where a specialisation actually shows. This list is a
 * property of the CATEGORY VOCABULARY, not of any one candidate: it says "SQL is common", never
 * "this candidate is a Data Engineer".
 */
export const UBIQUITOUS_CATEGORIES: SkillCategory[] = [
  "Programming Languages",
  "Databases",
  "BI / Reporting",
  "APIs",
  "DevOps",
  "Testing",
  "Security",
  "Other",
];
export const RESPONSIBILITY_STRONG_WEIGHT_SHARE = 0.6;
export const RESPONSIBILITY_MODERATE_WEIGHT_SHARE = 0.4;
/** Capped below 1.0 deliberately — see this module's header. */
export const RESPONSIBILITY_STRONG_SCORE = 0.75;
export const RESPONSIBILITY_MODERATE_SCORE = 0.5;

/**
 * RESPONSIBILITY alignment, 0..1 — the escape hatch that stops title-only rejection from burying a
 * genuinely aligned role with an unusual title. Reads ONLY the JD's own Required-level skill/
 * skill_group requirement units and whether the candidate satisfied them with EMPLOYER-attributed
 * evidence (inventory-only knowledge and transferable credit deliberately do not count here — a
 * broad Master Skills Inventory must not be able to manufacture role identity, the same principle
 * scoring.ts's employerEvidencedShare gate already enforces).
 */
export function scoreResponsibilityAlignment(requiredMatches: RequirementMatch[]): number {
  const skillUnits = requiredMatches.filter(
    (m) => m.requirement.kind === "skill" || m.requirement.kind === "skill_group"
  );
  const totalWeight = skillUnits.reduce((sum, m) => sum + CRITICALITY_WEIGHT[m.requirement.criticality], 0);
  if (totalWeight === 0) return 0;

  const employerMatched = skillUnits.filter((m) => m.matchType === "MATCHED" && m.evidence?.source === "employer");
  if (employerMatched.length < RESPONSIBILITY_MIN_EMPLOYER_MATCHED_UNITS) return 0;

  // Breadth is necessary but not sufficient — at least one of those employer-evidenced requirements
  // must sit in a category that actually distinguishes one profession from another (see
  // UBIQUITOUS_CATEGORIES). SQL + Python + Power BI is not a role.
  const hasSpecialisedEvidence = employerMatched.some((m) =>
    m.requirement.categories.some((c) => !UBIQUITOUS_CATEGORIES.includes(c))
  );
  if (!hasSpecialisedEvidence) return 0;

  const employerWeight = employerMatched.reduce((sum, m) => sum + CRITICALITY_WEIGHT[m.requirement.criticality], 0);
  const share = employerWeight / totalWeight;
  if (share >= RESPONSIBILITY_STRONG_WEIGHT_SHARE) return RESPONSIBILITY_STRONG_SCORE;
  if (share >= RESPONSIBILITY_MODERATE_WEIGHT_SHARE) return RESPONSIBILITY_MODERATE_SCORE;
  return 0;
}

export interface RoleAlignmentResult {
  /** 0..1 — the value the roleAlignment dimension is built from. Never null: every job has a title,
   *  so this dimension is always applicable, which is what anchors computeOverallScore against the
   *  vacuous-single-dimension inflation Stage 24B found (see scoring.ts). */
  score: number;
  titleScore: number;
  responsibilityScore: number;
  /** Short, human-readable, shown verbatim in the UI — never a fabricated claim. */
  note: string;
}

export function computeRoleAlignment(
  jobTitle: string,
  experience: CandidateExperienceEntry[],
  requiredMatches: RequirementMatch[]
): RoleAlignmentResult {
  const candidateTitles = experience.map((e) => e.title);
  const titleScore = scoreTitleAlignment(jobTitle, candidateTitles);
  const responsibilityScore = scoreResponsibilityAlignment(requiredMatches);
  const score = Math.max(titleScore, responsibilityScore);

  let note: string;
  if (candidateTitles.length === 0) {
    note = "No candidate job titles available — role alignment could not be evidenced from work history.";
  } else if (titleScore >= 1) {
    note = `Job title is the candidate's own role, possibly specialised (candidate has held: ${candidateTitles.join(", ")}).`;
  } else if (responsibilityScore > titleScore) {
    note = `Title differs from the candidate's own roles, but the posting's required skills are broadly covered by employer-attributed experience (${Math.round(responsibilityScore * 100)}% responsibility alignment).`;
  } else if (titleScore >= 0.75) {
    note = "Same profession with partially overlapping specialisation as the candidate's own roles.";
  } else if (titleScore > 0) {
    note = "Same profession as the candidate's own roles, but a different specialisation.";
  } else {
    note = "Different profession from every role the candidate has held, and required skills are not broadly employer-evidenced.";
  }

  return { score, titleScore, responsibilityScore, note };
}
