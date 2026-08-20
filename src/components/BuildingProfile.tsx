"use client";

import { useEffect, useState } from "react";

/**
 * The waiting state for a profile build.
 *
 * A build takes around two minutes — measured at 2m06s on a real resume — and the first version
 * showed only the word "Building…". People concluded it was broken and gave up, which is a worse
 * outcome than a slow success.
 *
 * Everything here is real. The elapsed counter is a clock, not a simulation. The typical duration is
 * the measured one. There is deliberately NO percentage and no progress bar that fills: the app
 * cannot see inside the CLI run, so any bar would be a comforting fiction — and inventing progress
 * is the same class of lie as inventing evidence.
 *
 * The phase line changes only at thresholds the app genuinely knows: extraction happens in-process
 * and is over in well under a second, so anything past that is honestly "Claude is reading". Past
 * the expected duration it stops reassuring and offers the manual command instead, because at that
 * point continuing to say "nearly there" would be guessing.
 */

/** Measured on a real resume: 2m06s. SLOW is comfortably past it, not a guess dressed as one. */
const SLOW_MS = 210_000;

export function BuildingProfile({ candidateId }: { candidateId: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(id);
  }, []);

  const seconds = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(seconds / 60)).padStart(1, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const slow = elapsed > SLOW_MS;

  const phase =
    elapsed < 3_000
      ? "Extracting text from your documents…"
      : slow
        ? "Still working — this is longer than usual."
        : "Claude is reading your resume and skills inventory…";

  return (
    <div>
      <div className="flex items-baseline gap-2.5">
        {/* Indeterminate on purpose: a filling bar would imply knowledge the app does not have. */}
        <span aria-hidden="true" className="relative mt-1 block h-1.5 w-1.5 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-60" />
          <span className="absolute inset-0 rounded-full bg-[var(--accent)]" />
        </span>
        <div className="min-w-0">
          <p className="text-[12.5px] font-medium text-primary">{phase}</p>
          <p className="mt-0.5 text-[11.5px] tabular-nums text-tertiary">
            {mm}:{ss} elapsed · usually takes about two minutes
          </p>
        </div>
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-tertiary">
        It is safe to leave this page open. Nothing is written until the result passes the same
        validation the matching engine uses — a failed build leaves your existing profile untouched.
      </p>

      {slow && (
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--warning)]">
          If you would rather not wait, run{" "}
          <span className="select-all text-secondary">/build-candidate-profile {candidateId}</span> in
          Claude Code — it does exactly the same work.
        </p>
      )}

      <span role="status" aria-live="polite" className="sr-only">
        {phase} {seconds} seconds elapsed.
      </span>
    </div>
  );
}
