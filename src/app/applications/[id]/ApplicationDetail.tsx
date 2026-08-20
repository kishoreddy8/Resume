"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { LoadingRegion, PageHeader, SkeletonRows, Surface } from "@/components/ui";
import { MARKER_CLASS, MARKER_TEXT, presentStatus } from "../runStatus";

/**
 * One application run: what it is, what it did, and what it needs.
 *
 * WAITING IS NOT FAILURE. A run stopped on a CAPTCHA or an unknown question shows what to do about
 * it, in the engine's own words. Nothing on this page describes a paused run as an error.
 *
 * THE TIMELINE IS RECORDED EVENTS ONLY. Every line is a row the engine wrote as it happened. A run
 * with no history shows none rather than an invented "started" entry.
 *
 * APPROVAL IS THE ONLY PATH TO SUBMISSION, and it carries this run's id. The server refuses an
 * approval that names a different run, and the state machine refuses the transition independently.
 * The button is disabled while the review reports anything unresolved — approving an incomplete
 * form would ask the user to bless a submission that cannot succeed.
 */

interface RunDetail {
  id: number;
  jobId: number;
  title: string;
  company: string | null;
  ats: string | null;
  applyUrl: string | null;
  status: string;
  prompt: string | null;
  blockingReason: string | null;
  question: string | null;
  resumeFile: string | null;
  coverLetterFile: string | null;
  submitApprovedAt: string | null;
  submittedAt: string | null;
  confirmationText: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ReviewLine {
  question: string;
  value: string;
  source: string;
}

interface Review {
  answers: ReviewLine[];
  documents: ReviewLine[];
  unresolved: { question: string; reason: string }[];
  warnings: string[];
  canApprove: boolean;
}

interface RunEvent {
  id: number;
  event_type: string;
  detail: string | null;
  created_at: string;
}

const fileName = (p: string | null) => (p ? p.split("/").pop() ?? p : null);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  );
}

export function ApplicationDetail({ runId }: { runId: number }) {
  const candidateId = useResolvedCandidateId();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "answer" | "resume" | "submit">(null);
  const [answer, setAnswer] = useState("");
  const [reuse, setReuse] = useState(false);
  const answerRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    try {
      const res = await fetch(`/api/candidates/${candidateId}/application-runs?runId=${runId}`);
      if (!res.ok) return setError("This application could not be loaded.");
      const body = await res.json();
      setRun(body.run);
      setReview(body.review ?? null);
      setEvents(body.events ?? []);
    } catch {
      setError("This application could not be loaded.");
    }
  }, [candidateId, runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /* Focus the answer field when a run is waiting on one — the whole reason the page was opened. */
  useEffect(() => {
    if (run?.status === "WAITING_FOR_ANSWER") answerRef.current?.focus();
  }, [run?.status]);

  async function post(body: unknown, kind: "answer" | "resume" | "submit") {
    if (candidateId === null) return;
    setBusy(kind);
    setError(null);
    try {
      const url =
        kind === "answer"
          ? `/api/candidates/${candidateId}/application-runs`
          : `/api/candidates/${candidateId}/application-runs/start`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(b.error ?? "That action could not be completed.");
        return;
      }
      await load();
    } catch {
      setError("That action could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  if (candidateId === null || (!run && !error)) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Application" description="One application run." />
        <LoadingRegion label="Loading application" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={5} />
        </Surface>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Application" description="One application run." />
        <p className="text-[12.5px] text-tertiary">{error}</p>
        <Link href="/applications" className="text-[12.5px] text-secondary underline-offset-2 hover:underline">
          ← All applications
        </Link>
      </div>
    );
  }

  const p = presentStatus(run.status);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Link href="/applications" className="text-[11.5px] text-tertiary underline-offset-2 hover:underline">
          ← All applications
        </Link>
        <PageHeader
          title={run.title}
          description={[run.company, run.ats].filter(Boolean).join(" · ") || "Application run"}
        />
      </div>

      {/* ── status ─────────────────────────────────────────────────────────────────────────── */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${MARKER_CLASS[p.marker]}`} />
          <span className={`text-[14px] font-semibold ${MARKER_TEXT[p.marker]}`}>{p.label}</span>
          {run.applyUrl && (
            <a
              href={run.applyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-[11.5px] text-secondary underline-offset-2 hover:underline"
            >
              Open posting ↗
            </a>
          )}
        </div>
        {run.prompt && <p className="mt-1.5 text-[12.5px] leading-relaxed text-secondary">{run.prompt}</p>}
        {run.blockingReason && <p className="mt-1 text-[12px] leading-relaxed text-tertiary">{run.blockingReason}</p>}
        {run.confirmationText && (
          <p className="mt-1.5 text-[12px] leading-relaxed text-tertiary">
            <span className="text-[var(--success)]">Site confirmation: </span>“{run.confirmationText}”
          </p>
        )}

        {/* Resume, for anything paused that is not an unknown question — CAPTCHA, MFA, account. */}
        {p.needsUser && run.status !== "WAITING_FOR_ANSWER" && run.status !== "READY_FOR_REVIEW" && (
          <button
            type="button"
            onClick={() => post({ action: "resume", runId: run.id }, "resume")}
            disabled={busy !== null}
            className="mt-3 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
          >
            {busy === "resume" ? "Continuing…" : "I've done that — continue"}
          </button>
        )}
      </Surface>

      {/* ── intervention: an unknown question ──────────────────────────────────────────────── */}
      {run.status === "WAITING_FOR_ANSWER" && run.question && (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[13.5px] font-semibold text-primary">This application asked something</h2>
          <label className="mt-2.5 block">
            <span className="text-[12.5px] font-medium text-secondary">{run.question}</span>
            <input
              ref={answerRef}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Your answer"
              className="mt-1.5 w-full rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[16px] text-primary outline-none transition-colors duration-150 ease-out hover:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] sm:text-[13px]"
            />
          </label>

          {/* Separate from answering, and unchecked. The server ignores it for question types whose
           *  policy forbids unattended reuse, so this can only ever narrow what happens. */}
          <label className="mt-2 flex items-center gap-2 text-[11.5px] text-secondary">
            <input
              type="checkbox"
              checked={reuse}
              onChange={(e) => setReuse(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Reuse this answer for equivalent questions
          </label>

          <button
            type="button"
            onClick={() => post({ runId: run.id, answer, reuseForEquivalentQuestions: reuse }, "answer")}
            disabled={busy !== null || answer.trim().length === 0}
            className="mt-2.5 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "answer" ? "Saving…" : "Save answer and continue"}
          </button>
          <p className="mt-1.5 text-[11px] leading-relaxed text-tertiary">
            Career-Ops never answers a question it cannot evidence. Your answer is what gets typed.
          </p>
        </Surface>
      )}

      {/* ── final review ───────────────────────────────────────────────────────────────────── */}
      {run.status === "READY_FOR_REVIEW" && review && (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[13.5px] font-semibold text-primary">Ready for your review</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-tertiary">
            These are the exact values that will be sent. Nothing is submitted until you approve it.
          </p>

          <div className="mt-3 space-y-3">
            <div>
              <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Documents</h3>
              <ul className="mt-1 space-y-0.5 text-[12px] text-secondary">
                <li>Resume: {fileName(run.resumeFile) ?? <span className="text-tertiary">none attached</span>}</li>
                <li>
                  Cover letter: {fileName(run.coverLetterFile) ?? <span className="text-tertiary">none attached</span>}
                </li>
              </ul>
            </div>

            {review.answers.length > 0 && (
              <div>
                <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
                  Answers ({review.answers.length})
                </h3>
                <ul className="mt-1 space-y-1">
                  {review.answers.map((a) => (
                    <li key={a.question} className="text-[12px] leading-relaxed">
                      <span className="text-tertiary">{a.question}: </span>
                      <span className="text-primary">{a.value}</span>
                      {/* Provenance is shown, because "who decided this" is the reviewer's question. */}
                      <span className="ml-1.5 text-[10.5px] uppercase tracking-[0.06em] text-tertiary">
                        {a.source.replace(/_/g, " ").toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {review.warnings.length > 0 && (
              <div>
                <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Worth knowing</h3>
                <ul className="mt-1 space-y-0.5 text-[12px] leading-relaxed text-[var(--warning)]">
                  {review.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {review.unresolved.length > 0 && (
              <div>
                <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
                  Still unanswered
                </h3>
                <ul className="mt-1 space-y-0.5 text-[12px] leading-relaxed text-[var(--error)]">
                  {review.unresolved.map((u) => (
                    <li key={u.question}>
                      {u.question} — <span className="text-tertiary">{u.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => post({ action: "submit", runId: run.id, approvedRunId: run.id }, "submit")}
              disabled={busy !== null || !review.canApprove}
              className="rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "submit" ? "Submitting…" : "Approve & Submit"}
            </button>
            <Link
              href="/applications"
              className="rounded-md border border-[var(--border)] px-3 py-2 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
            >
              Cancel
            </Link>
            {!review.canApprove && (
              <span className="text-[11.5px] text-tertiary">
                Answer everything still unanswered before this can be submitted.
              </span>
            )}
          </div>
        </Surface>
      )}

      {/* ── documents ──────────────────────────────────────────────────────────────────────── */}
      <Section title="Documents">
        <Surface level="z2" className="rounded-[var(--radius-lg)] px-3.5 py-3 text-[12px] leading-relaxed text-secondary">
          <p>
            Resume: {fileName(run.resumeFile) ?? <span className="text-tertiary">none</span>}
            {run.resumeFile && (
              <span className="ml-1.5 text-[11px] text-[var(--success)]">passed the quality pipeline</span>
            )}
          </p>
          <p className="mt-0.5">
            Cover letter: {fileName(run.coverLetterFile) ?? <span className="text-tertiary">none generated</span>}
          </p>
          <p className="mt-1.5 text-[11px] text-tertiary">
            Only a resume that reached READY in the quality pipeline is ever attached.
          </p>
        </Surface>
      </Section>

      {/* ── timeline ───────────────────────────────────────────────────────────────────────── */}
      <Section title="Timeline">
        {events.length === 0 ? (
          <p className="text-[12px] text-tertiary">No events recorded for this run yet.</p>
        ) : (
          <ol className="space-y-1.5">
            {events.map((e) => (
              <li key={e.id} className="flex gap-2.5 text-[12px] leading-relaxed">
                <span className="shrink-0 tabular-nums text-tertiary">
                  {new Date(e.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="text-secondary">
                  {e.event_type.replace(/_/g, " ")}
                  {e.detail && <span className="text-tertiary"> — {e.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {error && (
        <p role="alert" className="text-[12.5px] text-[var(--error)]">
          {error}
        </p>
      )}
    </div>
  );
}
