import { CORRECTION_PRIORITIES, type CorrectionPriority, type StructuredResumeReview } from "./types";

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

  out += section("Blocking Issues", review.blockingIssues);
  out += section("Missing Required Skills", review.missingRequiredSkills);
  out += section("Incorrect Technology Usage", review.incorrectTechnologyUsage);
  out += section("Generic Bullets", review.genericBullets);
  out += section("Missing Impact Evidence", review.missingImpactEvidence);
  out += section("Summary Issues", review.summaryIssues);
  out += section("Skills Ordering Issues", review.skillsOrderingIssues);
  out += section("Truthfulness Issues", review.truthfulnessIssues);
  out += correctionsSection(review);

  return out;
}
