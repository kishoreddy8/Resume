"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { onBuildStarted } from "@/lib/buildEvents";
import { shortFailure } from "@/app/onboarding/stageModel";

/**
 * A slim strip showing a profile build that is running somewhere else.
 *
 * The build takes two minutes and used to hold someone on one page for all of it. Making it
 * server-side freed them to move around — but that alone would have relocated the confusion rather
 * than fixing it: wander into Jobs mid-build and you see zero matches with no explanation, which
 * reads exactly like the app being broken. This is the thread that follows them.
 *
 * Polling, not streaming, and every four seconds: a build is minutes long, so a slower poll costs
 * nothing anyone can perceive and avoids a socket per page. It stops entirely when nothing is
 * running, so an idle app makes no requests at all.
 */
export function SetupProgressStrip() {
  const candidateId = useResolvedCandidateId();
  const [status, setStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /* Dismissal is tied to WHICH build was dismissed, not a boolean. A later build then shows itself
   * without needing an effect to reset the flag — and dismissing one outcome cannot hide the next. */
  const [dismissedFor, setDismissedFor] = useState<number | null>(null);

  /* Set once the endpoint answers 401. A locked profile must stop being polled entirely: every
   * 401 anywhere in the app dispatches the profile-locked event, so a background poll that kept
   * retrying would throw an unsolicited PIN prompt at the user every few seconds forever. Being
   * unable to read the build state is also a perfectly good reason not to report on it. */
  const [locked, setLocked] = useState(false);
  /* A ref as well as state: state does not update until the next render, so an interval tick that
   * fires in between would issue a second doomed request. The ref stops it on the very first. */
  const lockedRef = useRef(false);

  const poll = useCallback(async () => {
    try {
      if (lockedRef.current || candidateId === null) return;
      const res = await fetch(`/api/candidates/${candidateId}/build-profile`);
      if (res.status === 401) {
        lockedRef.current = true;
        setLocked(true);
        return;
      }
      if (!res.ok) return;
      const body = await res.json();
      setStatus(body.status ?? "idle");
      setStartedAt(body.startedAt ?? null);
      setError(body.status === "failed" ? shortFailure(body.failureCode ?? null) : null);
      setPhase(body.phase ?? null);
    } catch {
      // A failed poll is not worth surfacing; the next one will tell the truth.
    }
  }, [candidateId]);

  /* One check on mount — enough to catch a build that started before this page existed — and then
   * silence. Repeat polling only happens while something is actually running. */
  useEffect(() => {
    if (locked || candidateId === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    poll();
  }, [poll, locked, candidateId]);

  /* Interval only while a build is in flight. An idle app makes no requests at all. */
  useEffect(() => {
    if (status !== "running" || locked || candidateId === null) return;
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [status, poll, locked, candidateId]);

  /* A build begun on another page — or in another tab — announces itself rather than being
   * discovered by polling for it. */
  useEffect(() => {
    if (candidateId === null) return;
    return onBuildStarted((id) => {
      if (id === candidateId) {
        setStatus("running");
        poll();
      }
    });
  }, [candidateId, poll]);

  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [status]);

  if (locked) return null;
  if (status === "idle") return null;
  if (dismissedFor !== null && dismissedFor === startedAt) return null;

  const seconds = startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  const tone =
    status === "failed"
      ? "border-[var(--error)]/35 bg-[color-mix(in_oklab,var(--error)_8%,transparent)]"
      : status === "done"
        ? "border-[var(--success)]/35 bg-[color-mix(in_oklab,var(--success)_8%,transparent)]"
        : "border-[var(--border)] bg-[var(--z1-bg)]";

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex shrink-0 items-center gap-3 border-b px-4 py-1.5 text-[12px] lg:px-6 ${tone}`}
    >
      {status === "running" && (
        <span aria-hidden="true" className="relative block h-1.5 w-1.5 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-[var(--accent)] opacity-60" />
          <span className="absolute inset-0 rounded-full bg-[var(--accent)]" />
        </span>
      )}

      <span className="min-w-0 flex-1 truncate text-secondary">
        {status === "running" && (
          <>
            {/* The phase is whatever the build last actually did. Before the first one arrives it
             *  says so plainly rather than inventing a starting step. */}
            {phase ?? "Setting up this profile"}
            {" — "}
            <span className="tabular-nums text-tertiary">{clock} elapsed, usually about two minutes.</span>{" "}
            <span className="text-tertiary">Job matches appear once it finishes.</span>
          </>
        )}
        {status === "done" && <span className="text-[var(--success)]">Profile built. Evaluating jobs next.</span>}
        {status === "failed" && <span className="text-[var(--error)]">{error ?? "The profile build did not finish."}</span>}
      </span>

      {status !== "running" && (
        <Link href="/onboarding" className="shrink-0 text-secondary underline-offset-2 hover:underline">
          Open setup
        </Link>
      )}
      {status !== "running" && (
        <button
          type="button"
          onClick={() => setDismissedFor(startedAt)}
          aria-label="Dismiss"
          className="shrink-0 rounded px-1 text-tertiary transition-colors duration-150 ease-out hover:text-primary"
        >
          ✕
        </button>
      )}
    </div>
  );
}
