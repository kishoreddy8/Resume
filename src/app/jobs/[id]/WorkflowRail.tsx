"use client";

import { motion, useReducedMotion } from "motion/react";
import type { JobWithCompany } from "@/types";
import type { JobMatch } from "./useJobMatch";
import type { ResumeStageSummary } from "./resumeStage";

/**
 * MATCH → REVIEW → TAILOR → RESUME → APPLY.
 *
 * Every stage reads real state the page already holds. There is no progress percentage, no timer,
 * and no animation that runs while nothing is happening — the rail is static except when the
 * underlying state actually changes, at which point the active node's position changes with it.
 *
 * The honesty rules that shaped this:
 *
 *  - A stage is `done` only when something observable proves it. RESUME is done when generated
 *    files exist on disk, not when tailoring was approved.
 *  - A stage whose state cannot be determined from this page's data renders `unknown` (hollow,
 *    dashed) rather than defaulting to incomplete. Incomplete is a claim; unknown is the truth.
 *  - There is deliberately no "generating" state between TAILOR and RESUME. Resume Writer is off,
 *    so nothing runs on its own; an approved job sits at TAILOR:done / RESUME:waiting until the
 *    user runs the skill. Animating a traveling light there would be inventing activity.
 *  - APPLY reads the candidate-personal pipeline status. When that column is null the stage is
 *    `unknown`, never "not applied".
 */

export type StageState = "done" | "active" | "waiting" | "unknown" | "blocked";

export interface RailStage {
  key: string;
  label: string;
  state: StageState;
  /** Spoken by screen readers and shown on hover — the state in words, never colour alone. */
  detail: string;
}

/** Presentation mapping only. Reads existing state; decides nothing and writes nothing. */
export function resolveWorkflowStages(
  match: JobMatch,
  job: Pick<JobWithCompany, "marked_for_tailoring" | "pipeline_status">,
  generatedFileCount: number,
  /** The real resume-workflow stage, reported up by ResumeQualityPipeline (no extra request).
   *  Null until that component has loaded, in which case RESUME falls back to file existence. */
  resume?: ResumeStageSummary | null
): RailStage[] {
  const result = match.result;
  const evaluating = match.state === "loading" || match.state === "idle";
  const evaluated = Boolean(result);
  const decision = result?.decision ?? null;
  const approved = job.marked_for_tailoring === 1;
  const hasResume = generatedFileCount > 0;
  const pipeline = job.pipeline_status ?? null;

  const matchStage: RailStage = evaluating
    ? { key: "match", label: "Match", state: "active", detail: "Reading this posting's evaluation." }
    : evaluated
      ? { key: "match", label: "Match", state: "done", detail: "Evaluated against your profile." }
      : { key: "match", label: "Match", state: "waiting", detail: "Not scored against your profile yet." };

  // REVIEW is where a decision lands. BLOCKED stops here and says so — it is not a stage you pass.
  const reviewStage: RailStage = !evaluated
    ? { key: "review", label: "Review", state: "waiting", detail: "No decision yet." }
    : decision === "BLOCKED"
      ? { key: "review", label: "Review", state: "blocked", detail: "Blocked — a hard blocker stands." }
      : decision === "NEEDS_REVIEW"
        ? { key: "review", label: "Review", state: "active", detail: "Needs review before tailoring." }
        : decision === "READY_FOR_TAILORING"
          ? { key: "review", label: "Review", state: "done", detail: "Cleared review — ready for tailoring." }
          : { key: "review", label: "Review", state: "unknown", detail: "Decision not recorded." };

  const tailorStage: RailStage = approved
    ? { key: "tailor", label: "Tailor", state: "done", detail: "Tailoring approved by you." }
    : decision === "READY_FOR_TAILORING"
      ? { key: "tailor", label: "Tailor", state: "active", detail: "Ready to approve tailoring." }
      : { key: "tailor", label: "Tailor", state: "waiting", detail: "Not approved for tailoring." };

  /* RESUME used to know only whether files existed on disk, while the real Created/Writer/Review/
   * Improvement/Ready progress lived in a separate strip at the bottom of the page — so you could
   * not tell from here where a resume actually stood. It now reads that same workflow record. */
  const resumeStage: RailStage =
    resume && resume.key !== "not_started"
      ? {
          key: "resume",
          label: "Resume",
          state:
            resume.tone === "done" ? "done" : resume.tone === "blocked" ? "blocked" : resume.tone === "active" ? "active" : "waiting",
          detail: [resume.label, resume.detail].filter(Boolean).join(" — "),
        }
      : hasResume
        ? {
            key: "resume",
            label: "Resume",
            state: "done",
            detail: `${generatedFileCount} generated file${generatedFileCount === 1 ? "" : "s"}.`,
          }
        : approved
          ? { key: "resume", label: "Resume", state: "waiting", detail: "Approved — Resume Writer is off, run the skill." }
          : { key: "resume", label: "Resume", state: "waiting", detail: "No resume generated." };

  // The pipeline column is candidate-personal workflow state. Only the statuses that PROVE an
  // application was submitted complete this stage — "New" and "Interested" are pre-application and
  // were previously (wrongly) rendering as done. Null means "not recorded", which is not the same
  // as "not applied", so it renders unknown rather than incomplete.
  const APPLIED: readonly string[] = ["Applied", "Interviewing", "Offer", "Employer Rejected"];
  const applyStage: RailStage =
    pipeline === null || pipeline === undefined
      ? { key: "apply", label: "Apply", state: "unknown", detail: "Application status not recorded." }
      : APPLIED.includes(pipeline)
        ? { key: "apply", label: "Apply", state: "done", detail: `Pipeline status: ${pipeline}.` }
        : { key: "apply", label: "Apply", state: "waiting", detail: `Pipeline status: ${pipeline} — not applied yet.` };

  return [matchStage, reviewStage, tailorStage, resumeStage, applyStage];
}

const NODE: Record<StageState, string> = {
  done: "bg-[var(--success)] shadow-[0_0_9px_var(--success)]",
  active: "bg-[var(--accent)] shadow-[0_0_10px_var(--accent)]",
  blocked: "bg-[var(--error)] shadow-[0_0_9px_var(--error)]",
  waiting: "bg-[var(--separator)]",
  unknown: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};

const LABEL: Record<StageState, string> = {
  done: "text-secondary",
  active: "text-primary font-semibold",
  blocked: "text-[var(--error)] font-semibold",
  waiting: "text-tertiary",
  unknown: "text-tertiary",
};

export function WorkflowRail({ stages }: { stages: RailStage[] }) {
  const reduced = useReducedMotion() ?? false;
  const activeIndex = stages.findIndex((s) => s.state === "active" || s.state === "blocked");

  return (
    <div className="relative">
      {/* The list is the accessible representation. Sighted users read the same words below each
       *  node — state is never carried by colour or position alone. */}
      <ol className="flex items-start gap-0">
        {stages.map((stage, i) => (
          <li key={stage.key} className="relative flex min-w-0 flex-1 flex-col items-center">
            {/* Connecting segment. Lit only between stages that are genuinely complete. */}
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute left-[-50%] top-[5px] h-px w-full ${
                  stages[i - 1].state === "done" && (stage.state === "done" || stage.state === "active")
                    ? "bg-[var(--accent)] opacity-55"
                    : "bg-[var(--separator)]"
                }`}
              />
            )}

            {stage.state === "active" && !reduced ? (
              // The one moving part, and it only exists on the stage the workflow is actually at.
              // layoutId means the highlight travels when real state changes, and does nothing
              // otherwise — there is no loop here.
              <motion.span
                layoutId="workflow-active-node"
                aria-hidden="true"
                transition={{ type: "spring", duration: 0.34, bounce: 0.1 }}
                className={`relative z-[1] mt-[1px] h-2.5 w-2.5 rounded-full ${NODE.active}`}
              />
            ) : (
              <span
                aria-hidden="true"
                className={`relative z-[1] mt-[1px] h-2.5 w-2.5 shrink-0 rounded-full ${NODE[stage.state]}`}
              />
            )}

            <span className={`mt-1.5 truncate text-[9.5px] font-medium uppercase tracking-[0.09em] ${LABEL[stage.state]}`}>
              {stage.label}
            </span>
            <span className="sr-only">: {stage.detail}</span>
          </li>
        ))}
      </ol>

      {/* The current stage in words, so the rail is never the only carrier of meaning. */}
      {activeIndex >= 0 && (
        <p className="mt-2 text-center text-[11.5px] leading-relaxed text-tertiary">{stages[activeIndex].detail}</p>
      )}
    </div>
  );
}
