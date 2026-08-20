"use client";

import type { JobWithCompany } from "@/types";
import type { JobMatch } from "./useJobMatch";
import { RESUME_STEPS, type ResumeStageSummary } from "./resumeStage";

/**
 * TAILOR → RESUME → APPLY, as a single dimensional band.
 *
 * This replaces the three-cell strip with a composition that reads as one object: a thin connecting
 * path with three state nodes on it, each carrying a label, a real state word, and a qualifier.
 * It is deliberately NOT three tiles — the three stages are one sequence, and drawing them as
 * separate cards was the thing the brief called card soup.
 *
 * RELATIONSHIP TO THE WORKFLOW RAIL (they are not duplicates):
 *   the rail   answers WHERE AM I     — five stages, position, one active node
 *   this band  answers WHAT EXISTS    — the last three stages' actual recorded state
 * The rail never prints a state word; this never prints a position. No copy appears twice.
 *
 * DATA BOUNDARY — every value comes from the detail payload the page already fetched:
 * `marked_for_tailoring`, `tailoring_marked_at`, `pipeline_status`, `generatedFiles.length`, and
 * the match decision. Nothing here calls the quality-workflow endpoint, which ResumeQualityPipeline
 * already fetches lower on this same page.
 *
 * Consequence, stated rather than hidden: the resume QUALITY verdict (READY / SAFE_BEST_ATTEMPT /
 * FAILED) lives only behind that endpoint. So RESUME reports whether files exist — which it can
 * prove — and points down for the verdict. "Generated" is never upgraded to "Ready" here.
 *
 * WRITER is a real, constant fact of this deployment (Resume Writer is off), so it is stated once
 * as context rather than animated as though something were running.
 */

type Tone = "done" | "active" | "idle" | "unknown" | "blocked";

const NODE: Record<Tone, string> = {
  done: "bg-[var(--success)] shadow-[0_0_10px_var(--success)]",
  active: "bg-[var(--accent)] shadow-[0_0_11px_var(--accent)]",
  blocked: "bg-[var(--error)] shadow-[0_0_10px_var(--error)]",
  idle: "bg-[var(--separator)]",
  unknown: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};

const APPLIED: readonly string[] = ["Applied", "Interviewing", "Offer", "Employer Rejected"];

interface Stage {
  label: string;
  value: string;
  note: string | null;
  tone: Tone;
}

export function resolveStudioStages(
  job: Pick<JobWithCompany, "marked_for_tailoring" | "tailoring_marked_at" | "pipeline_status">,
  match: JobMatch,
  generatedFileCount: number,
  resume?: ResumeStageSummary | null
): Stage[] {
  const decision = match.result?.decision ?? null;
  const approved = job.marked_for_tailoring === 1;

  const tailoring: Stage = approved
    ? {
        label: "Tailoring",
        value: "Approved",
        note: job.tailoring_marked_at ? `Marked ${job.tailoring_marked_at.slice(0, 10)}` : null,
        tone: "done",
      }
    : decision === "READY_FOR_TAILORING"
      ? { label: "Tailoring", value: "Ready", note: "Not approved yet", tone: "active" }
      : decision === "BLOCKED"
        ? { label: "Tailoring", value: "Not ready", note: "Blocked", tone: "blocked" }
        : decision === "NEEDS_REVIEW"
          ? { label: "Tailoring", value: "Not ready", note: "Needs review", tone: "idle" }
          : { label: "Tailoring", value: "Not ready", note: "Not evaluated", tone: "unknown" };

  /* The real workflow stage wins when it exists. This is the same record the detailed pipeline
   * renders — reported upward, not fetched again — so the two can no longer disagree. */
  const resumeStage: Stage =
    resume && resume.key !== "not_started"
      ? {
          label: "Resume",
          value: resume.label,
          note: resume.detail ?? (generatedFileCount > 0 ? `${generatedFileCount} file${generatedFileCount === 1 ? "" : "s"}` : null),
          tone: resume.tone === "unknown" ? "unknown" : resume.tone,
        }
      : generatedFileCount > 0
      ? {
          label: "Resume",
          value: "Generated",
          note: `${generatedFileCount} file${generatedFileCount === 1 ? "" : "s"} — quality verdict below`,
          tone: "done",
        }
      : approved
        ? { label: "Resume", value: "Not generated", note: "Writer off — run the skill", tone: "idle" }
        : { label: "Resume", value: "Not generated", note: null, tone: "idle" };

  const pipeline = job.pipeline_status ?? null;
  const apply: Stage =
    pipeline === null
      ? { label: "Apply", value: "Unknown", note: "Not recorded", tone: "unknown" }
      : APPLIED.includes(pipeline)
        ? { label: "Apply", value: pipeline, note: null, tone: "done" }
        : { label: "Apply", value: "Not applied", note: `Status: ${pipeline}`, tone: "idle" };

  return [tailoring, resumeStage, apply];
}

export function TailoringStudio({
  job,
  match,
  generatedFileCount,
  resume,
  onJumpToPipeline,
}: {
  job: Pick<JobWithCompany, "marked_for_tailoring" | "tailoring_marked_at" | "pipeline_status">;
  match: JobMatch;
  generatedFileCount: number;
  resume?: ResumeStageSummary | null;
  onJumpToPipeline?: () => void;
}) {
  const stages = resolveStudioStages(job, match, generatedFileCount, resume);

  return (
    <section
      aria-label="Tailoring and resume status"
      className="tint-craft relative overflow-hidden rounded-[var(--radius-lg)] px-4 py-3.5 shadow-[inset_0_1px_0_var(--edge-hi),var(--lift-1)]"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
          Tailoring &amp; resume
        </h3>
        {/* A standing fact of this deployment, stated once — not a status that changes. */}
        <span className="shrink-0 text-[10px] uppercase tracking-[0.07em] text-tertiary">Writer off</span>
      </div>

      <ol className="mt-3 flex items-start">
        {stages.map((stage, i) => (
          <li key={stage.label} className="relative flex min-w-0 flex-1 flex-col">
            {/* The connecting path. Lit only where the previous stage genuinely completed. */}
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute left-0 top-[4px] h-px w-full -translate-x-1/2 ${
                  stages[i - 1].tone === "done" ? "bg-[var(--accent)] opacity-45" : "bg-[var(--separator)]"
                }`}
              />
            )}
            <span aria-hidden="true" className={`relative z-[1] h-2 w-2 rounded-full ${NODE[stage.tone]}`} />
            <span className="mt-2 text-[9px] font-semibold uppercase tracking-[0.1em] text-tertiary">
              {stage.label}
            </span>
            <span className="mt-0.5 truncate text-[14px] font-semibold leading-tight tracking-[-0.01em] text-primary">
              {stage.value}
            </span>
            {stage.note && <span className="mt-0.5 text-[10.5px] leading-snug text-tertiary">{stage.note}</span>}
          </li>
        ))}
      </ol>

      {/* The resume sub-pipeline, mirrored from the SAME workflow record the detailed pipeline
       *  renders. It lives here because the top of the page is where you ask "where does this
       *  stand"; the detailed section below is where you act on it. Rendered only once a workflow
       *  actually exists — an empty five-step strip would imply a process that has not started. */}
      {resume && resume.key !== "not_started" && (
        <div className="mt-4 border-t border-[var(--separator)] pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[9px] font-semibold uppercase tracking-[0.11em] text-tertiary">
              Resume workflow
            </span>
            {onJumpToPipeline && (
              <button
                type="button"
                onClick={onJumpToPipeline}
                className="shrink-0 rounded px-1 text-[10.5px] text-secondary transition-colors duration-150 ease-out hover:text-primary active:scale-[0.97]"
              >
                Open details ↓
              </button>
            )}
          </div>
          <ol className="mt-2 grid grid-cols-5 gap-1.5">
            {RESUME_STEPS.map((step, i) => {
              const past = i < resume.step;
              const current = i === resume.step;
              return (
                <li key={step} className="flex flex-col gap-1">
                  <span
                    aria-hidden="true"
                    className={`h-[3px] w-full rounded-full ${
                      current && resume.tone === "blocked"
                        ? "bg-[var(--error)]"
                        : current && resume.tone === "done"
                          ? "bg-[var(--success)]"
                          : current
                            ? "bg-[var(--accent)]"
                            : past
                              ? "bg-[var(--accent)] opacity-40"
                              : "bg-[var(--separator)]"
                    }`}
                  />
                  <span
                    className={`truncate text-[9px] uppercase tracking-[0.07em] ${
                      current ? "font-semibold text-primary" : past ? "text-tertiary" : "text-tertiary opacity-60"
                    }`}
                  >
                    {step}
                  </span>
                </li>
              );
            })}
          </ol>
          {/* The stage in words, so the strip is never the only carrier of meaning. */}
          <p className="mt-1.5 text-[10.5px] text-tertiary">
            Currently: <span className="font-medium text-secondary">{resume.label}</span>
            {resume.detail ? ` — ${resume.detail}` : ""}
          </p>
        </div>
      )}
    </section>
  );
}
