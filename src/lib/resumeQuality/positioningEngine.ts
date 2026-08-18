import type { ResumeContent } from "../../../tools/tailoring-engine/types";
import type { ComplianceStatus } from "./types";
import type { JdPriorityMatrix } from "./jdPriorityMatrix";
import { extractCanonicalSkillsFromText, resolveSkillForReview } from "./reviewers/skillAliases";

/**
 * Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 2: the Positioning Engine. Exists specifically
 * to prevent the observed real failure: a Senior Data Engineer JD produced a resume headlined
 * "Data Engineer | Cloud Infrastructure, Containerization & Observability" — a demoted role title
 * paired with a qualifier phrase built entirely out of secondary (Terraform/Docker/AKS/Prometheus/
 * Grafana) technologies, none of which were the JD's actual P0/P1 identity.
 *
 * Two deterministic checks, both against the JD Priority Matrix (jdPriorityMatrix.ts) — never against
 * raw JD keyword frequency:
 *   1. ROLE IDENTITY: the tagline must share the target role's SPECIALISATION, not merely its
 *      profession noun, and must not contradict its seniority. See evaluateRoleIdentity.
 *   2. SECONDARY-TECH HIJACK: the tagline/summary opening must not be built entirely from P3/P4
 *      (preferred/optional) technologies while P1 (critical) requirements the candidate actually has
 *      evidence for are absent from it. This is what would have caught the real observed failure.
 */

export interface PositioningEvaluation {
  status: ComplianceStatus;
  issues: string[];
}

const TITLE_STOPWORDS = new Set(["the", "a", "of", "and", "for", "in", "on", "with"]);

/**
 * Profession nouns almost every technical title contains. They say WHAT KIND of professional someone
 * is, never WHICH role — "Sales Engineer", "Network Engineer" and "Data Engineer" all share
 * "engineer" and are three different jobs. Sharing only one of these is not shared role identity.
 */
const GENERIC_PROFESSION_NOUNS = new Set([
  "engineer", "engineering", "developer", "programmer", "analyst", "scientist", "architect",
  "administrator", "specialist", "consultant", "manager", "director", "designer", "technician",
]);

/**
 * Headline words that unambiguously claim an EARLY-CAREER level. Deliberately not a full seniority
 * ladder: this engine only detects a headline that contradicts a mid-or-above target, never a
 * Senior-vs-Staff or IC-vs-management gap. src/lib/match/seniority.ts already documents why those
 * are not linearly comparable across employers, and treating them as ordered here would manufacture
 * positioning failures on ordinary, perfectly well-targeted applications.
 */
const EARLY_CAREER_WORDS = new Set(["intern", "internship", "trainee", "apprentice", "junior", "jr", "entry"]);

/** Target-role words that place the role at mid level or above — the only case an early-career
 *  headline actually contradicts. A target with no stated level is left alone. */
const MID_OR_ABOVE_WORDS = new Set(["mid", "senior", "sr", "staff", "lead", "principal", "director", "head", "vp"]);

function significantTitleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[\s/,-]+/)
      .filter((w) => w.length > 1 && !TITLE_STOPWORDS.has(w))
  );
}

const hasAny = (words: Set<string>, vocabulary: Set<string>): boolean => [...words].some((w) => vocabulary.has(w));

/**
 * STAGE 25A — WHY THIS IS NO LONGER A BARE WORD-OVERLAP TEST. The previous implementation flagged a
 * headline only when it shared ZERO words with the target role. Because virtually every engineering
 * title ends in the same profession noun, that made the check inert for the entire class of failures
 * it was written to catch. Measured directly against a "Senior Data Engineer" target, all of these
 * passed: "Data Engineer" (the documented drop-"Senior" case the comment claimed was flagged),
 * "Junior Data Engineer" (an outright demotion), "Sales Engineer" and "Network Engineer" (different
 * professions). Only "Mammography Technologist" — sharing literally no word — failed.
 *
 * Two precise rules replace it:
 *   a. SPECIALISATION. The overlap must contain at least one word that is not a generic profession
 *      noun. "Sales Engineer" vs "Senior Data Engineer" overlaps only on "engineer" and is flagged;
 *      "Data Engineer" vs "Senior Data Engineer" also shares "data" and is not.
 *   b. SENIORITY CONTRADICTION, narrowly. Only an EARLY-CAREER headline ("Junior"/"Intern"/"Entry")
 *      against a mid-or-above target is flagged. Two things are deliberately NOT flagged. Omitting
 *      the level entirely: correcting a contradiction only means deleting a word, whereas demanding a
 *      level the headline never claimed would pressure the writer into asserting seniority the
 *      candidate's history may not support — underselling by omission is a recruiter-quality
 *      judgement (recruiterQualityGate.ts's `underselling` dimension), never a job for the engine
 *      that could invite a fabricated title. And Senior-vs-Staff or IC-vs-management gaps: those are
 *      not linearly comparable across employers (see src/lib/match/seniority.ts's own note), so
 *      ordering them here would fail ordinary, well-targeted applications.
 */
function evaluateRoleIdentity(resume: ResumeContent, targetRoleTitle: string): string[] {
  const target = significantTitleWords(targetRoleTitle);
  const tagline = significantTitleWords(resume.tagline);
  const issues: string[] = [];

  const overlap = [...target].filter((w) => tagline.has(w));
  const specialisationOverlap = overlap.filter(
    (w) => !GENERIC_PROFESSION_NOUNS.has(w) && !EARLY_CAREER_WORDS.has(w) && !MID_OR_ABOVE_WORDS.has(w)
  );

  if (overlap.length === 0) {
    issues.push(
      `Resume headline "${resume.tagline}" shares no wording with the target role "${targetRoleTitle}" — role identity is not obvious within the first few seconds of reading.`
    );
  } else if (specialisationOverlap.length === 0) {
    issues.push(
      `Resume headline "${resume.tagline}" shares only the generic profession noun (${overlap.join(", ")}) with the target role "${targetRoleTitle}" — it does not communicate the specific role being applied for.`
    );
  }

  if (hasAny(tagline, EARLY_CAREER_WORDS) && hasAny(target, MID_OR_ABOVE_WORDS)) {
    issues.push(
      `Resume headline "${resume.tagline}" claims an early-career level while the target role "${targetRoleTitle}" is mid-level or above — the headline contradicts the level the application is for.`
    );
  }

  return issues;
}

function skillsInText(text: string): Set<string> {
  return extractCanonicalSkillsFromText(text);
}

function evaluateSecondaryTechHijack(resume: ResumeContent, matrix: JdPriorityMatrix): string[] {
  const p1 = matrix.requirements.filter((r) => r.priority === "P1");
  const p1EvidencedLabels = p1.filter((r) => r.evidenceStrength !== "NONE");
  // Nothing to hijack if the JD carries no evidenced P1 requirements at all — the JD's own dominant
  // stack is unknown/unsupported, so this check has nothing to compare positioning against.
  if (p1EvidencedLabels.length === 0) return [];

  const p1CanonicalSkills = new Set(
    p1EvidencedLabels.flatMap((r) => r.memberSkillNames.map((n) => resolveSkillForReview(n)?.canonical ?? n))
  );
  const p4CanonicalSkills = new Set(
    matrix.requirements
      .filter((r) => r.priority === "P4")
      .flatMap((r) => r.memberSkillNames.map((n) => resolveSkillForReview(n)?.canonical ?? n))
  );

  const issues: string[] = [];
  const headlineText = [resume.tagline, ...resume.summary].join(" ");
  const headlineSkills = skillsInText(headlineText);

  const mentionsP4 = [...headlineSkills].some((s) => p4CanonicalSkills.has(s));
  const mentionsP1 = [...headlineSkills].some((s) => p1CanonicalSkills.has(s));

  if (mentionsP4 && !mentionsP1) {
    const mentionedSecondary = [...headlineSkills].filter((s) => p4CanonicalSkills.has(s));
    issues.push(
      `Headline/summary emphasizes secondary technology (${mentionedSecondary.join(", ")}) while the JD's evidenced core requirement(s) (${[...p1CanonicalSkills].join(", ")}) are absent from it — positioning is being hijacked by supporting technology instead of the actual target-role identity.`
    );
  }
  return issues;
}

export function evaluatePositioning(resume: ResumeContent, matrix: JdPriorityMatrix): PositioningEvaluation {
  if (!matrix.targetRoleTitle) {
    return { status: "REVIEW", issues: ["No target role title was supplied — positioning could not be verified against the target role."] };
  }

  const issues = [...evaluateRoleIdentity(resume, matrix.targetRoleTitle), ...evaluateSecondaryTechHijack(resume, matrix)];
  return { status: issues.length > 0 ? "FAIL" : "PASS", issues };
}

/** A deterministic, template-based positioning RECOMMENDATION — not prose generation, just the raw
 *  material (role title + top evidenced P1 requirement labels) the writer prompt hands to the LLM so
 *  the FIRST draft is oriented correctly, rather than relying entirely on post-hoc rejection. Never
 *  invents an evidence-free skill: only P1 requirements with evidenceStrength !== "NONE" are surfaced. */
export function recommendedPositioningSummary(matrix: JdPriorityMatrix): string {
  const evidencedP1 = matrix.requirements.filter((r) => r.priority === "P1" && r.evidenceStrength !== "NONE");
  const role = matrix.targetRoleTitle ?? "the target role";
  if (evidencedP1.length === 0) {
    return `Position around "${role}" — no evidenced P1 (core/critical) JD requirements were identified, so lead with the candidate's own strongest genuinely-evidenced experience instead of any JD technology.`;
  }
  const labels = evidencedP1.map((r) => r.requirement).join(", ");
  return `Position around "${role}" with primary emphasis on: ${labels}. Do not let P3 (preferred) or P4 (secondary/supporting) technologies dominate the headline or summary opening — they may appear later as supporting capabilities only.`;
}
