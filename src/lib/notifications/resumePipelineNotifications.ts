import { createNotificationIfAbsent } from "@/db/queries/notifications";

/**
 * Stage 12 — resume-writer-pipeline notification types, layered on the EXISTING notifications
 * table/dedup mechanism (schema.sql's UNIQUE(candidate_id, dedupe_key, type) index) with no schema
 * change. Per explicit direction: dedupe_key here is always the REAL canonical job dedupe_key (the
 * same value used everywhere else in this codebase for job identity) — never a synthetic
 * workflow/iteration-scoped key. That means each of these four event types can fire at most ONCE,
 * ever, per (candidate, job) pair — a second workflow run against the same job later will not
 * re-notify. Full iteration-by-iteration history remains authoritative in resume_quality_workflows /
 * resume_quality_iterations / the on-disk review artifacts; a QUALITY_FAILURE notification is "the
 * first meaningful alert for this job", not a per-iteration log. (Finer per-workflow/per-iteration
 * notification identity would need a schema change — explicitly out of scope for this pass; see the
 * implementation report for that as a documented future enhancement.)
 */

export const RESUME_READY_NOTIFICATION_TYPE = "RESUME_READY";
export const WRITER_FAILURE_NOTIFICATION_TYPE = "WRITER_FAILURE";
export const QUALITY_FAILURE_NOTIFICATION_TYPE = "QUALITY_FAILURE";
export const HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE = "HUMAN_REVIEW_REQUIRED";

export interface ResumePipelineNotificationContext {
  candidateId: number;
  dedupeKey: string;
  companyName: string;
  jobTitle: string;
}

function safeCreate(input: { candidateId: number; dedupeKey: string; type: string; title: string; body: string }): boolean {
  try {
    return createNotificationIfAbsent(input);
  } catch {
    // Notification failures must never invalidate an otherwise successful/failed workflow outcome —
    // the worker calls this fire-and-forget, never lets a notification error propagate.
    return false;
  }
}

export function notifyResumeReady(ctx: ResumePipelineNotificationContext): boolean {
  return safeCreate({
    candidateId: ctx.candidateId,
    dedupeKey: ctx.dedupeKey,
    type: RESUME_READY_NOTIFICATION_TYPE,
    title: `Resume Ready — ${ctx.companyName} ${ctx.jobTitle}`,
    body: "CareerOps approved the tailored resume. Quality gate passed.",
  });
}

export interface WriterFailureContext extends ResumePipelineNotificationContext {
  technicalRetry: number;
}

export function notifyWriterFailure(ctx: WriterFailureContext): boolean {
  return safeCreate({
    candidateId: ctx.candidateId,
    dedupeKey: ctx.dedupeKey,
    type: WRITER_FAILURE_NOTIFICATION_TYPE,
    title: `Resume writer failed — ${ctx.companyName} ${ctx.jobTitle}`,
    body: `Claude did not produce valid writer output. Technical retry ${ctx.technicalRetry} failed.`,
  });
}

export interface QualityFailureContext extends ResumePipelineNotificationContext {
  iteration: number;
  blockingIssue: string | null;
}

export function notifyQualityFailure(ctx: QualityFailureContext): boolean {
  return safeCreate({
    candidateId: ctx.candidateId,
    dedupeKey: ctx.dedupeKey,
    type: QUALITY_FAILURE_NOTIFICATION_TYPE,
    title: `Resume quality review failed — ${ctx.companyName} ${ctx.jobTitle}`,
    body: `Iteration ${ctx.iteration} did not pass.${ctx.blockingIssue ? ` Blocking issue: ${ctx.blockingIssue}.` : ""}`,
  });
}

export interface HumanReviewRequiredContext extends ResumePipelineNotificationContext {
  remainingBlockers: number;
  /** Stage 13 — when a best-attempt human-review package was generated, mentions it so the user knows
   *  automatic attempts are exhausted but a strongest-attempt resume/cover letter is available. Both
   *  optional and additive: omitting them leaves the body text exactly as before (backward compatible
   *  with any caller that doesn't yet have this data). */
  bestAttemptIteration?: number;
  bestAttemptScore?: number;
}

export function notifyHumanReviewRequired(ctx: HumanReviewRequiredContext): boolean {
  const bestAttemptNote =
    ctx.bestAttemptIteration !== undefined
      ? ` Automatic attempts are exhausted. The strongest attempt (iteration ${ctx.bestAttemptIteration}${
          ctx.bestAttemptScore !== undefined ? `, score ${ctx.bestAttemptScore}` : ""
        }) is available for your review.`
      : "";
  return safeCreate({
    candidateId: ctx.candidateId,
    dedupeKey: ctx.dedupeKey,
    type: HUMAN_REVIEW_REQUIRED_NOTIFICATION_TYPE,
    title: `Human review required — ${ctx.companyName} ${ctx.jobTitle}`,
    body: `Resume did not satisfy CareerOps quality gates after the allowed iterations. Remaining blockers: ${ctx.remainingBlockers}.${bestAttemptNote}`,
  });
}
