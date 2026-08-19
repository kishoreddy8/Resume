import type { CandidateProfile } from "@/lib/match/types";
import { checkPresentationAttribution } from "../presentationStructure";
import { checkSummaryOpening } from "../professionalIdentity";
import type { ExperienceEntry, ResumeContent } from "../../../../tools/tailoring-engine/types";

/**
 * Factual consistency against the Master Resume/Skills Inventory (CandidateProfile — Phase 2's own
 * source-of-truth model, read-only). Stage 8 cannot know whether a METRIC is factually correct (no
 * ground truth exists for that), so metric-related findings are always framed as "review required,"
 * never "definitively false" — see checkMetricRealism below. Employer/title/date/education/
 * certification mismatches ARE checkable against structured Master Resume facts, so those can be
 * flagged with real confidence.
 */

export interface TruthfulnessCheckResult {
  truthfulnessScore: number;
  truthfulnessIssues: string[];
  missingImpactEvidence: string[];
  blockingIssues: string[];
  /** True when masterResumeProfile was absent — nothing could actually be verified, so the caller
   *  must not report a perfect score (see deterministicReviewer.ts's scoring cap). */
  insufficientProfileData: boolean;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function employersMatch(resumeEmployer: string, masterEmployer: string): boolean {
  const a = normalize(resumeEmployer);
  const b = normalize(masterEmployer);
  return a.length > 0 && b.length > 0 && (a === b || a.includes(b) || b.includes(a));
}

function significantWords(title: string): Set<string> {
  const STOPWORDS = new Set(["senior", "sr", "junior", "jr", "i", "ii", "iii", "the", "a", "of", "and"]);
  return new Set(
    normalize(title)
      .split(/[\s/,-]+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  );
}

function titlesShareEvidence(resumeTitle: string, masterTitle: string): boolean {
  const a = significantWords(resumeTitle);
  const b = significantWords(masterTitle);
  for (const word of a) if (b.has(word)) return true;
  return false;
}

function yearOf(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const match = dateStr.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

function checkEmploymentFacts(resumeExperience: ExperienceEntry[], master: CandidateProfile): { issues: string[]; blocking: string[] } {
  const issues: string[] = [];
  const blocking: string[] = [];

  for (const role of resumeExperience) {
    const matchedEmployer = master.experience.find((m) => employersMatch(role.company, m.employer));
    if (!matchedEmployer) {
      blocking.push(`Employer "${role.company}" does not appear anywhere in the Master Resume — possible fabricated employer.`);
      continue;
    }
    if (!titlesShareEvidence(role.title, matchedEmployer.title)) {
      issues.push(`Title "${role.title}" at ${role.company} shares no wording with the Master Resume's title "${matchedEmployer.title}" for this employer.`);
    }
    const resumeYearMatch = role.dates.match(/\b(19|20)\d{2}\b/);
    if (resumeYearMatch) {
      const masterStartYear = yearOf(matchedEmployer.startDate);
      const masterEndYear = yearOf(matchedEmployer.endDate);
      const resumeYear = resumeYearMatch[0];
      if (masterStartYear && masterEndYear && resumeYear !== masterStartYear && resumeYear !== masterEndYear) {
        // Stage 21 Phase 3 — dates are a HARD fact, promoted from a soft issue to a blocking one
        // (DATE_CONTRADICTION): a date mismatch against the Master Resume's own recorded employment
        // dates is exactly the class of fabrication-risk fact this stage requires blocking, not just
        // flagging for review.
        blocking.push(`Dates "${role.dates}" at ${role.company} don't match the Master Resume's recorded ${masterStartYear}–${masterEndYear ?? "present"}.`);
      }
    }
  }
  return { issues, blocking };
}

// Generic institution/degree vocabulary that appears in nearly every education line regardless of
// which actual school/degree is meant — excluded from the overlap check so "State University" and
// "Nowhere University" don't false-match on the shared word "university".
const GENERIC_EDUCATION_WORDS = new Set([
  "university", "college", "institute", "school", "degree", "bachelor", "bachelors", "master",
  "masters", "phd", "doctorate", "associate", "science", "arts", "engineering", "technology",
]);

function checkEducationAndCertifications(resume: ResumeContent, master: CandidateProfile): { issues: string[]; blocking: string[] } {
  const issues: string[] = [];
  const blocking: string[] = [];

  const masterEducationText = master.education.map((e) => `${e.level} ${e.field ?? ""} ${e.institution ?? ""}`.toLowerCase()).join(" | ");
  for (const line of resume.education) {
    const words = [...significantWords(line)].filter((w) => !GENERIC_EDUCATION_WORDS.has(w));
    const hasOverlap = words.some((w) => w.length > 3 && masterEducationText.includes(w));
    if (words.length > 0 && !hasOverlap) {
      issues.push(`Education entry "${line}" has no corresponding evidence in the Master Resume.`);
    }
  }

  const masterCertNames = new Set(master.certifications.map((c) => normalize(c.name)));
  for (const cert of resume.certifications ?? []) {
    const normalized = normalize(cert);
    const found = [...masterCertNames].some((m) => normalized.includes(m) || m.includes(normalized));
    if (!found) {
      blocking.push(`Certification "${cert}" does not appear in the Master Resume/Skills Inventory — possible fabricated certification.`);
    }
  }
  return { issues, blocking };
}

/** Repeated exact percentages/round numbers across DIFFERENT employers — cannot know if false, only
 *  that it looks templated (per the source instructions' own "Metric Realism and Repetition Check"
 *  guardrail). Always framed as review-required, never definitively wrong. Exported (in addition to
 *  being folded into truthfulnessIssues below) so instructionCompliance.ts's metricInferencePolicy
 *  check can consume the SAME finding without a second implementation — see deterministicReviewer.ts. */
export function checkMetricRealism(experience: ExperienceEntry[]): string[] {
  const issues: string[] = [];
  const numberToEmployers = new Map<string, Set<string>>();
  const NUMBER_RE = /\b\d{1,3}%|\b\d{2,}(?:,\d{3})+\b/g;

  for (const role of experience) {
    for (const bullet of role.bullets) {
      const matches = bullet.match(NUMBER_RE) ?? [];
      for (const num of matches) {
        const employers = numberToEmployers.get(num) ?? new Set<string>();
        employers.add(role.company);
        numberToEmployers.set(num, employers);
      }
    }
  }
  for (const [num, employers] of numberToEmployers) {
    if (employers.size > 1) {
      issues.push(`The exact figure "${num}" appears across ${employers.size} different employers (${[...employers].join(", ")}) — review for templated/repeated metrics.`);
    }
  }
  return issues;
}

/** Bullets that claim an outcome ("improved", "reduced", "increased", "optimized", "streamlined")
 *  with zero supporting number anywhere in the bullet — a common weak/unsupported-impact pattern. */
function checkMissingImpactEvidence(experience: ExperienceEntry[]): string[] {
  const OUTCOME_RE = /\b(improved|reduced|increased|optimized|streamlined|accelerated|decreased|enhanced)\b/i;
  const NUMBER_RE = /\d/;
  const flagged: string[] = [];
  for (const role of experience) {
    for (const bullet of role.bullets) {
      if (OUTCOME_RE.test(bullet) && !NUMBER_RE.test(bullet)) {
        flagged.push(bullet.trim());
      }
    }
  }
  return flagged;
}

export function evaluateTruthfulness(resume: ResumeContent, masterResumeProfile: CandidateProfile | undefined): TruthfulnessCheckResult {
  const missingImpactEvidence = checkMissingImpactEvidence(resume.experience);

  if (!masterResumeProfile) {
    return {
      // Deliberately NOT 100 — nothing was actually verified, and claiming perfect confidence about
      // unverified facts is exactly what "never let a score hide a factual error" warns against.
      truthfulnessScore: 85,
      truthfulnessIssues: ["Master Resume profile was not supplied to this review — employer/title/date/education/certification facts could not be verified."],
      missingImpactEvidence,
      blockingIssues: [],
      insufficientProfileData: true,
    };
  }

  const employment = checkEmploymentFacts(resume.experience, masterResumeProfile);
  const eduCerts = checkEducationAndCertifications(resume, masterResumeProfile);
  const metricIssues = checkMetricRealism(resume.experience);
  // Stage 31 — the reference format's Project:/Environment: lines are employer-scoped claims and
  // are verified exactly like any other employer attribution, at the same 15-point weight as an
  // employment-fact issue. They are issues rather than blocking findings for the same reason a
  // mis-attributed bullet is: the resume is fixable, not fabricated wholesale. The quality gate
  // requires truthfulnessScore === 100, so a single one of these still prevents READY.
  const attributionIssues = checkPresentationAttribution(resume, masterResumeProfile).map((i) => i.message);

  // Stage 31 correction — the OWNERSHIP fix.
  //
  // Stage 30 built checkSummaryOpening() and then wired it to nothing: outside its own unit tests
  // it had no caller at all, so a summary reading "Data engineer with nearly five years…" reached a
  // published resume with a 100/100 truthfulness score. The detector had in fact already computed
  // UNVERIFIED_YEARS for that exact sentence — nobody was listening.
  //
  // A years-of-experience figure CareerOps could not verify is a factual assertion the candidate's
  // evidence does not support, so it belongs here rather than among presentation findings: the gate
  // requires truthfulnessScore === 100, which means an unverifiable YOE claim now prevents READY.
  // The generic-opening half of the same detector is a writing-quality matter and is handled in
  // structuralChecks.ts instead, where it costs formatting score but cannot block on its own.
  const summaryOpeningIssues = (resume.summary[0] ? checkSummaryOpening(resume.summary[0], masterResumeProfile.totalYearsExperience ?? null) : [])
    .filter((i) => i.kind === "UNVERIFIED_YEARS")
    .map((i) => i.detail);

  const blockingIssues = [...employment.blocking, ...eduCerts.blocking];
  const truthfulnessIssues = [...employment.issues, ...eduCerts.issues, ...metricIssues, ...attributionIssues, ...summaryOpeningIssues];

  let score = 100;
  score -= blockingIssues.length * 40;
  score -= employment.issues.length * 15;
  score -= eduCerts.issues.length * 15;
  score -= metricIssues.length * 5;
  score -= attributionIssues.length * 15;
  score -= summaryOpeningIssues.length * 15;
  score = Math.min(100, Math.max(0, score));

  return { truthfulnessScore: score, truthfulnessIssues, missingImpactEvidence, blockingIssues, insufficientProfileData: false };
}
