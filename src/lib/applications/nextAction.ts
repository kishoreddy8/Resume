/**
 * The single most useful next step for one application, derived from recorded state alone.
 *
 * Every branch reads a stored fact: the pipeline stage the user set, whether they approved
 * tailoring, whether generated files exist on disk. There is no scoring, no urgency, no deadline
 * and no "recommended for you" — none of those are things this app knows, and inventing one would
 * put pressure on a decision the user owns.
 */

export interface ApplicationRecord {
  dedupeKey: string;
  jobId: number;
  title: string;
  company: string | null;
  stage: string;
  stageUpdatedAt: string | null;
  markedForTailoring: boolean;
  pinned: boolean;
  notInterested: boolean;
  notes: string | null;
  generatedFileCount: number;
  nextAction: string;
}

export function deriveNextAction(app: ApplicationRecord): string {
  if (app.notInterested) return "Marked not interested — no action";

  switch (app.stage) {
    case "Offer":
      return "Offer recorded — decide and update the stage";
    case "Employer Rejected":
      return "Closed — no action";
    case "Interviewing":
      return "Prepare for interview";
    case "Applied":
      return "Awaiting response — update the stage when you hear back";
    case "Interested":
      if (app.generatedFileCount > 0) return "Review the generated resume, then apply";
      if (app.markedForTailoring) return "Tailoring approved — run the writer";
      return "Approve tailoring to start a resume";
    case "New":
    default:
      return "Review this job";
  }
}
