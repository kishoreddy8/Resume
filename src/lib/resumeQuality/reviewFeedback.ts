import { matchesCurrentInstructions } from "./canonicalInstructions";
import {
  CORRECTION_PRIORITIES,
  INSTRUCTION_COMPLIANCE_CHECK_NAMES,
  type CorrectionPriority,
  type InstructionComplianceChecks,
  type StructuredResumeReview,
} from "./types";

/**
 * Renders StructuredResumeReview into human-readable Markdown (resume_review_feedback.md). Structured
 * JSON remains the authoritative format — this is a derived, read-only rendering, never parsed back.
 */

function scoreLine(label: string, score: number): string {
  return `- **${label}:** ${score}/100`;
}

function section(title: string, items: readonly string[]): string {
  if (items.length === 0) return "";
  return `\n## ${title}\n\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

const PRIORITY_ORDER: readonly CorrectionPriority[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function correctionsSection(review: StructuredResumeReview): string {
  if (review.requiredCorrections.length === 0) return "";
  const byPriority = new Map<CorrectionPriority, string[]>();
  for (const priority of CORRECTION_PRIORITIES) byPriority.set(priority, []);
  for (const correction of review.requiredCorrections) {
    byPriority.get(correction.priority)!.push(correction.description);
  }

  let out = "\n## Required Corrections\n";
  for (const priority of PRIORITY_ORDER) {
    const items = byPriority.get(priority)!;
    if (items.length === 0) continue;
    out += `\n### ${priority}\n\n${items.map((d) => `- ${d}`).join("\n")}\n`;
  }
  return out;
}

function humanizeCheckName(name: keyof InstructionComplianceChecks): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STATUS_MARK: Record<"PASS" | "FAIL" | "REVIEW", string> = {
  PASS: "✓",
  FAIL: "✗",
  REVIEW: "⚠",
};

function complianceSection(review: StructuredResumeReview): string {
  const compliance = review.instructionCompliance;
  if (!compliance) {
    return "\n## Canonical Instruction Compliance\n\n_No canonical instruction compliance data available (legacy review)._\n";
  }

  const current = matchesCurrentInstructions(compliance);
  let out = "\n## Canonical Instruction Compliance\n\n";
  out += `- **Instruction version:** ${compliance.instructionVersion}${current ? "" : " (STALE — does not match the current canonical standard)"}\n`;
  out += `- **Instruction hash:** ${compliance.instructionHash}\n\n`;
  for (const name of INSTRUCTION_COMPLIANCE_CHECK_NAMES) {
    const status = compliance.checks[name];
    out += `- ${STATUS_MARK[status]} ${humanizeCheckName(name)}: ${status}\n`;
  }
  if (compliance.notes.length > 0) {
    out += `\n### Compliance Notes\n\n${compliance.notes.map((n) => `- ${n}`).join("\n")}\n`;
  }
  return out;
}

/**
 * Stage 26 — the hard blocking failures (see BLOCKING_FAILURE_TYPES) rendered for the writer.
 *
 * These, not `blockingIssues`, are what actually withhold READY: qualityGate.ts condition 7 requires
 * `blockingFailures` to be empty. Before Stage 26 they were rendered nowhere and carried nowhere, so a
 * writer could be rejected repeatedly for a reason it was never told — observed on the real corpus,
 * where a resume scoring 100/100/100/100 with zero blockingIssues was correctly refused for four
 * PLACEHOLDER_CONTACT failures that appeared in no feedback the writer ever saw. Each entry carries
 * the reviewer's own recommendedCorrection verbatim; nothing is re-derived or re-judged here.
 */
function blockingFailuresSection(review: StructuredResumeReview): string {
  const failures = review.blockingFailures ?? [];
  if (failures.length === 0) return "";
  let out = "\n## Blocking Failures (must be resolved before approval)\n\n";
  for (const failure of failures) {
    out += `- **${failure.type}** — ${failure.description}\n`;
    if (failure.recommendedCorrection) out += `  - Correction: ${failure.recommendedCorrection}\n`;
  }
  return out;
}

export function renderReviewFeedbackMarkdown(review: StructuredResumeReview): string {
  let out = "# Resume Review Feedback\n\n";
  out += "## Scores\n\n";
  out += `${scoreLine("Overall Quality Score", review.overallScore)}\n`;
  out += `${scoreLine("ATS Score", review.atsScore)}\n`;
  out += `${scoreLine("Keyword Alignment", review.keywordAlignmentScore)}\n`;
  out += `${scoreLine("Truthfulness", review.truthfulnessScore)}\n`;
  out += `${scoreLine("Architecture Consistency", review.architectureConsistencyScore)}\n`;
  out += `${scoreLine("Recruiter Readability", review.recruiterReadabilityScore)}\n`;
  out += `${scoreLine("Formatting", review.formattingScore)}\n`;

  out += blockingFailuresSection(review);
  out += section("Blocking Issues", review.blockingIssues);
  out += section("Missing Required Skills", review.missingRequiredSkills);
  out += section("Incorrect Technology Usage", review.incorrectTechnologyUsage);
  out += section("Generic Bullets", review.genericBullets);
  out += section("Missing Impact Evidence", review.missingImpactEvidence);
  out += section("Summary Issues", review.summaryIssues);
  out += section("Skills Ordering Issues", review.skillsOrderingIssues);
  out += section("Truthfulness Issues", review.truthfulnessIssues);
  out += complianceSection(review);
  out += correctionsSection(review);

  return out;
}
