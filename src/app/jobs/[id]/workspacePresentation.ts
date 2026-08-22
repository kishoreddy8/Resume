import type { ResumeStageKey } from "./resumeStage";
import { isStepNavigable, type StepKey, type WorkflowStep } from "./workflowSteps";

export interface WorkspaceHeroPresentation {
  status: {
    label: string;
    tone: "success" | "accent" | "warning" | "error" | "neutral";
  };
  action: {
    label: string;
    step: StepKey;
    focus: "tailor" | "retailor" | "progress" | "revalidate" | "issues" | null;
  } | null;
}

interface PresentationInput {
  matchDecision: string | null;
  resumeStage: ResumeStageKey | null;
  qualityLoading: boolean;
  readiness: string | null;
  humanMaySend: boolean | null;
  canRevalidate: boolean;
  runStatuses: string[];
  steps: WorkflowStep[];
}

function canOpen(steps: WorkflowStep[], key: StepKey): boolean {
  const step = steps.find((item) => item.key === key);
  return Boolean(step && isStepNavigable(step) && !step.lockedReason);
}

/**
 * Candidate-facing words over existing authorities. This never computes eligibility: the match
 * decision, resume stage, canonical readiness and resolved step guards are supplied by their
 * owners. If a target is not already reachable, no action is returned.
 */
export function workspaceHeroPresentation(input: PresentationInput): WorkspaceHeroPresentation {
  const submitted = input.runStatuses.some(
    (status) => status === "SUBMITTED" || status === "SUBMISSION_UNCONFIRMED"
  );
  const hasRun = input.runStatuses.length > 0;
  const resumeBusy =
    input.resumeStage === "waiting_writer" ||
    input.resumeStage === "review" ||
    input.resumeStage === "improvement";
  const resumeNeedsReview =
    input.resumeStage === "failed" || input.resumeStage === "safe_best_attempt";

  let status: WorkspaceHeroPresentation["status"];
  if (submitted) status = { label: "Application submitted", tone: "success" };
  else if (hasRun) status = { label: "Application in progress", tone: "accent" };
  else if (input.qualityLoading) status = { label: "Checking resume status", tone: "neutral" };
  else if (input.humanMaySend === false || input.readiness === "BLOCKED")
    status = { label: "Blocked", tone: "error" };
  else if (input.readiness === "READY" && input.humanMaySend === true)
    status = { label: "Application ready", tone: "success" };
  else if (resumeNeedsReview) status = { label: "Needs review", tone: "warning" };
  else if (resumeBusy) status = { label: "Tailoring", tone: "accent" };
  else if (input.resumeStage === "ready") status = { label: "Ready to use", tone: "success" };
  else if (input.matchDecision === "BLOCKED") status = { label: "Blocked", tone: "error" };
  else if (input.matchDecision === "NEEDS_REVIEW") status = { label: "Needs review", tone: "warning" };
  else if (input.matchDecision === "READY_FOR_TAILORING")
    status = { label: "Ready to tailor", tone: "success" };
  else status = { label: "Not evaluated", tone: "neutral" };

  let requested: WorkspaceHeroPresentation["action"] = null;
  if (hasRun) requested = { label: "Open application", step: "application", focus: null };
  else if (input.qualityLoading) requested = null;
  else if (input.humanMaySend === false || input.readiness === "BLOCKED") {
    requested = input.canRevalidate
      ? { label: "Re-run validation", step: "validation", focus: "revalidate" }
      : { label: "Review issues", step: "validation", focus: "issues" };
  } else if (input.readiness === "READY" && input.humanMaySend === true)
    requested = { label: "Start application", step: "application", focus: null };
  else if (resumeBusy) requested = { label: "View progress", step: "results", focus: "progress" };
  else if (resumeNeedsReview)
    requested = { label: "Review issues", step: "validation", focus: "issues" };
  else if (input.matchDecision === "BLOCKED" || input.matchDecision === "NEEDS_REVIEW")
    requested = { label: "Review match", step: "match", focus: null };
  else if (input.matchDecision === "READY_FOR_TAILORING")
    requested = { label: "Tailor resume", step: "studio", focus: "tailor" };
  else requested = { label: "Review match", step: "match", focus: null };

  return {
    status,
    action:
      requested && (canOpen(input.steps, requested.step) || requested.step === "match")
        ? requested
        : null,
  };
}
