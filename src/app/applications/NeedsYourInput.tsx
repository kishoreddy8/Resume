"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Surface } from "@/components/ui";

/**
 * Applications stopped and waiting on the user.
 *
 * IT SAYS WHAT IT WANTS, NOT THAT IT FAILED. A run waiting for a CAPTCHA, an unknown question and
 * a submit approval need three different things, so each carries its own prompt. Nothing here is
 * described as an error — a paused application is working correctly, it is just waiting.
 *
 * A SUGGESTION IS NOT AN ANSWER. Where the vault already holds something, it prefills the field and
 * says why it is only a suggestion. The user is the one answering, every time.
 *
 * Reuse is opt-in and separate from answering: the checkbox is unchecked, and for question types
 * whose policy forbids unattended reuse the server ignores it regardless.
 */

interface WaitingRun {
  id: number;
  jobId: number;
  title: string;
  company: string | null;
  ats: string | null;
  status: string;
  prompt: string;
  blockingReason: string | null;
  question: string | null;
  suggestion: { value: string; reason: string } | null;
  updatedAt: string;
}

export function NeedsYourInput({ candidateId }: { candidateId: number }) {
  const [runs, setRuns] = useState<WaitingRun[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [reuse, setReuse] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/candidates/${candidateId}/application-runs`);
      if (!res.ok) return setRuns([]);
      const body = await res.json();
      setRuns(body.runs ?? []);
    } catch {
      setRuns([]);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function submitAnswer(run: WaitingRun) {
    const answer = (drafts[run.id] ?? run.suggestion?.value ?? "").trim();
    if (answer.length === 0) return;
    setBusy(run.id);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/application-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: run.id, answer, reuseForEquivalentQuestions: Boolean(reuse[run.id]) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "The answer could not be saved.");
        return;
      }
      await load();
    } catch {
      setError("The answer could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  if (runs === null)
    return (
      <p role="status" className="text-[12.5px] text-tertiary">
        Checking for applications that need you…
      </p>
    );

  if (runs.length === 0)
    return (
      <p className="text-[12.5px] leading-relaxed text-tertiary">
        Nothing is waiting on you. Applications appear here when one asks something JobHunt does
        not have an answer for, needs a CAPTCHA or verification code, or is ready for your review.
      </p>
    );

  return (
    <div className="flex flex-col gap-2">
      {runs.map((run) => (
        <Surface key={run.id} level="z2" className="rounded-[var(--radius-lg)] px-3.5 py-3">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <Link href={`/jobs/${run.jobId}`} className="text-[13px] font-medium text-primary underline-offset-2 hover:underline">
              {run.title}
            </Link>
            {run.company && <span className="text-[12px] text-tertiary">{run.company}</span>}
            {run.ats && <span className="text-[11px] text-tertiary">{run.ats}</span>}
            {/* The status is a word, and the prompt says what to do about it. */}
            <span className="ml-auto text-[11.5px] font-medium text-[var(--accent)]">
              {run.status.replace(/_/g, " ").toLowerCase()}
            </span>
          </div>

          <p className="mt-1 text-[12px] leading-relaxed text-secondary">{run.prompt}</p>
          {run.blockingReason && <p className="mt-0.5 text-[11.5px] text-tertiary">{run.blockingReason}</p>}

          {run.question && (
            <div className="mt-2.5">
              <label className="block">
                <span className="text-[12px] font-medium text-secondary">{run.question}</span>
                <input
                  value={drafts[run.id] ?? run.suggestion?.value ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [run.id]: e.target.value }))}
                  className="mt-1 w-full rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[16px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:text-[13px]"
                />
              </label>
              {run.suggestion && (
                <p className="mt-1 text-[11px] leading-relaxed text-tertiary">
                  Prefilled from your saved answers. {run.suggestion.reason}
                </p>
              )}

              <label className="mt-2 flex items-center gap-2 text-[11.5px] text-secondary">
                <input
                  type="checkbox"
                  checked={Boolean(reuse[run.id])}
                  onChange={(e) => setReuse((r) => ({ ...r, [run.id]: e.target.checked }))}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                Reuse this answer for equivalent questions
              </label>

              <button
                type="button"
                onClick={() => submitAnswer(run)}
                disabled={busy === run.id}
                className="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
              >
                {busy === run.id ? "Saving…" : "Save answer and resume"}
              </button>
            </div>
          )}
        </Surface>
      ))}

      {error && (
        <p role="alert" className="text-[12px] text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
