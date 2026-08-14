import type { WorkflowStatus } from "./types";

/**
 * Legal transitions for resume_quality_workflows.status. Any "*_RUNNING" state can fail; only
 * REVIEW_COMPLETED can branch to READY (quality gate passed) or back into IMPROVEMENT_RUNNING
 * (gate failed, iterations remain) — see qualityGate.ts for the gate itself. READY and FAILED are
 * terminal: no transition leaves them. This is validated here, at the state-machine level, entirely
 * independent of any AI execution — Stage 7 does not execute the writer/reviewer, it only defines
 * and tests which transitions between these 8 states are legal.
 */
const VALID_TRANSITIONS: Record<WorkflowStatus, readonly WorkflowStatus[]> = {
  CREATED: ["WRITER_RUNNING", "FAILED"],
  WRITER_RUNNING: ["WRITER_COMPLETED", "FAILED"],
  WRITER_COMPLETED: ["REVIEW_RUNNING", "FAILED"],
  REVIEW_RUNNING: ["REVIEW_COMPLETED", "FAILED"],
  REVIEW_COMPLETED: ["READY", "IMPROVEMENT_RUNNING", "FAILED"],
  IMPROVEMENT_RUNNING: ["REVIEW_RUNNING", "FAILED"],
  READY: [],
  FAILED: [],
};

export function isValidWorkflowTransition(from: WorkflowStatus, to: WorkflowStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export class InvalidWorkflowTransitionError extends Error {
  constructor(
    public readonly from: WorkflowStatus,
    public readonly to: WorkflowStatus
  ) {
    super(`Invalid resume quality workflow transition: ${from} -> ${to}`);
    this.name = "InvalidWorkflowTransitionError";
  }
}

export function assertValidWorkflowTransition(from: WorkflowStatus, to: WorkflowStatus): void {
  if (!isValidWorkflowTransition(from, to)) {
    throw new InvalidWorkflowTransitionError(from, to);
  }
}
