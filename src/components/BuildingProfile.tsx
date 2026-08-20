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
 * the measured one.
 *
 * The phase line now reports what the build ACTUALLY did. The CLI runs under --output-format
 * stream-json, so each file it reads and the moment it writes the profile arrive as events; the
 * server records the furthest one reached and this shows it verbatim. Before the first event lands
 * — or if the caller has no phase to pass — it falls back to a time-based line that claims only
 * what the clock can support.
 *
 * There is still deliberately NO percentage and no bar that fills. Knowing which step is running is
 * not the same as knowing how much remains, and a bar advancing on a timer would be a comforting
 * fiction — the same class of lie as inventing evidence. Past the expected duration it stops
 * reassuring and offers the manual command instead, because continuing to say "nearly there" would
 * be guessing.
 */

/** Measured on a real resume: 2m06s. SLOW is comfortably past it, not a guess dressed as one. */
const SLOW_MS = 210_000;

export function BuildingProfile({
  candidateId,
  /** The server's observed phase, already worded for display. Null until the first event arrives. */
  phase: observedPhase = null,
}: {
  candidateId: number;
  phase?: string | null;
}) {
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

  /* A real observation always wins over a guess from the clock. The slow warning is the exception:
   * once past the measured duration, how long it has taken matters more than what it is doing. */
  let phase: string;
  if (slow) phase = "Still working — this is longer than usual.";
  else if (observedPhase) phase = `${observedPhase}…`;
  else phase = elapsed < 3_000 ? "Starting…" : "Reading your documents…";

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
