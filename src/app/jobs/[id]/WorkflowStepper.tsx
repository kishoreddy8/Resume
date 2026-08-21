"use client";

import { IconCheckCircle } from "@/components/icons";
import { isStepNavigable, type StepKey, type WorkflowStep } from "./workflowSteps";

/**
 * The workspace's five-step navigation.
 *
 * IT IS NAVIGATION, NOT A PROGRESS BAR. Each node is a real destination, and pressing one changes
 * which step's body is rendered — it never starts anything, and it never advances the workflow.
 * The engine advances the workflow; this only shows where it stands and lets you look around.
 *
 * A LOCKED STEP SAYS WHY. It is rendered disabled with its reason as the accessible description
 * rather than hidden, because a step you cannot see is indistinguishable from one that does not
 * exist — and the reason ("there is no resume to validate yet") is the most useful thing on the
 * screen for someone wondering what to do next.
 *
 * STATE IS NEVER COLOUR ALONE: every node carries a number or a tick, its label, and a spoken
 * state, so it reads identically in greyscale.
 */

const STATE_WORD: Record<WorkflowStep["state"], string> = {
  done: "completed",
  current: "current step",
  available: "available",
  locked: "locked",
  blocked: "blocked",
};

export function WorkflowStepper({
  steps,
  active,
  onSelect,
}: {
  steps: WorkflowStep[];
  active: StepKey;
  onSelect: (key: StepKey) => void;
}) {
  return (
    <nav
      aria-label="Job workflow"
      className="rounded-[14px] border border-[var(--border)] bg-[var(--z3-bg)] px-2 shadow-[var(--shadow-row)]"
    >
      {/* Horizontally scrollable below the point where five labels stop fitting, rather than
       *  wrapping into five stacked boxes. */}
      <ol className="scroll-fade-none flex h-[60px] items-stretch gap-1 overflow-x-auto">
        {steps.map((step, i) => {
          const navigable = isStepNavigable(step);
          const isActive = step.key === active;
          const done = step.state === "done";
          const blocked = step.state === "blocked";

          const tone = isActive
            ? "text-[var(--accent)]"
            : done
              ? "text-[var(--pill-success-fg)]"
              : blocked
                ? "text-[var(--error)]"
                : navigable
                  ? "text-secondary"
                  : "text-tertiary";

          return (
            <li key={step.key} className="flex min-w-0 shrink-0 items-center">
              {/* `relative` is load-bearing: the sr-only spans below are position:absolute, and
               *  without a positioned ancestor their containing block becomes the viewport rather
               *  than this button. They then escape the row's overflow-x clip, sit at the far end
               *  of the scrolled track, and drag the whole document into horizontal scroll — which
               *  is exactly what they did at 390px. */}
              <button
                type="button"
                onClick={() => navigable && onSelect(step.key)}
                disabled={!navigable}
                aria-current={isActive ? "step" : undefined}
                aria-describedby={step.lockedReason ? `step-reason-${step.key}` : undefined}
                title={step.lockedReason ?? undefined}
                className={`relative flex h-full items-center gap-2.5 rounded-[10px] px-3 text-[13px] font-semibold transition-colors duration-150 ease-out ${tone} ${
                  isActive ? "bg-[var(--accent-tint)]" : navigable ? "hover:bg-[var(--surface-hover)]" : "cursor-not-allowed"
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11.5px] font-bold ${
                    done
                      ? "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]"
                      : isActive
                        ? "bg-[var(--accent)] text-white"
                        : blocked
                          ? "bg-[color-mix(in_oklab,var(--error)_12%,transparent)] text-[var(--error)]"
                          : "bg-[var(--chip-bg)] text-[var(--chip-text)]"
                  }`}
                >
                  {done ? <IconCheckCircle size={15} /> : i + 1}
                </span>
                <span className="whitespace-nowrap">{step.label}</span>
                {/* The state in words, for anything that cannot see the colour or the fill. */}
                <span className="sr-only">{` — ${STATE_WORD[step.state]}`}</span>
                {step.lockedReason && (
                  <span id={`step-reason-${step.key}`} className="sr-only">
                    {step.lockedReason}
                  </span>
                )}
              </button>

              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className={`mx-0.5 h-px w-5 shrink-0 ${
                    steps[i + 1]!.state === "done" || done ? "bg-[var(--pill-success-fg)]/40" : "bg-[var(--border)]"
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
