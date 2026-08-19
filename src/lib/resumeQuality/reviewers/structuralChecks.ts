import { evaluatePresentationStructure, PRESENTATION_STRUCTURE_DEDUCTION_CAP } from "../presentationStructure";
import {
  checkSummaryOpening,
  deriveProfessionalIdentity,
  describeNarrationIssue,
  findThirdPersonNarration,
  headlinePreservesIdentity,
} from "../professionalIdentity";
import type { CandidateProfile } from "@/lib/match/types";
import type { RequiredCorrection } from "../types";
import type { ResumeContent } from "../../../../tools/tailoring-engine/types";

export interface StructuralCheckResult {
  formattingScore: number;
  corrections: RequiredCorrection[];
  /** A completely missing/empty core section (summary, skills, or experience) is severe enough to
   *  become a blocking issue, not just a formatting deduction — a resume genuinely missing its
   *  Professional Experience section is not "low quality," it is not a usable resume. */
  blockingIssues: string[];
}

/** Pure structural checks against the ResumeContent model itself — no OCR/PDF/visual layout
 *  inspection, matching "use the structured resume content model" from the Stage 8 spec. */
export function evaluateStructuralChecks(
  resume: ResumeContent,
  /** Stage 31 — optional so every existing caller keeps working; supplied by the deterministic
   *  reviewer so the headline can be checked against the identity the candidate's roles establish. */
  masterResumeProfile?: CandidateProfile
): StructuralCheckResult {
  const corrections: RequiredCorrection[] = [];
  const blockingIssues: string[] = [];
  let deductions = 0;

  if (resume.summary.length === 0 || resume.summary.every((s) => s.trim().length === 0)) {
    blockingIssues.push("Professional Summary section is empty.");
    deductions += 30;
  }
  if (resume.skillGroups.length === 0) {
    blockingIssues.push("Technical Skills section is empty.");
    deductions += 30;
  }
  if (resume.experience.length === 0) {
    blockingIssues.push("Professional Experience section is empty.");
    deductions += 40;
  }
  if (resume.education.length === 0) {
    corrections.push({ priority: "MEDIUM", description: "Education section is empty." });
    deductions += 10;
  }

  // Duplicate skill-group headings.
  const seenLabels = new Set<string>();
  for (const group of resume.skillGroups) {
    const normalized = group.label.trim().toLowerCase();
    if (seenLabels.has(normalized)) {
      corrections.push({ priority: "LOW", description: `Duplicate Technical Skills heading: "${group.label}".` });
      deductions += 5;
    }
    seenLabels.add(normalized);
  }

  // Malformed/empty experience entries.
  resume.experience.forEach((role, i) => {
    if (role.bullets.length === 0) {
      corrections.push({ priority: "HIGH", description: `${role.company || `Role #${i + 1}`}: no bullets under this role.` });
      deductions += 15;
    }
    if (!role.company?.trim() || !role.title?.trim()) {
      corrections.push({ priority: "HIGH", description: `Role #${i + 1} is missing a company or title.` });
      deductions += 15;
    }
    if (!role.dates?.trim()) {
      corrections.push({ priority: "MEDIUM", description: `${role.company || `Role #${i + 1}`}: missing dates.` });
      deductions += 10;
    }
  });

  // Stage 31 correction — the summary/headline detectors Stage 30 built and never connected.
  //
  // The generic-opening finding lives here rather than in truthfulness because it is a writing
  // failure, not a false statement: it costs real formatting score and reaches the writer as a
  // correction, but on its own it cannot fail a resume whose facts are sound. (The years half of
  // the same detector IS a factual claim and is handled in truthfulnessChecks.ts.)
  const firstSummaryParagraph = resume.summary.find((s) => s.trim().length > 0);
  if (firstSummaryParagraph) {
    const verifiedYears = masterResumeProfile?.totalYearsExperience ?? null;
    for (const issue of checkSummaryOpening(firstSummaryParagraph, verifiedYears)) {
      if (issue.kind !== "GENERIC_OPENING") continue;
      corrections.push({ priority: "HIGH", description: issue.detail });
      deductions += 15;
    }
  }

  // Stage 31.1 — third-person narration of the candidate. A writing/presentation rule, so it is
  // scored here and never in truthfulness: "Owns ETL delivery end to end" is badly voiced, not
  // untrue, and must not be able to fail a resume whose facts are sound. The deduction is capped
  // for the same reason a missing annotation line is — the correction is what changes the output.
  let narrationDeductions = 0;
  for (const issue of findThirdPersonNarration(resume.summary)) {
    corrections.push({ priority: "MEDIUM", description: describeNarrationIssue(issue) });
    narrationDeductions = Math.min(10, narrationDeductions + 5);
  }
  deductions += narrationDeductions;

  if (masterResumeProfile) {
    const identity = deriveProfessionalIdentity(masterResumeProfile);
    if (identity && resume.tagline.trim().length > 0 && !headlinePreservesIdentity(resume.tagline, identity.identity)) {
      corrections.push({
        priority: "HIGH",
        description:
          `The headline "${resume.tagline}" does not lead with the candidate's own professional identity ` +
          `("${identity.identity}", from the roles actually held: ${identity.evidenceTitles.join("; ")}). ` +
          `JD-relevant specialization belongs after the identity, never in place of it.`,
      });
      deductions += 15;
    }
  }

  // Stage 31 — completeness of the reference presentation structure. A truncated bullet is a real
  // formatting defect and is deducted for; a missing Project:/Environment: line is reported to the
  // writer as a correction but deliberately costs nothing, because a role that simply has not had
  // one written yet is incomplete, not wrong, and must not be able to fail an otherwise sound
  // resume on presentation grounds alone.
  // Structure findings are capped as a group; a truncated bullet is a content defect and is not.
  let structureDeductions = 0;
  for (const issue of evaluatePresentationStructure(resume, masterResumeProfile)) {
    corrections.push({ priority: issue.severity, description: issue.message });
    const weight = issue.severity === "HIGH" ? 10 : issue.severity === "MEDIUM" ? 5 : 0;
    if (issue.kind === "TRUNCATED_BULLET") {
      deductions += weight;
    } else {
      structureDeductions = Math.min(PRESENTATION_STRUCTURE_DEDUCTION_CAP, structureDeductions + weight);
    }
  }
  deductions += structureDeductions;

  const formattingScore = Math.min(100, Math.max(0, 100 - deductions));
  return { formattingScore, corrections, blockingIssues };
}
