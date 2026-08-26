"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  LoadingRegion,
  PageHeader,
  Pill,
  SkeletonRows,
  Surface,
} from "@/components/ui";
import { IconArrowUpRight, IconCheckCircle, IconDocument, IconShield } from "@/components/icons";
import { sourceLabel } from "@/app/jobs/sourceLabel";
import { presentStatus, shouldPollRunStatus } from "../runStatus";
import type { RunStatus } from "@/lib/apply/runState";
import { applicationContext, detailPhase, primaryActionLabel, type DetailPhase } from "../grouping";
import { eventLabel, groupSummaryLabel, groupTimelineEvents } from "../eventLabels";
import { Disclosure } from "@/app/jobs/[id]/Disclosure";
import { buildAnswerSubmission, requiredQuestionsSatisfied } from "./questionBatch";
import { DEFAULT_POLICY, type QuestionType } from "@/lib/apply/questionTypes";

interface RunDetail {
  id: number;
  jobId: number;
  title: string;
  company: string | null;
  location: string | null;
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

interface HumanQuestion {
  id: string;
  selector: string;
  label: string;
  canonicalKey: string | null;
  questionType: string | null;
  required: boolean;
  kind: string;
  options: string[] | null;
  reason: string;
}

interface RunEvent {
  id: number;
  event_type: string;
  detail: string | null;
  created_at: string;
}

const PROGRESS_STAGES = ["Preparing", "Filling", "Verification", "Final review", "Submitting", "Submitted"] as const;

const fileName = (path: string | null) => (path ? path.split("/").pop() ?? path : null);

function initials(name: string | null): string {
  if (!name) return "?";
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function formatDate(iso: string | null): string {
  if (!iso) return "Not recorded";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function pillTone(marker: string, needsUser: boolean): "success" | "warning" | "info" | "neutral" {
  if (marker === "done") return "success";
  if (marker === "unknown" || needsUser) return "warning";
  if (marker === "stopped") return "neutral";
  return "info";
}

function phaseIndex(phase: DetailPhase): number {
  switch (phase) {
    case "preparing": return 0;
    case "filling":
    case "needs-input": return 1;
    case "verification": return 2;
    case "review": return 3;
    case "submitting": return 4;
    case "tracking": return 5;
  }
}

function ApplicationProgress({ status }: { status: string }) {
  const presentation = presentStatus(status);
  const stopped = presentation.marker === "stopped";
  const current = stopped ? -1 : phaseIndex(detailPhase(status));
  return (
    <section aria-labelledby="application-progress-title" className="rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] p-4 shadow-[var(--lift-1)] sm:p-5">
      <h2 id="application-progress-title" className="text-[17px] font-bold tracking-[-0.01em] text-primary">Application progress</h2>
      <ol className="mt-4 grid gap-2 sm:grid-cols-6" aria-label="Application stages">
        {PROGRESS_STAGES.map((stage, index) => {
          const complete = current >= 0 && index < current;
          const active = index === current;
          return (
            <li key={stage} aria-current={active ? "step" : undefined} className={`flex min-h-11 items-center gap-3 rounded-[10px] px-3 py-2 sm:block sm:min-h-0 sm:px-2 sm:text-center ${active ? "bg-[var(--accent-soft)]" : "bg-[var(--z0-bg)]"}`}>
              <span aria-hidden="true" className={`block h-2.5 w-2.5 shrink-0 rounded-full sm:mx-auto sm:mb-2 ${complete ? "bg-[var(--success)]" : active ? presentation.needsUser ? "bg-[var(--warning)]" : "bg-[var(--accent)]" : "bg-[var(--separator)]"}`} />
              <span className={`text-[13px] font-semibold ${active ? "text-primary" : complete ? "text-[var(--success)]" : "text-tertiary"}`}>{stage}</span>
            </li>
          );
        })}
      </ol>
      {stopped && <p className="mt-3 text-[13px] leading-5 text-tertiary">This run ended before a confirmed submission. Its recorded history is preserved below.</p>}
    </section>
  );
}

export function ApplicationDetail({ runId, embedded = false }: { runId: number; embedded?: boolean }) {
  const candidateId = useResolvedCandidateId();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "answer" | "resume" | "submit">(null);
  const [answer, setAnswer] = useState("");
  const [humanQuestions, setHumanQuestions] = useState<HumanQuestion[] | null>(null);
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({});
  const [batchReuse, setBatchReuse] = useState<Record<string, boolean>>({});
  /* UI-A — true only for the real, narrow window between "the server accepted the saved answers
   * and confirmed the run is resuming" and the next `load()` resolving with whatever the run's
   * actual new state is. Never set on the button click itself — only after both POSTs below
   * genuinely succeed — so this can never show "continuing" for a save that failed or a resume the
   * server refused. */
  const [justResumed, setJustResumed] = useState(false);
  const answerRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    try {
      const response = await fetch(`/api/candidates/${candidateId}/application-runs?runId=${runId}`);
      if (!response.ok) return setError("This application could not be loaded.");
      const body = await response.json();
      setRun(body.run);
      setReview(body.review ?? null);
      setEvents(body.events ?? []);
      setHumanQuestions(body.humanQuestions ?? null);
      setBatchAnswers({});
      setBatchReuse({});
    } catch {
      setError("This application could not be loaded.");
    }
  }, [candidateId, runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  /* UI-0 DEFECT 5 — this is the one screen watching a live, unattended browser automation, and it
   * used to fetch once and stop; a run could finish filling, hit a login wall, or need answers
   * with nothing on screen reflecting it until a manual reload. Polls only while the run is in an
   * actively-executing state (see shouldPollRunStatus) — a paused or finished run makes no further
   * requests, matching the same visibility-guarded interval convention already used in Admin. */
  const runStatus = run?.status as RunStatus | undefined;
  useEffect(() => {
    if (!runStatus || !shouldPollRunStatus(runStatus)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15_000);
    return () => clearInterval(timer);
  }, [runStatus, load]);

  useEffect(() => {
    if (run?.status === "WAITING_FOR_ANSWER") answerRef.current?.focus();
  }, [run?.status]);

  async function post(body: unknown, kind: "answer" | "resume" | "submit") {
    if (candidateId === null) return;
    setBusy(kind);
    setError(null);
    try {
      const url = kind === "answer" ? `/api/candidates/${candidateId}/application-runs` : `/api/candidates/${candidateId}/application-runs/start`;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const bodyResponse = await response.json().catch(() => ({}));
        setError(bodyResponse.error ?? "That action could not be completed.");
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
    return <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6"><PageHeader title="Application" description="Loading application details." /><LoadingRegion label="Loading application" /><Surface level="z3" className="rounded-[var(--radius-xl)] p-5"><SkeletonRows rows={5} /></Surface></div>;
  }

  if (!run) {
    return <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6"><PageHeader title="Application" description="One application run." /><p className="text-[14px] text-tertiary">{error}</p><Link href="/applications" className={`${BTN_SECONDARY} w-fit`}>Back to Applications</Link></div>;
  }

  const presentation = presentStatus(run.status);
  const reviewState = run.status === "READY_FOR_REVIEW" || run.status === "WAITING_FOR_SUBMIT_APPROVAL";
  const verificationState = ["WAITING_FOR_CAPTCHA", "WAITING_FOR_MFA", "WAITING_FOR_EMAIL_VERIFICATION", "ACCOUNT_REQUIRED"].includes(run.status);
  const ats = sourceLabel(run.ats);

  return (
    <div className={`flex w-full flex-col gap-5 ${embedded ? "" : "mx-auto max-w-[1180px] pb-12"}`}>
      {!embedded && <Link href="/applications" className="inline-flex min-h-11 w-fit items-center text-[14px] font-semibold text-secondary transition-colors hover:text-primary">‹ Back to Applications</Link>}

      {!embedded && (
        <header className="premium-gradient-surface rounded-[18px] border border-[var(--border)] p-5 shadow-[var(--lift-1)] sm:p-7">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <span aria-hidden="true" className="grid h-14 w-14 shrink-0 place-items-center rounded-[16px] bg-[var(--tile-lav-bg)] text-[16px] font-bold text-[var(--tile-lav-fg)]">{initials(run.company)}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--accent)]">Application</p>
              <h1 className="mt-1 text-[28px] font-bold leading-tight tracking-[-0.025em] text-primary sm:text-[34px]">{run.title}</h1>
              <p className="mt-2 text-[15px] leading-6 text-secondary">{run.company ?? "Company unknown"}{run.location ? ` · ${run.location}` : ""}{ats ? ` · ${ats}` : ""}</p>
              <p className="mt-1 text-[13px] text-tertiary">Updated {formatDate(run.updatedAt)}</p>
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              <Pill tone={pillTone(presentation.marker, presentation.needsUser)}>{presentation.label}</Pill>
              {run.applyUrl && <a href={run.applyUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_SECONDARY} min-h-11`}>Employer site<IconArrowUpRight size={14} /></a>}
            </div>
          </div>
          <p className="mt-5 max-w-[72ch] text-[15px] leading-6 text-secondary">{applicationContext(run.status, run.prompt)}</p>
        </header>
      )}

      <ApplicationProgress status={run.status} />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_360px] lg:items-start">
        <main className="grid gap-5">
          <section id="next-action" aria-labelledby="next-action-title" className={`rounded-[16px] border p-5 shadow-[var(--lift-1)] sm:p-6 ${presentation.needsUser ? "border-[color-mix(in_srgb,var(--warning)_30%,var(--border))] bg-[var(--z3-bg)]" : "border-[var(--border)] bg-[var(--z3-bg)]"}`}>
            <div className="flex flex-wrap items-center gap-2"><IconShield size={19} /><h2 id="next-action-title" className="text-[18px] font-bold text-primary">{presentation.needsUser ? "Needs your attention" : primaryActionLabel(run.status)}</h2><Pill tone={pillTone(presentation.marker, presentation.needsUser)}>{presentation.label}</Pill></div>

            {run.status === "WAITING_FOR_ANSWER" && humanQuestions && humanQuestions.length > 0 ? (
              <BatchQuestionForm
                humanQuestions={humanQuestions}
                batchAnswers={batchAnswers}
                batchReuse={batchReuse}
                busy={busy}
                onAnswerChange={(id, value) => setBatchAnswers((prev) => ({ ...prev, [id]: value }))}
                onReuseChange={(id, value) => setBatchReuse((prev) => ({ ...prev, [id]: value }))}
                onSave={async () => {
                  if (candidateId === null) return;
                  /* UI-0 DEFECT 4 — only questions the user actually answered are sent. A skipped
                   * optional question is omitted entirely, never sent as a blank string. */
                  const answers = buildAnswerSubmission(humanQuestions, batchAnswers, batchReuse);
                  setBusy("answer");
                  setError(null);
                  try {
                    const saveRes = await fetch(`/api/candidates/${candidateId}/application-runs`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ runId: run.id, answers }),
                    });
                    if (!saveRes.ok) {
                      const b = await saveRes.json().catch(() => ({}));
                      setError((b as { error?: string }).error ?? "Could not save answers.");
                      return;
                    }
                    /* Auto-resume: re-execute now that all answers are in the vault. */
                    const resumeRes = await fetch(`/api/candidates/${candidateId}/application-runs/start`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "resume", runId: run.id }),
                    });
                    if (!resumeRes.ok) {
                      /* UI-A.1 checkpoint fix — saveRes.ok was already confirmed true above, so it
                       * is provably true that the answers were persisted even though resuming
                       * failed. The prior generic fallback ("Could not resume application.") could
                       * read as "did my answers even save?" — say plainly that they did. The form
                       * is deliberately left as-is (no reload here) so nothing the candidate typed
                       * appears to vanish. */
                      const b = await resumeRes.json().catch(() => ({}));
                      const detail = (b as { error?: string }).error;
                      setError(
                        `Your answers were saved, but Career-Ops couldn't continue the application${detail ? `: ${detail}` : "."}`
                      );
                      return;
                    }
                    /* Both POSTs above are real, confirmed successes at this point — the run is
                     * genuinely resuming, not merely "the button was clicked". `load()` below has its
                     * own network round trip, so this renders for the real duration of that wait,
                     * then yields to whatever the run's actual next state turns out to be. */
                    setJustResumed(true);
                    await load();
                  } catch {
                    setError("Could not save answers and resume.");
                  } finally {
                    setBusy(null);
                    setJustResumed(false);
                  }
                }}
              />
            ) : justResumed ? (
              <div className="mt-4 rounded-[12px] bg-[var(--pill-success-bg)] p-3.5">
                <p className="text-[14px] font-semibold text-[var(--pill-success-fg)]">Answers saved.</p>
                <p className="mt-1 text-[13px] leading-5 text-secondary">Career-Ops is continuing your application…</p>
              </div>
            ) : run.status === "WAITING_FOR_ANSWER" && run.question ? (
              /* UI-AM.1 checkpoint finding — this legacy single-question fallback (reached when a
               * live control mismatch is discovered only at fill time, not during planning — see
               * executor.ts's fillFromPlans, which never populates checkpoint.humanQuestions for
               * this specific pause) has no questionType for this one blocking question anywhere in
               * the API response, unlike the batch path's HumanQuestion objects. canOfferAutomaticReuse
               * cannot be evaluated here, so the same "reuse" checkbox this path used to show
               * unconditionally — same bug the batch path's canOfferAutomaticReuse gating fixed —
               * cannot be truthfully offered here either. Removed rather than left promising an
               * effect this UI cannot verify; the answer is still saved and available as a
               * suggestion either way (saveAnswer's own unconditional-storage behavior, unchanged). */
              <div className="mt-4">
                <p className="text-[15px] font-semibold leading-6 text-primary">{run.question}</p>
                <label className="mt-3 block"><span className="text-[14px] font-medium text-secondary">Your answer</span><input ref={answerRef} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Enter your answer" className="mt-2 min-h-11 w-full rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" /></label>
                <button type="button" onClick={() => post({ runId: run.id, answer }, "answer")} disabled={busy !== null || answer.trim().length === 0} className={`${BTN_PRIMARY} mt-3 min-h-11 text-[14px]`}>{busy === "answer" ? "Saving…" : "Save answer and continue"}</button>
                <p className="mt-3 text-[13px] leading-5 text-tertiary">Career-Ops never answers a question it cannot evidence. Your answer is used exactly as provided.</p>
              </div>
            ) : verificationState ? (
              <div className="mt-4"><h3 className="text-[17px] font-bold text-primary">Verification required</h3><p className="mt-2 text-[15px] leading-6 text-secondary">This site needs you to complete a verification step before Career-Ops can continue. Career-Ops will not solve CAPTCHA, MFA, or email verification for you.</p>{run.blockingReason && <p className="mt-2 text-[13px] leading-5 text-tertiary">{run.blockingReason}</p>}<button type="button" onClick={() => post({ action: "resume", runId: run.id }, "resume")} disabled={busy !== null} className={`${BTN_PRIMARY} mt-4 min-h-11 text-[14px]`}>{busy === "resume" ? "Opening…" : run.status === "ACCOUNT_REQUIRED" ? "Continue setup" : "Continue verification"}</button></div>
            ) : reviewState && review ? (
              <FinalReview run={run} review={review} busy={busy} onSubmit={() => post({ action: "submit", runId: run.id, approvedRunId: run.id }, "submit")} />
            ) : run.status === "SUBMITTING" ? (
              <div className="mt-4"><h3 className="text-[17px] font-bold text-primary">Submitting application</h3><p className="mt-2 text-[15px] leading-6 text-secondary">Career-Ops is sending the application you approved. It is not marked submitted until the employer site confirms acceptance.</p></div>
            ) : run.status === "SUBMITTED" ? (
              <div className="mt-4"><div className="flex items-center gap-2 text-[var(--success)]"><IconCheckCircle size={20} /><h3 className="text-[17px] font-bold">Submitted</h3></div><p className="mt-2 text-[15px] leading-6 text-secondary">The employer site confirmed this application.</p>{run.confirmationText && <p className="mt-2 rounded-[10px] bg-[var(--pill-success-bg)] p-3 text-[14px] leading-6 text-[var(--pill-success-fg)]">“{run.confirmationText}”</p>}</div>
            ) : run.status === "SUBMISSION_UNCONFIRMED" ? (
              <div className="mt-4"><h3 className="text-[17px] font-bold text-[var(--warning)]">Submission unconfirmed</h3><p className="mt-2 text-[15px] leading-6 text-secondary">Career-Ops attempted submission but could not confirm the employer site accepted it.</p>{run.applyUrl && <a href={run.applyUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_PRIMARY} mt-4 min-h-11 text-[14px]`}>Review status<IconArrowUpRight size={14} /></a>}</div>
            ) : run.status === "FAILED" || run.status === "CANCELLED" ? (
              /* UI-0 DEFECT 3 — blockingReason was already fetched by `load()` and sent by the API
               * on every run of every status; it was simply never rendered here. This is what the
               * engine actually wrote at the moment it stopped (see ENTRY_OUTCOME_REASON and every
               * `advanceRun(runId, "FAILED", { blockingReason: ... })` call site in executor.ts) —
               * never a paraphrase, never invented. */
              <div className="mt-4">
                <h3 className="text-[17px] font-bold text-primary">{run.status === "CANCELLED" ? "This application was cancelled" : "This application stopped"}</h3>
                <p className="mt-2 text-[15px] leading-6 text-secondary">
                  {run.blockingReason ?? "Career-Ops stopped this application and did not record a specific reason."}
                </p>
                <p className="mt-3 text-[13px] leading-5 text-tertiary">
                  Nothing further happens automatically from here, and anything you already answered is saved.
                </p>
                {run.applyUrl && (
                  <a href={run.applyUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_SECONDARY} mt-4 min-h-11 text-[14px]`}>
                    View the employer posting<IconArrowUpRight size={14} />
                  </a>
                )}
                <div className="mt-4">
                  <Disclosure title="Technical details">
                    <p className="text-[13px] leading-5 text-secondary">
                      Status: <span className="font-mono">{run.status}</span>
                    </p>
                    <p className="mt-1 text-[13px] leading-5 text-tertiary">
                      See the timeline below for everything Career-Ops did before stopping.
                    </p>
                  </Disclosure>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-[15px] leading-6 text-secondary">{applicationContext(run.status, run.prompt)}</p>
            )}
          </section>

          <section aria-labelledby="application-information-title" className="rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] p-5 shadow-[var(--lift-1)] sm:p-6">
            <h2 id="application-information-title" className="text-[18px] font-bold text-primary">Application information</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <Info label="Resume" value={fileName(run.resumeFile) ?? "No resume attached"} />
              <Info label="Cover letter" value={fileName(run.coverLetterFile) ?? "No cover letter attached"} />
              <Info label="Started" value={formatDate(run.createdAt)} />
              <Info label="Submitted" value={formatDate(run.submittedAt)} />
            </dl>
            <p className="mt-4 flex items-start gap-2 text-[13px] leading-5 text-tertiary"><IconDocument size={16} />Only a resume cleared by the existing quality pipeline can be attached to an application.</p>
          </section>
        </main>

        <aside className="grid gap-5">
          <section id="history" aria-labelledby="application-history-title" className="rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] p-5 shadow-[var(--lift-1)]">
            <h2 id="application-history-title" className="text-[17px] font-bold text-primary">Timeline</h2>
            {events.length === 0 ? <p className="mt-3 text-[14px] leading-6 text-tertiary">No events have been recorded for this run yet.</p> : <Timeline events={events} />}
          </section>
          {run.applyUrl && <a href={run.applyUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_SECONDARY} min-h-11 w-full text-[14px]`}>View employer posting<IconArrowUpRight size={14} /></a>}
        </aside>
      </div>

      {error && <p role="alert" className="text-[14px] text-[var(--error)]">{error}</p>}
    </div>
  );
}

/**
 * UI-A Part 27 — Final Submit must never look or click like an ordinary next-step button (Save
 * Answers & Continue, Continue verification, Continue setup all use BTN_PRIMARY). This reuses the
 * exact same design tokens (`--accent-hover`, `--accent-fg`, the existing lift-shadow scale) at a
 * heavier weight and size, so the deliberate-consequence treatment comes from composition, not a
 * new color.
 *
 * UI-A.1 checkpoint — deliberately NOT gated behind a second confirmation (a `window.confirm` was
 * tried here during implementation and removed on review). The pre-existing FinalReview screen —
 * read the answers/documents/warnings, then click ONE button whose own label already states the
 * consequence in full ("Submit application to {company}") — already IS the one clear, intentional
 * confirmation boundary this action needs. A native dialog on top would ask the same yes/no question
 * a second time in inconsistent, un-themed browser chrome, adding friction without adding real
 * safety; the existing server-side approval gate (approvedRunId, unchanged) is what actually
 * prevents an unapproved submission, not any UI-layer confirmation step.
 */
const SUBMIT_BTN =
  "candidate-control inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-[var(--accent-hover)] px-6 text-[15px] font-bold text-[var(--accent-fg)] shadow-[var(--lift-2)] transition-[transform,filter] duration-150 ease-out hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto";

function FinalReview({ run, review, busy, onSubmit }: { run: RunDetail; review: Review; busy: null | "answer" | "resume" | "submit"; onSubmit: () => void }) {
  const company = run.company ?? "this employer";
  return (
    <div className="mt-4">
      <h3 className="text-[18px] font-bold text-primary">Final review</h3>
      <p className="mt-2 text-[15px] font-semibold leading-6 text-primary">Nothing will be submitted until you approve this application.</p>
      <p className="mt-1 text-[14px] leading-6 text-secondary">Review the documents, employer, role, destination, and application answers below.</p>
      {/* UI-A.1 checkpoint fix — real counts from the review the server already computed, never an
       *  invented aggregate; zero is shown honestly, never hidden. The copy itself was rewritten
       *  during checkpoint review: `answers` here (buildFinalReview, finalReview.ts) is sourced per
       *  entry from AnswerSource, which includes USER_INTERVENTION and APPLICATION_ANSWER_VAULT —
       *  values the candidate themselves supplied — alongside profile/resume-derived ones. Calling
       *  the whole count "completed automatically" would be false for any answer that came from the
       *  candidate. This states only the neutral, always-true fact: what is recorded for review. */}
      <p className="mt-3 text-[13px] leading-5 text-tertiary">
        This review includes {review.answers.length} recorded answer{review.answers.length === 1 ? "" : "s"}
        {review.documents.length > 0 ? ` and ${review.documents.length} attached document${review.documents.length === 1 ? "" : "s"}` : ""}.
      </p>
      <div className="mt-4 grid gap-3 rounded-[12px] bg-[var(--z0-bg)] p-4 sm:grid-cols-2"><Info label="Employer" value={run.company ?? "Company unknown"} /><Info label="Role" value={run.title} /><Info label="Resume" value={fileName(run.resumeFile) ?? "None attached"} /><Info label="Cover letter" value={fileName(run.coverLetterFile) ?? "None attached"} /></div>
      {review.answers.length > 0 && <div className="mt-4"><h4 className="text-[14px] font-bold text-primary">Application answers</h4><ul className="mt-2 grid gap-2">{review.answers.map((item) => <li key={item.question} className="rounded-[10px] border border-[var(--border)] p-3 text-[14px] leading-6"><span className="font-medium text-secondary">{item.question}</span><p className="text-primary">{item.value}</p><span className="text-[12px] text-tertiary">Source: {item.source.replace(/_/g, " ").toLowerCase()}</span></li>)}</ul></div>}
      {review.warnings.length > 0 && <ul className="mt-4 grid gap-2 text-[14px] leading-6 text-[var(--warning)]">{review.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      {review.unresolved.length > 0 && <div className="mt-4 rounded-[11px] bg-[var(--pill-red-bg)] p-4"><h4 className="text-[14px] font-bold text-[var(--pill-red-fg)]">Still unanswered</h4><ul className="mt-2 grid gap-1 text-[13px] leading-5 text-secondary">{review.unresolved.map((item) => <li key={item.question}>{item.question} — {item.reason}</li>)}</ul></div>}
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy !== null || !review.canApprove}
        className={`${SUBMIT_BTN} mt-5`}
      >
        {busy === "submit" ? "Submitting…" : `Submit application to ${company}`}
      </button>
      {!review.canApprove && <p className="mt-2 text-[13px] leading-5 text-tertiary">Answer everything still unresolved before this application can be submitted.</p>}
    </div>
  );
}

const CONTROL_CLASS =
  "mt-2 min-h-11 w-full rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]";

/**
 * PHASE 9D — one control per DiscoveredField kind, matching what the ATS actually asked for
 * (Career-Ops Phase 9 spec's "runtime form is authoritative for UI shape"): a radio question on the
 * employer's site renders as a radio group here, not a dropdown; a checkbox stays a checkbox; a
 * date/month field gets a date-compatible input; a textarea stays a textarea. Nothing here invents
 * metadata the DOM didn't provide — `q.options`/`q.kind` are exactly what fieldDiscovery captured.
 */
function QuestionControl({
  question: q,
  value,
  onChange,
}: {
  question: HumanQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  if (q.kind === "radio" && q.options && q.options.length > 0) {
    return (
      <fieldset className="mt-2 border-0 p-0">
        <legend className="sr-only">{q.label}</legend>
        <div className="grid gap-2">
          {q.options.map((opt) => (
            <label key={opt} className="flex min-h-9 items-center gap-2 text-[14px] text-primary">
              <input
                type="radio"
                name={`batch-${q.id}`}
                value={opt}
                checked={value === opt}
                onChange={() => onChange(opt)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              {opt}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  if (q.kind === "checkbox" && (!q.options || q.options.length === 0)) {
    return (
      <label className="mt-2 flex min-h-9 items-center gap-2 text-[14px] text-primary">
        <input
          type="checkbox"
          id={`batch-${q.id}`}
          checked={value === "Yes"}
          onChange={(e) => onChange(e.target.checked ? "Yes" : "No")}
          className="h-5 w-5 accent-[var(--accent)]"
        />
        Yes
      </label>
    );
  }
  if (q.kind === "date" || q.kind === "month") {
    return (
      <input id={`batch-${q.id}`} type={q.kind} value={value} onChange={(e) => onChange(e.target.value)} className={CONTROL_CLASS} />
    );
  }
  if (q.kind === "textarea") {
    return (
      <textarea
        id={`batch-${q.id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        placeholder="Your answer"
        className={CONTROL_CLASS}
      />
    );
  }
  if (q.options && q.options.length > 0) {
    return (
      <select id={`batch-${q.id}`} value={value} onChange={(e) => onChange(e.target.value)} className={CONTROL_CLASS}>
        <option value="">Choose an option…</option>
        {q.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }
  return (
    <input id={`batch-${q.id}`} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder="Your answer" className={CONTROL_CLASS} />
  );
}

/**
 * UI-AM checkpoint finding — whether the "remember" checkbox has ANY real effect for this question.
 *
 * THE BUG THIS FIXES. The checkbox used to hide only for `voluntary_demographic`, but the answer is
 * saved to the vault regardless of whether it is checked at all (see the API route's own
 * `saveAnswer(...)` call, made unconditionally whenever a canonicalKey exists) — the checkbox only
 * ever controls `autoFillAllowed`, and `saveAnswer`'s own policy guard silently drops that flag to
 * false for any type whose `DEFAULT_POLICY.reusePolicy` is not `auto_after_approval` (questionTypes.ts).
 * For salary, experience, availability, open-ended and security-clearance questions, checking this
 * box already did nothing — the answer would be remembered and re-offered as a suggestion either
 * way, and no future run could ever fill it in unattended regardless of the checkbox. Showing a
 * control with no effect is exactly the fake-functionality this phase exists to remove.
 */
function canOfferAutomaticReuse(questionType: string | null): boolean {
  if (!questionType) return false;
  return DEFAULT_POLICY[questionType as QuestionType]?.reusePolicy === "auto_after_approval";
}

/** One question card — a real field the employer's form asked for, in whatever control shape it
 *  actually is (see QuestionControl). Used for both the Required and Optional groups below; a
 *  question never disappears or collapses regardless of which group it is in or what the candidate
 *  has typed into it — the group only changes where it sorts, not whether it stays visible. */
function QuestionField({
  q,
  value,
  reuse,
  onAnswerChange,
  onReuseChange,
}: {
  q: HumanQuestion;
  value: string;
  reuse: boolean;
  onAnswerChange: (id: string, value: string) => void;
  onReuseChange: (id: string, value: boolean) => void;
}) {
  return (
    <div className="rounded-[12px] border border-[var(--border)] bg-[var(--z0-bg)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <label htmlFor={`batch-${q.id}`} className="block text-[14px] font-semibold text-primary">
          {q.label}
          {q.required && <span className="ml-1 text-[var(--error)]" aria-label="required">*</span>}
        </label>
        {/* UI-A Part 11 — voluntary/sensitive questions get distinct framing, never implied required. */}
        {q.questionType === "voluntary_demographic" && (
          <span className="shrink-0 rounded-full bg-[var(--attention-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--attention-fg)]">Voluntary</span>
        )}
      </div>
      {q.reason && <p className="mt-1 text-[12px] leading-5 text-tertiary">{q.reason}</p>}
      <QuestionControl question={q} value={value} onChange={(next) => onAnswerChange(q.id, next)} />
      {/* This answer is remembered either way (see canOfferAutomaticReuse's doc comment) — the
       *  checkbox only ever controls whether it may ALSO be used without asking again, which is
       *  real only for question types whose policy permits it. */}
      {canOfferAutomaticReuse(q.questionType) && (
        <label className="mt-2 flex min-h-9 items-center gap-2 text-[13px] text-secondary">
          <input type="checkbox" checked={reuse} onChange={(e) => onReuseChange(q.id, e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
          Use this answer automatically for similar questions in the future
        </label>
      )}
    </div>
  );
}

function BatchQuestionForm({
  humanQuestions,
  batchAnswers,
  batchReuse,
  busy,
  onAnswerChange,
  onReuseChange,
  onSave,
}: {
  humanQuestions: HumanQuestion[];
  batchAnswers: Record<string, string>;
  batchReuse: Record<string, boolean>;
  busy: null | "answer" | "resume" | "submit";
  onAnswerChange: (id: string, value: string) => void;
  onReuseChange: (id: string, value: boolean) => void;
  onSave: () => void;
}) {
  /* UI-0 DEFECT 4 — gates on REQUIRED questions only. An unanswered optional question (Address
   * Line 2, County, Phone Extension on the real Workday run this fixes) must never block saving. */
  const canSave = requiredQuestionsSatisfied(humanQuestions, batchAnswers);
  /* UI-A — grouped by the one real, authoritative field the payload carries (`required`), not by a
   * page/section the payload does not expose (HumanQuestion has no such field — inventing one here
   * would be exactly the fabrication Career-Ops exists to refuse). Every question stays visible and
   * editable regardless of group; nothing here ever collapses or hides a question. */
  const requiredQuestions = humanQuestions.filter((q) => q.required);
  const optionalQuestions = humanQuestions.filter((q) => !q.required);
  return (
    <div className="mt-4">
      <h3 className="text-[17px] font-bold text-primary">Questions from the employer</h3>
      <p className="mt-1 text-[14px] leading-6 text-secondary">Career-Ops completed everything it could on its own. Answer the required questions below — anything marked optional can be left blank — and Career-Ops will continue filling your application automatically.</p>
      {requiredQuestions.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-tertiary">Required</h4>
          <div className="mt-2 grid gap-5">
            {requiredQuestions.map((q) => (
              <QuestionField key={q.id} q={q} value={batchAnswers[q.id] ?? ""} reuse={batchReuse[q.id] ?? false} onAnswerChange={onAnswerChange} onReuseChange={onReuseChange} />
            ))}
          </div>
        </div>
      )}
      {optionalQuestions.length > 0 && (
        <div className="mt-5">
          <h4 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-tertiary">Optional</h4>
          <p className="mt-1 text-[12.5px] leading-5 text-tertiary">These are not required by the employer. Leave any of them blank if you prefer.</p>
          <div className="mt-2 grid gap-5">
            {optionalQuestions.map((q) => (
              <QuestionField key={q.id} q={q} value={batchAnswers[q.id] ?? ""} reuse={batchReuse[q.id] ?? false} onAnswerChange={onAnswerChange} onReuseChange={onReuseChange} />
            ))}
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={onSave}
        disabled={busy !== null || !canSave}
        className={`${BTN_PRIMARY} mt-5 min-h-11 text-[14px] lg:w-auto`}
      >
        {busy === "answer" ? "Saving…" : "Save Answers & Continue"}
      </button>
      <p className="mt-2 text-[13px] leading-5 text-tertiary">Saving answers does not submit the application. Career-Ops will continue filling the form and stop again if it needs more from you.</p>
      {/* UI-A Part 32 — the sticky mobile duplicate of the SAME Save button above (same onSave,
       *  same disabled gate) so a long question batch never leaves the primary action scrolled out
       *  of reach. Fixed above MobileBottomNav using the exact convention established and pointer-
       *  event-verified in UI-5.1 (56px nav height + safe-area-inset-bottom). Extra bottom padding
       *  on the form reserves room so this bar never covers the last question or its own inline
       *  button. */}
      <div className="h-[84px] lg:hidden" aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 border-t border-[var(--border)] bg-[var(--z3-bg)] p-3 shadow-[var(--shadow-hero)] lg:hidden">
        <button type="button" onClick={onSave} disabled={busy !== null || !canSave} className={`${BTN_PRIMARY} block w-full min-h-11 text-center text-[14px]`}>
          {busy === "answer" ? "Saving…" : "Save Answers & Continue"}
        </button>
      </div>
    </div>
  );
}

/**
 * UI-A Part 20 — a narrated timeline, not 100 equally-weighted rows. Every real event still exists
 * (grouping.ts never deletes anything and this component never drops an event either) — a
 * repetitive run of the SAME low-value type collapses to one summary row with a real count and a
 * "Show all" toggle that reveals the exact same rows the ungrouped list would have shown. Milestone
 * events (status changes, questions, errors, submit) are never grouped and always show individually.
 */
function Timeline({ events }: { events: RunEvent[] }) {
  const items = groupTimelineEvents(events);
  return (
    <ol className="mt-4 grid gap-4">
      {items.map((item, index) =>
        item.kind === "single" ? (
          <TimelineRow key={item.event.id} event={item.event} />
        ) : (
          <TimelineGroup key={`group-${index}-${item.events[0]!.id}`} eventType={item.eventType} events={item.events} />
        )
      )}
    </ol>
  );
}

function TimelineRow({ event }: { event: RunEvent }) {
  return (
    <li className="relative border-l-2 border-[var(--separator)] pl-4">
      <span aria-hidden="true" className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-[var(--accent)]" />
      <p className="text-[14px] font-semibold text-primary">{eventLabel(event.event_type, event.detail)}</p>
      <p className="mt-1 text-[13px] text-tertiary">{formatDate(event.created_at)}</p>
      {event.detail && <p className="mt-1 text-[13px] leading-5 text-secondary">{event.detail}</p>}
    </li>
  );
}

function TimelineGroup({ eventType, events }: { eventType: string; events: RunEvent[] }) {
  const [expanded, setExpanded] = useState(false);
  const first = events[0]!;
  const last = events[events.length - 1]!;
  return (
    <li className="relative border-l-2 border-[var(--separator)] pl-4">
      <span aria-hidden="true" className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-[var(--separator)]" />
      <p className="text-[14px] font-semibold text-primary">{groupSummaryLabel(eventType, events.length)}</p>
      <p className="mt-1 text-[13px] text-tertiary">{formatDate(first.created_at)} – {formatDate(last.created_at)}</p>
      <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1.5 min-h-9 text-[13px] font-semibold text-[var(--accent)] hover:underline">
        {expanded ? "Hide details" : `Show all ${events.length}`}
      </button>
      {expanded && (
        <ol className="mt-3 grid gap-3 border-t border-[var(--separator)] pt-3">
          {events.map((event) => (
            <li key={event.id}>
              <p className="text-[13px] font-medium text-secondary">{eventLabel(event.event_type, event.detail)}</p>
              <p className="mt-0.5 text-[12px] text-tertiary">{formatDate(event.created_at)}</p>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[12px] font-semibold uppercase tracking-[0.07em] text-tertiary">{label}</dt><dd className="mt-1 break-words text-[14px] leading-6 text-primary">{value}</dd></div>;
}
