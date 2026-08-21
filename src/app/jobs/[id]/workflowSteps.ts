import type { JobMatchResult } from "@/lib/match/types";
import type { ResumeStageSummary } from "./resumeStage";

/**
 * The Job Workspace's five steps.
 *
 *   MATCH → RESUME STUDIO → TAILORING RESULTS → VALIDATION → APPLICATION
 *
 * TRACKING IS NOT A SIXTH STEP. An application that has been submitted is still the application —
 * it has simply moved into its own later phase. Splitting "track" out would have made the stepper
 * claim a stage the engine has no separate concept of, and would have left a step that is empty for
 * every job nobody has applied to.
 *
 * PRESENTATION ONLY. Every value below is read from state the page already holds: the persisted
 * match result, the resume workflow's own stage (see resumeStage.ts) and whether generated files
 * exist. This module evaluates nothing, writes nothing, and re-decides nothing. If it cannot prove
 * a step is reachable, the step is locked and says why — an unproven "available" is a claim, and
 * the whole point of the guard is that the engine, not the UI, decides what may run.
 *
 * The honesty rules it inherits from WorkflowRail, which it deliberately does not replace (the
 * Workbench's detail pane still uses that rail):
 *
 *  - A step is `done` only when something observable proves it.
 *  - A step whose state cannot be determined renders as locked with a reason, never as "not done".
 *  - BLOCKED is terminal for the steps beyond it. It is not a stage you pass through.
 */

export type StepKey = "match" | "studio" | "results" | "validation" | "application";

export type StepState =
  /** Finished, and something observable proves it. */
  | "done"
  /** Where the workflow currently stands. */
  | "current"
  /** Reachable now, but not yet started. */
  | "available"
  /** Not reachable yet, and `lockedReason` says what is missing. */
  | "locked"
  /** The engine refused this job. Nothing downstream opens. */
  | "blocked";

export interface WorkflowStep {
  key: StepKey;
  label: string;
  state: StepState;
  /** Why a step is locked or blocked, in a candidate's words. Never an enum, never a table name. */
  lockedReason: string | null;
}

export interface WorkflowInput {
  /** The persisted match result, or null while it is loading or was never computed. */
  result: JobMatchResult | null;
  matchLoading: boolean;
  /** The resume workflow's own stage, or null until the pipeline has reported it. */
  resume: ResumeStageSummary | null;
  /** Files actually on disk. The only proof that a resume was produced. */
  generatedFileCount: number;
  /** Application runs that exist for this job, newest first. Empty when none was ever started. */
  runStatuses: string[];
  /**
   * The validator's own answer to "may a person send this package", once Validation has read it.
   * Null while unknown.
   *
   * THIS IS NOT THE REVIEW SCORE, AND ON REAL DATA IT DISAGREES WITH IT. One job here reviews at
   * 100 on every dimension with a workflow status of READY, while the quality gate has not passed
   * and readiness is BLOCKED — "the package has not been cleared of truthfulness failures, which is
   * not the same as having passed". Gating Application on the workflow status alone therefore
   * offered to apply with a resume the engine had refused to clear.
   */
  humanMaySend: boolean | null;
}

/** Resume stages that mean a document exists to look at. */
const RESUME_PRODUCED: ReadonlySet<string> = new Set(["review", "improvement", "ready", "safe_best_attempt"]);

/** Resume stages the validator has actually reached a verdict on. */
const VALIDATION_DECIDED: ReadonlySet<string> = new Set(["ready", "safe_best_attempt", "failed"]);

/**
 * Resolves the five steps from real state.
 *
 * `active` is the step the user is looking at, which is not necessarily where the workflow stands —
 * a user may walk back to Match after generating a resume. So the step they are on renders
 * `current` and everything genuinely finished still renders `done`.
 */
export function resolveWorkflowSteps(input: WorkflowInput, active: StepKey): WorkflowStep[] {
  const { result, matchLoading, resume, generatedFileCount, runStatuses, humanMaySend } = input;

  const evaluated = Boolean(result);
  const decision = result?.decision ?? null;
  const blocked = decision === "BLOCKED";
  const resumeKey = resume?.key ?? null;

  const resumeExists = generatedFileCount > 0 || (resumeKey !== null && RESUME_PRODUCED.has(resumeKey));
  const validationDecided = resumeKey !== null && VALIDATION_DECIDED.has(resumeKey);
  const validationPassed = resumeKey === "ready";
  const applicationStarted = runStatuses.length > 0;
  const submitted = runStatuses.some((s) => s === "SUBMITTED" || s === "SUBMISSION_UNCONFIRMED");

  /* ── match ───────────────────────────────────────────────────────────────────────────────── */
  const match: WorkflowStep = matchLoading
    ? { key: "match", label: "Match", state: "current", lockedReason: null }
    : blocked
      ? { key: "match", label: "Match", state: "blocked", lockedReason: firstBlockingReason(result) }
      : evaluated
        ? { key: "match", label: "Match", state: "done", lockedReason: null }
        : {
            key: "match",
            label: "Match",
            state: "current",
            lockedReason: "This posting has not been evaluated against your profile yet.",
          };

  /* ── resume studio ───────────────────────────────────────────────────────────────────────── */
  const studio: WorkflowStep = blocked
    ? { key: "studio", label: "Resume Studio", state: "blocked", lockedReason: "This job is blocked, so nothing is tailored for it." }
    : !evaluated
      ? { key: "studio", label: "Resume Studio", state: "locked", lockedReason: "Evaluate the match first." }
      : resumeExists
        ? { key: "studio", label: "Resume Studio", state: "done", lockedReason: null }
        : { key: "studio", label: "Resume Studio", state: "available", lockedReason: null };

  /* ── tailoring results ───────────────────────────────────────────────────────────────────── */
  /* REACHABLE IS NOT PRODUCED. Like Validation below, this opens once the job has been evaluated,
   * because the panel inside it reads the tailoring record and says plainly when no resume exists.
   * Locking it on `generatedFileCount` alone was wrong in both directions: a job with a completed
   * workflow but no files still on disk was locked out of its own results, and the gate could only
   * be satisfied by data that is not fetched until the step is entered. */
  const results: WorkflowStep = blocked
    ? { key: "results", label: "Tailoring Results", state: "blocked", lockedReason: "This job is blocked." }
    : !evaluated
      ? { key: "results", label: "Tailoring Results", state: "locked", lockedReason: "Evaluate the match first." }
      : resumeExists && validationDecided
        ? { key: "results", label: "Tailoring Results", state: "done", lockedReason: null }
        : { key: "results", label: "Tailoring Results", state: "available", lockedReason: null };

  /* ── validation ──────────────────────────────────────────────────────────────────────────────
   * REACHABLE IS NOT PASSED. The step opens once the job has been evaluated, because the pipeline
   * inside it is the thing that knows whether a resume exists and says so plainly when one does
   * not. What it cannot do is read as finished: `done` requires a verdict the validator actually
   * returned, so nothing here can make an unvalidated resume look validated. */
  const validation: WorkflowStep = blocked
    ? { key: "validation", label: "Validation", state: "blocked", lockedReason: "This job is blocked." }
    : !evaluated
      ? { key: "validation", label: "Validation", state: "locked", lockedReason: "Evaluate the match first." }
      : validationDecided
        ? { key: "validation", label: "Validation", state: "done", lockedReason: null }
        : { key: "validation", label: "Validation", state: "available", lockedReason: null };

  /* ── application ─────────────────────────────────────────────────────────────────────────── */
  /* Opened by the resume the executor would actually attach, or by a run that already exists —
   * never by this component's opinion of whether the candidate is "ready". The server refuses a
   * start it cannot support and says why; that refusal remains the authority. */
  const application: WorkflowStep = blocked
    ? { key: "application", label: "Application", state: "blocked", lockedReason: "This job is blocked." }
    : applicationStarted
      ? { key: "application", label: "Application", state: submitted ? "done" : "current", lockedReason: null }
      : humanMaySend === false
        ? {
            /* Reachable, so the reason is readable — but never `available`, because the validator
             * has explicitly refused to clear this package. */
            key: "application",
            label: "Application",
            state: "current",
            lockedReason: "The validator has not cleared this resume to be sent.",
          }
        : humanMaySend === true || validationPassed
          ? { key: "application", label: "Application", state: "available", lockedReason: null }
          : validationDecided
            ? {
                key: "application",
                label: "Application",
                state: "available",
                lockedReason: "Your resume needs a look before you apply.",
              }
            : {
                /* Reachable, with the readiness checklist inside reporting where the resume stands.
                 * The real guard is the server: `StartApplication` refuses any start it cannot
                 * support and says why, and submission needs its own approval on the run. Locking
                 * the step here instead would hide that explanation behind a disabled tab. */
                key: "application",
                label: "Application",
                state: "available",
                lockedReason: "Open Validation to confirm the resume before you apply.",
              };

  const steps = [match, studio, results, validation, application];

  /* The step being viewed reads `current` — unless it is genuinely blocked, which outranks being
   * looked at. Its underlying done/locked truth is unchanged and still drives navigability. */
  return steps.map((s) => (s.key === active && s.state !== "blocked" ? { ...s, state: "current" as const } : s));
}

/** A step may be opened when it is not locked and not blocked. */
export function isStepNavigable(step: WorkflowStep): boolean {
  return step.state !== "locked" && step.state !== "blocked";
}

/** The engine's first blocking reason, verbatim. Never re-worded, never softened. */
function firstBlockingReason(result: JobMatchResult | null): string | null {
  const reasons = result?.blockingReasons ?? [];
  return reasons.length > 0 ? reasons[0]! : null;
}

/**
 * Where the workflow actually stands, used as the landing step on first open.
 *
 * Deliberately the furthest step with something to do rather than the furthest reached: someone
 * returning to a job with a validated resume should land on Application, not be walked back
 * through Match.
 */
export function defaultStep(input: WorkflowInput): StepKey {
  const steps = resolveWorkflowSteps(input, "match");
  const byKey = new Map(steps.map((s) => [s.key, s]));

  /* An in-flight application is where the work is, wherever else it could be. */
  const application = byKey.get("application")!;
  if (application.state === "current") return "application";

  /* VALIDATION IS DELIBERATELY NOT A LANDING STEP while it is merely `available`. Available means
   * reachable, and the panel behind it costs 4.5-29KB to open — landing there would make every job
   * pay for the validation record on first paint whether or not anyone wanted it. It is chosen
   * only when a verdict already exists, which is the case where it is genuinely the next thing. */
  const order: StepKey[] = ["application", "results", "studio", "match"];
  for (const key of order) {
    const step = byKey.get(key)!;
    if (step.state === "current" || step.state === "available") return key;
  }
  return "match";
}
