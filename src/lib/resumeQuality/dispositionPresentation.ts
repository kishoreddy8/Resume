import type { FinalDisposition } from "./finalDisposition";

/**
 * Stage 28 closure — how a finished workflow is PRESENTED to a human.
 *
 * Extracted as a pure function rather than left inline in the React component so the rule that
 * actually matters can be tested directly: a truthful package that merely fell short of the
 * optimisation bar must never read as a failure, and must never read as READY either. Those are
 * three distinct outcomes and the words for them are deliberately different.
 *
 * The underlying workflow status stays FAILED for a safe best attempt — the quality gate genuinely
 * did not pass, and rewriting that status would corrupt the state machine. What changes is only how
 * it is described, which is exactly where the Stage 28 gap was: the browser showed a red FAILED for a
 * package whose documents were usable and whose every safety check had passed.
 */

export type DispositionTone = "SUCCESS" | "REVIEW" | "DANGER" | "NEUTRAL";

export interface DispositionPresentation {
  /** Short chip label. */
  label: string;
  /** Full headline for the result panel. */
  headline: string;
  tone: DispositionTone;
  /** True only when a human may download and send this package. */
  offerDownloads: boolean;
  /** True when the final pipeline step should render as a failure. */
  renderAsFailedStep: boolean;
}

export function presentDisposition(input: {
  workflowStatus: string;
  disposition: FinalDisposition | null;
}): DispositionPresentation {
  const { workflowStatus, disposition } = input;

  if (workflowStatus === "READY") {
    return {
      label: "READY",
      headline: "READY — ALL QUALITY GATES PASSED",
      tone: "SUCCESS",
      offerDownloads: true,
      renderAsFailedStep: false,
    };
  }

  if (disposition === "SAFE_BEST_ATTEMPT") {
    return {
      label: "SAFE BEST ATTEMPT",
      headline: "SAFE BEST ATTEMPT — HUMAN REVIEW REQUIRED",
      // Review, never success and never danger: the documents are usable, but this is not an approved
      // READY publication and must not be coloured like one.
      tone: "REVIEW",
      offerDownloads: true,
      renderAsFailedStep: false,
    };
  }

  if (workflowStatus === "FAILED") {
    // Either a genuine safety blocker, or a terminal workflow with no disposition computed at all —
    // both must refuse downloads. Absence of a verdict is never treated as safe.
    return {
      label: "BLOCKED — DO NOT APPLY",
      headline: "BLOCKED / UNSAFE — DO NOT APPLY",
      tone: "DANGER",
      offerDownloads: false,
      renderAsFailedStep: true,
    };
  }

  return {
    label: workflowStatus === "CREATED" ? "AWAITING WRITER" : workflowStatus.replace(/_/g, " "),
    headline: "Tailoring in progress",
    tone: "NEUTRAL",
    offerDownloads: false,
    renderAsFailedStep: false,
  };
}
