import type {
  BlockingFailure,
  CoverLetterContent,
  InstructionComplianceChecks,
  ResumeContent,
  StructuredResumeReview,
} from "./types";
import { isComplianceBlocking } from "./instructionCompliance";

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

export type RepairOperationKind =
  | "REMOVE_TEXT"
  | "REPLACE_SENTENCE"
  | "REPLACE_BULLET"
  | "SHORTEN_PROJECT_DESCRIPTION"
  | "MOVE_SUPPORTED_SKILL"
  | "REMOVE_UNSUPPORTED_SKILL"
  | "REMOVE_UNSUPPORTED_CLAIM"
  | "FIX_EMPLOYER_ATTRIBUTION"
  | "FIX_COVER_LETTER_SENTENCE"
  | "FIX_FORMATTING"
  | "FIX_SUMMARY_SENTENCE"
  | "REPAIR_TARGET_POSITIONING";

export interface RootRepairFinding {
  key: string;
  description: string;
  source: "BLOCKING_FAILURE" | "BLOCKING_ISSUE" | "REQUIRED_CORRECTION" | "COMPLIANCE" | "RECRUITER_QUALITY";
  evidenceSource: string[];
  reason: string;
  candidateInputRequired: boolean;
  /** Recruiter findings carry their existing authority and deterministic repair attribution. These
   *  fields are optional so historical/canonical finding shapes remain unchanged. */
  severity?: "BLOCKING";
  artifact?: "resume" | "cover_letter";
  section?: string;
  proposedCorrectionType?: RepairOperationKind;
  automaticRepairSafe?: boolean;
}

export interface RepairOperation {
  operation: RepairOperationKind;
  artifact: "resume" | "cover_letter";
  section: string;
  employer?: string;
  originalText?: string;
  proposedText?: string;
  rootFinding: string;
  evidenceSource: string[];
  reason: string;
  candidateInputRequired: boolean;
  /** JSON-like path into the baseline. Everything outside these paths is frozen. Sentence paths use
   *  `coverLetter.paragraphs[n].sentences[n]` and are validated sentence-by-sentence. */
  editablePath: string;
}

export interface RepairBaseline {
  resume?: ResumeContent;
  coverLetter?: CoverLetterContent;
}

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
  /** Normalized content problems only. Derived/meta checks such as finalValidation never appear. */
  rootFindings?: RootRepairFinding[];
  /** Smallest deterministic edits CareerOps can identify from the baseline and review. */
  operations?: RepairOperation[];
  /** Complete allowlist. Every baseline path not covered here is frozen. */
  editablePaths?: string[];
}

export interface CandidateRepairQuestion {
  findingKey: string;
  question: string;
  choices: ["Yes", "No", "Not sure"];
}

const META_COMPLIANCE_CHECKS: readonly (keyof InstructionComplianceChecks)[] = ["finalValidation"];
const META_RECRUITER_DIMENSIONS = new Set(["firstTenSecondFit"]);
const TECHNOLOGY_ROOT_CHECKS = new Set<keyof InstructionComplianceChecks>([
  "architectureIntegrity",
  "technologyAdaptation",
  "migrationIntegrity",
  "noContradictingTechnologies",
  "onePrimaryTechnologyPerResponsibility",
]);

function normalizeFindingKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/^canonical instruction compliance\s*[—-]\s*[^:]+:\s*/i, "")
    .replace(/\b(fail|review|pass)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function quotedTerms(text: string): string[] {
  return [...text.matchAll(/["“]([^"”]+)["”]/g)].map((m) => m[1]!.trim()).filter(Boolean);
}

function addRootFinding(target: RootRepairFinding[], finding: RootRepairFinding): void {
  const normalized = normalizeFindingKey(finding.description);
  if (!normalized) return;
  const duplicateIndex = target.findIndex((existing) => {
    const prior = normalizeFindingKey(existing.description);
    if (prior === normalized || prior.includes(normalized) || normalized.includes(prior)) return true;
    const priorQuotes = quotedTerms(existing.description).map((q) => q.toLowerCase());
    const nextQuotes = quotedTerms(finding.description).map((q) => q.toLowerCase());
    return priorQuotes.length > 0 && nextQuotes.length > 0 && nextQuotes.every((q) => priorQuotes.includes(q));
  });
  if (duplicateIndex === -1) {
    target.push({ ...finding, key: normalized });
    return;
  }
  // When a canonical layer and recruiter assessment report the same defect, keep one root but retain
  // the recruiter assessment's more precise, deterministic section/path attribution.
  if (finding.source === "RECRUITER_QUALITY" && finding.automaticRepairSafe) {
    target[duplicateIndex] = { ...finding, key: normalized };
  }
}

function rootFromBlockingFailure(failure: BlockingFailure): RootRepairFinding {
  const ambiguityText = `${failure.description} ${failure.recommendedCorrection ?? ""}`;
  return {
    key: normalizeFindingKey(failure.description),
    description: `${failure.type}: ${failure.description}`,
    source: "BLOCKING_FAILURE",
    evidenceSource: failure.evidenceSearched ?? [],
    reason: failure.recommendedCorrection ?? failure.description,
    candidateInputRequired: /\b(ambiguous|unclear|cannot determine|could not determine|evidence is insufficient)\b/i.test(ambiguityText),
  };
}

/** Questions are a last-resort product of genuinely ambiguous evidence, never a restatement of a
 * deterministic formatting/removal task. Callers surface these only after automatic attempts end. */
export function buildCandidateRepairQuestions(plan: RepairPlan): CandidateRepairQuestion[] {
  const questions = new Map<string, CandidateRepairQuestion>();
  for (const operation of plan.operations ?? []) {
    if (!operation.candidateInputRequired || questions.has(operation.rootFinding)) continue;
    const subject = operation.employer
      ? `Did you personally perform the described work while at ${operation.employer}?`
      : `Can you confirm the experience described in this finding: ${operation.reason}`;
    questions.set(operation.rootFinding, {
      findingKey: operation.rootFinding,
      question: subject,
      choices: ["Yes", "No", "Not sure"],
    });
  }
  return [...questions.values()];
}

/** Collapse the review's several reporting layers into actual content defects. Gate statuses remain
 * untouched on the review; this only determines what the writer is asked to edit. */
export function extractRootRepairFindings(review: StructuredResumeReview): RootRepairFinding[] {
  const roots: RootRepairFinding[] = [];
  for (const failure of review.blockingFailures ?? []) addRootFinding(roots, rootFromBlockingFailure(failure));
  for (const issue of review.blockingIssues ?? []) {
    addRootFinding(roots, {
      key: normalizeFindingKey(issue),
      description: issue,
      source: "BLOCKING_ISSUE",
      evidenceSource: [],
      reason: issue,
      candidateInputRequired: false,
    });
  }
  for (const correction of review.requiredCorrections ?? []) {
    if (/^Canonical instruction compliance — /.test(correction.description)) continue;
    addRootFinding(roots, {
      key: normalizeFindingKey(correction.description),
      description: correction.description,
      source: "REQUIRED_CORRECTION",
      evidenceSource: [],
      reason: correction.description,
      candidateInputRequired: false,
    });
  }

  // Recruiter-quality authority is already decided by recruiterQualityGate.ts. Consume only its
  // BLOCKING findings: advisory ordering/style suggestions must never start an automatic rewrite.
  // firstTenSecondFit is a derived explanation emitted whenever a concrete positioning issue exists,
  // so it remains enforced by the gate but never becomes a second content-edit instruction.
  for (const issue of review.recruiterQualityAssessment?.issues ?? []) {
    if (issue.severity !== "BLOCKING" || META_RECRUITER_DIMENSIONS.has(issue.dimension)) continue;
    const targetPositioning = issue.dimension === "targetRoleClarity";
    const secondaryTechPositioning = issue.dimension === "excessiveSecondaryTechEmphasis";
    const automaticRepairSafe = targetPositioning || secondaryTechPositioning;
    addRootFinding(roots, {
      key: normalizeFindingKey(issue.description),
      description: issue.description,
      source: "RECRUITER_QUALITY",
      severity: "BLOCKING",
      artifact: "resume",
      section: targetPositioning ? "tagline" : secondaryTechPositioning ? "positioning" : "unresolved",
      proposedCorrectionType: automaticRepairSafe ? "REPAIR_TARGET_POSITIONING" : undefined,
      automaticRepairSafe,
      evidenceSource: [
        `recruiterQualityAssessment.${issue.dimension}`,
        "jdPriorityMatrix.targetRoleTitle",
        "candidate evidence",
      ],
      reason: issue.description,
      candidateInputRequired: !automaticRepairSafe,
    });
  }

  const compliance = review.instructionCompliance;
  if (!compliance) return roots;
  const hasUnsupported = (review.blockingFailures ?? []).some((f) => f.type === "UNSUPPORTED_CLAIM");
  const hasCrossDocumentRoot = (review.blockingFailures ?? []).some(
    (f) => f.type === "EMPLOYER_CONTRADICTION" || f.type === "CROSS_ARTIFACT_CONTRADICTION"
  );
  const technologyNotesSeen = new Set<string>();
  for (const [rawCheck, status] of Object.entries(compliance.checks) as [keyof InstructionComplianceChecks, InstructionComplianceChecks[keyof InstructionComplianceChecks]][]) {
    if (status === "PASS" || status === "NOT_APPLICABLE" || META_COMPLIANCE_CHECKS.includes(rawCheck)) continue;
    if (rawCheck === "masterSkillsInventoryCompliance" && hasUnsupported) continue;
    if (rawCheck === "crossDocumentConsistency" && hasCrossDocumentRoot) continue;
    const notes = compliance.checkNotes?.[rawCheck] ?? [];
    if (notes.length === 0) continue;
    for (const note of notes) {
      const noteKey = normalizeFindingKey(note);
      if (TECHNOLOGY_ROOT_CHECKS.has(rawCheck) && technologyNotesSeen.has(noteKey)) continue;
      if (TECHNOLOGY_ROOT_CHECKS.has(rawCheck)) technologyNotesSeen.add(noteKey);
      addRootFinding(roots, {
        key: noteKey,
        description: note,
        source: "COMPLIANCE",
        evidenceSource: [`instructionCompliance.${rawCheck}`],
        reason: note,
        candidateInputRequired: false,
      });
    }
  }
  return roots;
}

function splitSentences(text: string): string[] {
  return text.trim().split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/).map((s) => s.trim()).filter(Boolean);
}

function baselineTextUnits(baseline: RepairBaseline): Array<{ artifact: "resume" | "cover_letter"; section: string; path: string; text: string; employer?: string }> {
  const units: Array<{ artifact: "resume" | "cover_letter"; section: string; path: string; text: string; employer?: string }> = [];
  const resume = baseline.resume;
  if (resume) {
    units.push({ artifact: "resume", section: "tagline", path: "resume.tagline", text: resume.tagline });
    resume.summary.forEach((text, i) => units.push({ artifact: "resume", section: "summary", path: `resume.summary[${i}]`, text }));
    resume.skillGroups.forEach((group, gi) => group.items.forEach((text, ii) => units.push({ artifact: "resume", section: "skills", path: `resume.skillGroups[${gi}].items[${ii}]`, text })));
    resume.experience.forEach((entry, ei) => {
      if (entry.projectDescription) units.push({ artifact: "resume", section: "project_description", path: `resume.experience[${ei}].projectDescription`, text: entry.projectDescription, employer: entry.company });
      entry.bullets.forEach((text, bi) => units.push({ artifact: "resume", section: "experience_bullet", path: `resume.experience[${ei}].bullets[${bi}]`, text, employer: entry.company }));
    });
    resume.certifications?.forEach((text, i) => units.push({ artifact: "resume", section: "certifications", path: `resume.certifications[${i}]`, text }));
    resume.education.forEach((text, i) => units.push({ artifact: "resume", section: "education", path: `resume.education[${i}]`, text }));
  }
  baseline.coverLetter?.paragraphs.forEach((paragraph, pi) => {
    const sentences = splitSentences(paragraph);
    sentences.forEach((text, si) => units.push({ artifact: "cover_letter", section: "paragraph_sentence", path: `coverLetter.paragraphs[${pi}].sentences[${si}]`, text }));
  });
  return units;
}

function employerFromFinding(text: string, baseline: RepairBaseline): string | undefined {
  return baseline.resume?.experience.find((entry) => text.toLowerCase().includes(entry.company.toLowerCase()))?.company;
}

function operationKind(finding: RootRepairFinding): RepairOperationKind {
  if (finding.proposedCorrectionType) return finding.proposedCorrectionType;
  const text = finding.description;
  if (/UNSUPPORTED_CLAIM/i.test(text)) return "REMOVE_UNSUPPORTED_CLAIM";
  if (/unsupported skill|skill inventory/i.test(text)) return "REMOVE_UNSUPPORTED_SKILL";
  if (/employer_contradiction|attributes .+ to /i.test(text)) return "FIX_EMPLOYER_ATTRIBUTION";
  if (/project line|project description/i.test(text)) return "SHORTEN_PROJECT_DESCRIPTION";
  if (/summary/i.test(text)) return "FIX_SUMMARY_SENTENCE";
  if (/skill group|skills ordering|technical skills/i.test(text)) return "MOVE_SUPPORTED_SKILL";
  if (/format|spacing|punctuation|unicode|separator/i.test(text)) return "FIX_FORMATTING";
  if (/cover letter/i.test(text)) return "FIX_COVER_LETTER_SENTENCE";
  if (/bullet/i.test(text)) return "REPLACE_BULLET";
  return "REPLACE_SENTENCE";
}

function operationsForFinding(finding: RootRepairFinding, baseline: RepairBaseline): RepairOperation[] {
  const units = baselineTextUnits(baseline);
  const description = finding.description;
  const kind = operationKind(finding);
  const employer = employerFromFinding(description, baseline);
  const quoted = quotedTerms(description);
  const needles = [...quoted, ...(employer ? [employer] : [])].filter((v) => v.length > 1);
  let matches = units.filter((unit) => needles.some((needle) => unit.text.toLowerCase().includes(needle.toLowerCase())));

  if (finding.automaticRepairSafe === false) {
    return [{
      operation: kind,
      artifact: finding.artifact ?? "resume",
      section: finding.section ?? "unresolved",
      rootFinding: finding.key,
      evidenceSource: finding.evidenceSource,
      reason: finding.reason,
      candidateInputRequired: finding.candidateInputRequired,
      editablePath: "",
    }];
  }

  if (kind === "REPAIR_TARGET_POSITIONING") {
    matches = units.filter((unit) =>
      finding.section === "tagline"
        ? unit.path === "resume.tagline"
        : unit.path === "resume.tagline" || unit.section === "summary"
    );
  } else if (kind === "FIX_EMPLOYER_ATTRIBUTION" || kind === "FIX_COVER_LETTER_SENTENCE") {
    const claim = quoted[0];
    matches = units.filter(
      (unit) =>
        unit.artifact === "cover_letter" &&
        (!claim || unit.text.toLowerCase().includes(claim.toLowerCase())) &&
        (!employer || unit.text.toLowerCase().includes(employer.toLowerCase()))
    );
  } else if (kind === "SHORTEN_PROJECT_DESCRIPTION") {
    matches = units.filter((unit) => unit.section === "project_description" && (!employer || unit.employer === employer));
  } else if (kind === "FIX_SUMMARY_SENTENCE") {
    matches = units.filter((unit) => unit.section === "summary");
  } else if (kind === "MOVE_SUPPORTED_SKILL" || kind === "REMOVE_UNSUPPORTED_SKILL") {
    return [{
      operation: kind,
      artifact: "resume",
      section: "skills",
      originalText: undefined,
      rootFinding: finding.key,
      evidenceSource: finding.evidenceSource,
      reason: finding.reason,
      candidateInputRequired: finding.candidateInputRequired,
      editablePath: "resume.skillGroups",
    }];
  }

  if (matches.length === 0) {
    return [{
      operation: kind,
      artifact: /cover letter/i.test(description) ? "cover_letter" : "resume",
      section: "unresolved",
      employer,
      rootFinding: finding.key,
      evidenceSource: finding.evidenceSource,
      reason: finding.reason,
      candidateInputRequired: finding.candidateInputRequired,
      editablePath: "",
    }];
  }

  return matches.map((match) => ({
    operation: kind,
    artifact: match.artifact,
    section: match.section,
    employer: match.employer ?? employer,
    originalText: match.text,
    rootFinding: finding.key,
    evidenceSource: finding.evidenceSource,
    reason: finding.reason,
    candidateInputRequired: finding.candidateInputRequired,
    editablePath: match.path,
  }));
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
export function planRepairScope(review: StructuredResumeReview, baseline?: RepairBaseline): RepairPlan {
  const rootFindings = extractRootRepairFindings(review);
  if (baseline?.resume || baseline?.coverLetter) {
    const operations = rootFindings.flatMap((finding) => operationsForFinding(finding, baseline));
    const editablePaths = [...new Set(operations.map((operation) => operation.editablePath).filter(Boolean))];
    const resumeFindings = rootFindings
      .filter((finding) => operations.some((operation) => operation.rootFinding === finding.key && operation.artifact === "resume"))
      .map((finding) => finding.description);
    const coverLetterFindings = rootFindings
      .filter((finding) => operations.some((operation) => operation.rootFinding === finding.key && operation.artifact === "cover_letter"))
      .map((finding) => finding.description);
    const unattributedFindings = rootFindings
      .filter((finding) => operations.some((operation) => operation.rootFinding === finding.key && !operation.editablePath))
      .map((finding) => finding.description);
    const hasResume = operations.some((operation) => operation.artifact === "resume" && operation.editablePath);
    const hasCover = operations.some((operation) => operation.artifact === "cover_letter" && operation.editablePath);
    const scope: RepairScope = hasResume && hasCover ? "FULL" : hasCover ? "COVER_LETTER_ONLY" : hasResume ? "RESUME_ONLY" : "FULL";
    const reason =
      unattributedFindings.length > 0
        ? `${unattributedFindings.length} root finding(s) need candidate clarification before any content can safely change.`
        : `CareerOps identified ${operations.length} surgical operation(s) across ${editablePaths.length} editable path(s); every other path is frozen.`;
    return {
      scope,
      reason,
      resumeFindings,
      coverLetterFindings,
      unattributedFindings,
      rootFindings,
      operations,
      editablePaths,
    };
  }

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
      /* A check that did not apply to the iteration is not a finding to repair — telling the writer
       * to fix something that was never evaluated would put a phantom instruction in the plan. */
      if (isComplianceBlocking(compliance.checks[check])) {
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
      rootFindings,
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
      rootFindings,
    };
  }
  if (hasCover) {
    return {
      scope: "COVER_LETTER_ONLY",
      reason: `Every remaining finding (${coverLetterFindings.length}) is confined to the cover letter; the reviewed resume is kept exactly as written.`,
      resumeFindings,
      coverLetterFindings,
      unattributedFindings,
      rootFindings,
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
      rootFindings,
    };
  }
  return {
    scope: "FULL",
    reason: "No finding could be attributed to a specific document, so the full package is regenerated.",
    resumeFindings,
    coverLetterFindings,
    unattributedFindings,
    rootFindings,
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
    out +=
      "Both documents contain at least one listed repair, but this is NOT permission to regenerate either document. " +
      "Only the explicit editable paths below may change; all other content in both documents remains frozen.\n\n";
  }

  if (plan.operations && plan.operations.length > 0) {
    out += "### Explicit repair operations\n";
    for (const operation of plan.operations) {
      out += `- **${operation.operation}** \`${operation.editablePath || "NO_SAFE_PATH"}\``;
      if (operation.employer) out += ` (${operation.employer})`;
      out += ` — ${operation.reason}${operation.candidateInputRequired ? " **CANDIDATE INPUT REQUIRED; do not guess.**" : ""}\n`;
    }
    out += "\n";
    if (plan.operations.some((operation) => operation.operation === "REPAIR_TARGET_POSITIONING")) {
      out +=
        "For target-positioning repairs, use the target-role context only to improve supported positioning. " +
        "Do not blindly copy the JD title, introduce a technology or responsibility absent from candidate evidence, " +
        "or change any field outside the explicit editable path(s).\n\n";
    }
  }
  if (plan.editablePaths) {
    out += "### Frozen-content contract\n";
    out += plan.editablePaths.length > 0
      ? `The ONLY editable paths are:\n${plan.editablePaths.map((path) => `- \`${path}\``).join("\n")}\n\n`
      : "No path is safely editable without candidate input. Return the baseline unchanged.\n\n";
    out +=
      "Every other summary sentence, skill group/item/order, project description, experience bullet, metric, employer, " +
      "date, education/certification entry, contact field, and cover-letter sentence is FROZEN and must remain " +
      "byte-for-byte unchanged. CareerOps verifies this deterministically and rejects collateral rewrites before review.\n\n";
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
