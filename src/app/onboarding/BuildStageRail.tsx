"use client";

import { motion, useReducedMotion } from "motion/react";

/**
 * The profile build, as the stages that actually happened.
 *
 * EVERY ROW IS AN OBSERVATION. A stage is only ever marked done because the corresponding event
 * was seen: the app finished extracting the documents, the CLI issued a Read against a specific
 * file, the CLI issued the Write, the loader accepted the result, the rematch cursor returned
 * counts. Nothing here advances on a timer, and a stage the app cannot observe is not shown at
 * all. See the table in `stageModel.ts` for the source behind each label.
 *
 * NO PERCENTAGE, BY DESIGN. Knowing which step is running is not knowing how much remains — the
 * CLI does not publish that and neither does anything downstream. A bar filling over two minutes
 * would be a fabricated measurement, which is the same class of lie as inventing evidence. The
 * rail shows position, and the caller shows elapsed time; neither pretends to be a forecast.
 *
 * STATE IS NEVER COLOUR ALONE. Each state carries a distinct marker SHAPE and a word, so it
 * survives greyscale, low vision, and every form of colour blindness.
 */

export type StageState = "done" | "active" | "pending" | "failed" | "skipped";

export interface Stage {
  key: string;
  label: string;
  state: StageState;
  /** One short line of real detail — a count, a filename, a reason. Never filler. */
  detail?: string;
}

const STATE_WORD: Record<StageState, string> = {
  done: "done",
  active: "now",
  pending: "waiting",
  failed: "failed",
  skipped: "not needed",
};

function Marker({ state, animate }: { state: StageState; animate: boolean }) {
  if (state === "done") {
    return (
      <span
        aria-hidden="true"
        className="relative z-10 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--success)] text-[9px] font-bold leading-none text-[var(--accent-fg)]"
      >
        ✓
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span
        aria-hidden="true"
        className="relative z-10 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--error)] text-[9px] font-bold leading-none text-[var(--accent-fg)]"
      >
        ✕
      </span>
    );
  }
  if (state === "active") {
    return (
      <span aria-hidden="true" className="relative z-10 flex h-4 w-4 items-center justify-center">
        {/* One slow pulse on the ACTIVE row only. It marks where work is happening; it is not
         *  decoration, and it stops the moment the row resolves. */}
        {animate && (
          <motion.span
            className="absolute inset-0 rounded-full bg-[var(--accent)]"
            initial={{ opacity: 0.5, scale: 1 }}
            animate={{ opacity: 0, scale: 1.9 }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
          />
        )}
        <span className="relative h-4 w-4 rounded-full border-2 border-[var(--accent)] bg-surface" />
        <span className="absolute h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
      </span>
    );
  }
  // Pending and skipped: hollow. An unstarted step must never look like a weak success.
  return (
    <span
      aria-hidden="true"
      className={`relative z-10 h-4 w-4 rounded-full border border-dashed bg-surface ${
        state === "skipped" ? "border-[var(--separator)]" : "border-[var(--border)]"
      }`}
    />
  );
}

export function BuildStageRail({ stages, title = "Profile build" }: { stages: Stage[]; title?: string }) {
  const reduced = useReducedMotion() ?? false;

  const active = stages.find((s) => s.state === "active");
  const failed = stages.find((s) => s.state === "failed");

  return (
    <section aria-label={title}>
      <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">{title}</h3>

      <ol className="relative mt-3">
        {stages.map((stage, i) => {
          const last = i === stages.length - 1;
          return (
            <li key={stage.key} className="relative flex gap-3 pb-3 last:pb-0">
              {/* The connector belongs to the row above it, so the final row has no dangling tail. */}
              {!last && (
                <span
                  aria-hidden="true"
                  className={`absolute left-[7px] top-4 h-full w-px ${
                    stage.state === "done" ? "bg-[var(--success)]/40" : "bg-[var(--separator)]"
                  }`}
                />
              )}

              <div className="mt-0.5 shrink-0">
                <Marker state={stage.state} animate={!reduced} />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={`text-[12.5px] ${
                      stage.state === "active"
                        ? "font-semibold text-primary"
                        : stage.state === "done"
                          ? "text-secondary"
                          : stage.state === "failed"
                            ? "font-semibold text-[var(--error)]"
                            : "text-tertiary"
                    }`}
                  >
                    {stage.label}
                  </span>
                  {/* The word carries the state on its own, so nothing depends on the marker's colour. */}
                  <span className="text-[10px] uppercase tracking-[0.08em] text-tertiary">
                    {STATE_WORD[stage.state]}
                  </span>
                </div>
                {stage.detail && (
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-tertiary">{stage.detail}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* One polite announcement of the current step, rather than a live region over the whole
       *  list — which would re-read every row each time any of them changed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {failed ? `${failed.label} failed.` : active ? `${active.label}, in progress.` : "All build stages complete."}
      </span>
    </section>
  );
}
