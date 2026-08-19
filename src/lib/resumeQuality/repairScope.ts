import type { InstructionComplianceChecks, StructuredResumeReview } from "./types";

/**
 * Stage 28 — how much of the application package iteration 2 actually has to rewrite.
 *
 * WHY. Before this, the second attempt regenerated both documents from scratch no matter how narrow
 * the problem was. On the real corpus that is both slow and actively risky: workflow 7's third
 * attempt fixed three compliance checks while simultaneously regressing from one employer-attribution
 * failure to five, because a full rewrite re-rolls content that was already correct. The smallest
 * safe repair is faster AND less likely to break something that was passing.
 *
 * THE SCOPE DECISION IS DETERMINISTIC AND MADE BY CAREEROPS, NEVER BY THE MODEL. The writer is told
 * what to repair; it is never asked which findings matter, and never permitted to decide that a
 * safety finding can be skipped. Every finding is attributed to an artifact below, and anything this
 * module cannot confidently attribute widens the scope rather than narrowing it — an unattributed
 * finding must never be silently dropped from the repair instructions.
 *
 * A targeted repair is a narrower WRITE, never a narrower REVIEW: the reconstructed pair always goes
 * through the complete deterministic Stage 21 review before any disposition (see writerWorkerCore).
 */

export type RepairScope = "FULL" | "RESUME_ONLY" | "COVER_LETTER_ONLY";

export interface RepairPlan {
  scope: RepairScope;
  /** Human/writer-facing reason the scope was chosen — always states what drove it. */
  reason: string;
  /** Findings attributed to the resume, verbatim from the review. */
  resumeFindings: string[];
  /** Findings attributed to the cover letter, verbatim from the review. */
  coverLetterFindings: string[];
  /** Findings that could not be attributed to one artifact — these force FULL scope. */
  unattributedFindings: string[];
}

/**
 * Compliance checks whose evidence is inherently about BOTH documents together, or about the resume's
 * own structure. A non-PASS here can never be repaired by touching the cover letter alone.
 */
const RESUME_STRUCTURAL_CHECKS: readonly (keyof InstructionComplianceChecks)[] = [
  "hardCareerFacts",
  "masterSkillsInventoryCompliance",
  "deepRewrite",
  "architectureIntegrity",
  "technologyGrouping",
  "onePrimaryTechnologyPerResponsibility",
  "metricInferencePolicy",
  "keywordOptimization",
  "bulletWriting",
  "everySentenceAtsChecklist",
  "noDuplicateBulletPhrasing",
  "yearsExperienceEducationHonesty",
  "employmentTypeHandling",
  "resumeLengthBulletCaps",
  "verbTenseConsistency",
  "atsFormatting",
];

/** A finding whose text names the cover letter is a cover-letter finding — the deterministic reviewer
 *  prefixes exactly that way ("Cover letter: ...", "Cover letter attributes ..."). */
function mentionsCoverLetter(text: string): boolean {
  return /\bcover letter\b/i.test(text);
}

function mentionsResume(text: string): boolean {
  return /\bresume\b/i.test(text);
}

/**
 * Builds the repair plan from a completed Stage 21 review.
 *
 * Widening rules, in order of precedence — any one of them forces FULL:
 *   1. a finding names neither document (we cannot prove it is confined to one)
 *   2. a finding names BOTH documents (a cross-document contradiction is repaired by changing either
 *      side, and the reviewer validates the pair, so both must be in scope)
 *   3. any resume-structural compliance check is non-PASS
 *   4. findings exist on both artifacts
 */
export function planRepairScope(review: StructuredResumeReview): RepairPlan {
  const resumeFindings: string[] = [];
  const coverLetterFindings: string[] = [];
  const unattributedFindings: string[] = [];

  const attribute = (text: string): void => {
    const cover = mentionsCoverLetter(text);
    const resume = mentionsResume(text);
    if (cover && !resume) coverLetterFindings.push(text);
    else if (resume && !cover) resumeFindings.push(text);
    else if (cover && resume) {
      // Names both — genuinely a pair-level problem. Recorded on both sides so neither set of repair
      // instructions omits it.
      coverLetterFindings.push(text);
      resumeFindings.push(text);
      unattributedFindings.push(text);
    } else unattributedFindings.push(text);
  };

  for (const failure of review.blockingFailures ?? []) {
    attribute(`${failure.type}: ${failure.description}`);
  }
  for (const issue of review.blockingIssues) attribute(issue);
  for (const correction of review.requiredCorrections) {
    // The reviewer's own boilerplate compliance corrections are handled via the checks below, where
    // the check name is a far better scope signal than the sentence text.
    if (/^Canonical instruction compliance — /.test(correction.description)) continue;
    attribute(correction.description);
  }

  const compliance = review.instructionCompliance;
  let structuralCheckFailure: string | null = null;
  if (compliance) {
    for (const check of RESUME_STRUCTURAL_CHECKS) {
      if (compliance.checks[check] !== "PASS") {
        structuralCheckFailure = check;
        const notes = compliance.checkNotes?.[check] ?? [];
        resumeFindings.push(`Compliance check ${check} is ${compliance.checks[check]}.${notes.length > 0 ? ` Reason: ${notes.join(" | ")}` : ""}`);
      }
    }
    // Cover-letter-scoped checks: record their evidence, but let the note text decide the artifact,
    // since these two checks can fire from either document.
    for (const check of ["noContradictingTechnologies", "crossDocumentConsistency"] as const) {
      if (compliance.checks[check] === "PASS") continue;
      const notes = compliance.checkNotes?.[check] ?? [];
      if (notes.length === 0) {
        unattributedFindings.push(`Compliance check ${check} is ${compliance.checks[check]} with no recorded reason.`);
        continue;
      }
      for (const note of notes) attribute(`${check}: ${note}`);
    }
  } else {
    unattributedFindings.push("No canonical instruction compliance was computed for the previous attempt.");
  }

  const hasResume = resumeFindings.length > 0;
  const hasCover = coverLetterFindings.length > 0;

  if (unattributedFindings.length > 0) {
    return {
      scope: "FULL",
      reason:
        `${unattributedFindings.length} finding(s) could not be confined to a single document, so the whole package is repaired. ` +
        "Narrowing on an unattributed finding risks leaving it unfixed.",
      resumeFindings,
      coverLetterFindings,
      unattributedFindings,
    };
  }
  // A resume-structural check failing puts the RESUME in scope (its finding is already recorded in
  // resumeFindings above); it never by itself justifies rewriting an accepted cover letter. The
  // both-artifacts rule below is what widens to FULL when the cover letter is genuinely affected too.
  if (hasResume && hasCover) {
    return {
      scope: "FULL",
      reason: "Both the resume and the cover letter have findings; repairing them together keeps the pair consistent.",
      resumeFindings,
      coverLetterFindings,
      unattributedFindings,
    };
  }
  if (hasCover) {
    return {
      scope: "COVER_LETTER_ONLY",
      reason: `Every remaining finding (${coverLetterFindings.length}) is confined to the cover letter; the reviewed resume is kept exactly as written.`,
      resumeFindings,
      coverLetterFindings,
      unattributedFindings,
    };
  }
  if (hasResume) {
    return {
      scope: "RESUME_ONLY",
      reason:
        `Every remaining finding (${resumeFindings.length}) is confined to the resume` +
        `${structuralCheckFailure !== null ? `, including resume-structural check ${structuralCheckFailure}` : ""}; ` +
        "the reviewed cover letter is kept exactly as written.",
      resumeFindings,
      coverLetterFindings,
      unattributedFindings,
    };
  }
  return {
    scope: "FULL",
    reason: "No finding could be attributed to a specific document, so the full package is regenerated.",
    resumeFindings,
    coverLetterFindings,
    unattributedFindings,
  };
}

/** The writer-facing repair brief. States the scope as an instruction, and what must NOT change. */
export function renderRepairPlanSection(plan: RepairPlan): string {
  let out = "## TARGETED REPAIR — CHANGE ONLY WHAT IS LISTED HERE\n\n";
  out += `**Repair scope: ${plan.scope}.** ${plan.reason}\n\n`;

  if (plan.scope === "COVER_LETTER_ONLY") {
    out +=
      "The resume below was already reviewed and its remaining findings are zero. Reproduce it EXACTLY as given — " +
      "same bullets, same wording, same ordering, same skills section. Do not improve it, reorder it, or re-tailor it. " +
      "Repair only the cover letter.\n\n";
  } else if (plan.scope === "RESUME_ONLY") {
    out +=
      "The cover letter below was already reviewed and its remaining findings are zero. Reproduce it EXACTLY as given. " +
      "Repair only the resume.\n\n";
  } else {
    out += "Both documents are in scope for this repair.\n\n";
  }

  if (plan.resumeFindings.length > 0) {
    out += "### Resume findings to fix\n";
    for (const f of plan.resumeFindings) out += `- ${f}\n`;
    out += "\n";
  }
  if (plan.coverLetterFindings.length > 0) {
    out += "### Cover letter findings to fix\n";
    for (const f of plan.coverLetterFindings) out += `- ${f}\n`;
    out += "\n";
  }
  // Findings CareerOps could not confine to one document. They are the reason the scope is FULL, so
  // they must be stated — telling the writer to rewrite everything without saying why is how a
  // "repair" turns into an unguided regeneration.
  const unattributedOnly = plan.unattributedFindings.filter(
    (f) => !plan.resumeFindings.includes(f) && !plan.coverLetterFindings.includes(f)
  );
  if (unattributedOnly.length > 0) {
    out += "### Findings affecting the package as a whole\n";
    for (const f of unattributedOnly) out += `- ${f}\n`;
    out += "\n";
  }
  out +=
    "You must still return BOTH documents in `writer_output.json` — the unchanged one reproduced verbatim, the " +
    "repaired one corrected. CareerOps re-reviews the complete pair together; a narrower repair never means a " +
    "narrower review.\n\n";
  return out;
}
