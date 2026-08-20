import type { FieldPlan } from "./agent/types";
import { unresolvedRequired } from "./agent/planFields";

/**
 * What the user sees before anything is submitted, and the rule that nothing is submitted without
 * them seeing it.
 *
 * THE REVIEW IS BUILT FROM THE PLAN, NOT FROM A SUMMARY OF IT. Every value listed is the value that
 * will actually be typed, with the source it came from. A review that paraphrased the plan could
 * drift from it, and the whole point is that the user approves the real thing.
 */

export interface ReviewLine {
  question: string;
  value: string;
  /** Where it came from — shown, because "who decided this" is the question a reviewer has. */
  source: string;
}

export interface FinalReview {
  company: string | null;
  role: string;
  ats: string | null;
  resumeFile: string | null;
  coverLetterFile: string | null;
  /** Values that will be typed. */
  answers: ReviewLine[];
  /** Documents that will be attached. */
  documents: ReviewLine[];
  /** Required fields with nothing planned. Non-empty means this must not be submitted yet. */
  unresolved: { question: string; reason: string }[];
  /** Anything worth reading before approving, in plain words. */
  warnings: string[];
  /** False whenever `unresolved` is non-empty. The UI must not offer approval. */
  canApprove: boolean;
}

export function buildFinalReview(input: {
  company: string | null;
  role: string;
  ats: string | null;
  plans: FieldPlan[];
  resumeFile: string | null;
  coverLetterFile: string | null;
}): FinalReview {
  const answers: ReviewLine[] = [];
  const documents: ReviewLine[] = [];

  for (const plan of input.plans) {
    if (plan.action === "fill") {
      answers.push({ question: plan.field.label ?? plan.canonicalKey ?? plan.field.selector, value: plan.value, source: plan.source });
    } else if (plan.action === "upload") {
      documents.push({ question: plan.field.label ?? "Attachment", value: plan.filePath, source: plan.source });
    }
  }

  const unresolved = unresolvedRequired(input.plans).map((p) => ({
    question: p.action === "ask" ? p.question : (p.field.label ?? p.field.selector),
    reason: p.action === "ask" || p.action === "skip" ? p.reason : "Not answered.",
  }));

  const warnings: string[] = [];
  if (!input.resumeFile) warnings.push("No resume will be attached.");
  if (!input.coverLetterFile) warnings.push("No cover letter will be attached.");
  const optionalUnanswered = input.plans.filter((p) => p.action === "ask" && !p.field.required).length;
  if (optionalUnanswered > 0) {
    warnings.push(`${optionalUnanswered} optional question${optionalUnanswered === 1 ? "" : "s"} will be left blank.`);
  }

  return {
    company: input.company,
    role: input.role,
    ats: input.ats,
    resumeFile: input.resumeFile,
    coverLetterFile: input.coverLetterFile,
    answers,
    documents,
    unresolved,
    warnings,
    /* A required field with no answer means the form is incomplete. Offering approval would ask the
     * user to bless a submission that cannot succeed, or worse, one that submits partially. */
    canApprove: unresolved.length === 0,
  };
}

/**
 * Reading the site's own response after a submit click.
 *
 * A CLICK IS NOT A CONFIRMATION. The run is marked submitted only when the page says something that
 * genuinely indicates receipt. Anything else is SUBMISSION_UNCONFIRMED and the user is asked to
 * check — recording success because a button was pressed would tell someone they applied when they
 * may not have.
 */
const CONFIRMATION_PHRASES = [
  "application received",
  "thank you for applying",
  "thanks for applying",
  "your application has been submitted",
  "application submitted",
  "we have received your application",
  "successfully submitted",
  "thank you for your interest",
];

export function readSubmissionOutcome(pageText: string): { confirmed: boolean; evidence: string | null } {
  const lower = pageText.toLowerCase();
  for (const phrase of CONFIRMATION_PHRASES) {
    const at = lower.indexOf(phrase);
    if (at >= 0) {
      /* The surrounding sentence is kept as evidence, so the record shows WHY it was called
       * submitted rather than just asserting it. */
      return { confirmed: true, evidence: pageText.slice(Math.max(0, at - 40), at + phrase.length + 60).trim() };
    }
  }
  return { confirmed: false, evidence: null };
}
