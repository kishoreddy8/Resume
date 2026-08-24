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
import { presentStatus, STATUS_PRESENTATION } from "../runStatus";
import { applicationContext, detailPhase, primaryActionLabel, type DetailPhase } from "../grouping";
import type { RunStatus } from "@/lib/apply/runState";

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

function eventLabel(eventType: string): string {
  return STATUS_PRESENTATION[eventType as RunStatus]?.label ?? "Application updated";
}

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
  const [reuse, setReuse] = useState(false);
  const [humanQuestions, setHumanQuestions] = useState<HumanQuestion[] | null>(null);
  const [batchAnswers, setBatchAnswers] = useState<Record<string, string>>({});
  const [batchReuse, setBatchReuse] = useState<Record<string, boolean>>({});
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
                run={run}
                humanQuestions={humanQuestions}
                batchAnswers={batchAnswers}
                batchReuse={batchReuse}
                busy={busy}
                onAnswerChange={(id, value) => setBatchAnswers((prev) => ({ ...prev, [id]: value }))}
                onReuseChange={(id, value) => setBatchReuse((prev) => ({ ...prev, [id]: value }))}
                onSave={async () => {
                  if (candidateId === null) return;
                  const answers = humanQuestions.map((q) => ({
                    id: q.id,
                    answer: batchAnswers[q.id] ?? "",
                    reuseForEquivalentQuestions: batchReuse[q.id] ?? false,
                  }));
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
                      const b = await resumeRes.json().catch(() => ({}));
                      setError((b as { error?: string }).error ?? "Could not resume application.");
                      return;
                    }
                    await load();
                  } catch {
                    setError("Could not save answers and resume.");
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            ) : run.status === "WAITING_FOR_ANSWER" && run.question ? (
              <div className="mt-4">
                <p className="text-[15px] font-semibold leading-6 text-primary">{run.question}</p>
                <label className="mt-3 block"><span className="text-[14px] font-medium text-secondary">Your answer</span><input ref={answerRef} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Enter your answer" className="mt-2 min-h-11 w-full rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]" /></label>
                <label className="mt-3 flex min-h-11 items-center gap-3 text-[14px] text-secondary"><input type="checkbox" checked={reuse} onChange={(event) => setReuse(event.target.checked)} className="h-5 w-5 accent-[var(--accent)]" />Reuse this answer for equivalent questions</label>
                <button type="button" onClick={() => post({ runId: run.id, answer, reuseForEquivalentQuestions: reuse }, "answer")} disabled={busy !== null || answer.trim().length === 0} className={`${BTN_PRIMARY} mt-3 min-h-11 text-[14px]`}>{busy === "answer" ? "Saving…" : "Save answer and continue"}</button>
                <p className="mt-3 text-[13px] leading-5 text-tertiary">JobHunt never answers a question it cannot evidence. Your answer is used exactly as provided.</p>
              </div>
            ) : verificationState ? (
              <div className="mt-4"><h3 className="text-[17px] font-bold text-primary">Verification required</h3><p className="mt-2 text-[15px] leading-6 text-secondary">This site needs you to complete a verification step before JobHunt can continue. JobHunt will not solve CAPTCHA, MFA, or email verification for you.</p>{run.blockingReason && <p className="mt-2 text-[13px] leading-5 text-tertiary">{run.blockingReason}</p>}<button type="button" onClick={() => post({ action: "resume", runId: run.id }, "resume")} disabled={busy !== null} className={`${BTN_PRIMARY} mt-4 min-h-11 text-[14px]`}>{busy === "resume" ? "Opening…" : run.status === "ACCOUNT_REQUIRED" ? "Continue setup" : "Continue verification"}</button></div>
            ) : reviewState && review ? (
              <FinalReview run={run} review={review} busy={busy} onSubmit={() => post({ action: "submit", runId: run.id, approvedRunId: run.id }, "submit")} />
            ) : run.status === "SUBMITTING" ? (
              <div className="mt-4"><h3 className="text-[17px] font-bold text-primary">Submitting application</h3><p className="mt-2 text-[15px] leading-6 text-secondary">JobHunt is sending the application you approved. It is not marked submitted until the employer site confirms acceptance.</p></div>
            ) : run.status === "SUBMITTED" ? (
              <div className="mt-4"><div className="flex items-center gap-2 text-[var(--success)]"><IconCheckCircle size={20} /><h3 className="text-[17px] font-bold">Submitted</h3></div><p className="mt-2 text-[15px] leading-6 text-secondary">The employer site confirmed this application.</p>{run.confirmationText && <p className="mt-2 rounded-[10px] bg-[var(--pill-success-bg)] p-3 text-[14px] leading-6 text-[var(--pill-success-fg)]">“{run.confirmationText}”</p>}</div>
            ) : run.status === "SUBMISSION_UNCONFIRMED" ? (
              <div className="mt-4"><h3 className="text-[17px] font-bold text-[var(--warning)]">Submission unconfirmed</h3><p className="mt-2 text-[15px] leading-6 text-secondary">JobHunt attempted submission but could not confirm the employer site accepted it.</p>{run.applyUrl && <a href={run.applyUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_PRIMARY} mt-4 min-h-11 text-[14px]`}>Review status<IconArrowUpRight size={14} /></a>}</div>
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
            {events.length === 0 ? <p className="mt-3 text-[14px] leading-6 text-tertiary">No events have been recorded for this run yet.</p> : <ol className="mt-4 grid gap-4">{events.map((event) => <li key={event.id} className="relative border-l-2 border-[var(--separator)] pl-4"><span aria-hidden="true" className="absolute -left-[5px] top-1.5 h-2 w-2 rounded-full bg-[var(--accent)]" /><p className="text-[14px] font-semibold text-primary">{eventLabel(event.event_type)}</p><p className="mt-1 text-[13px] text-tertiary">{formatDate(event.created_at)}</p>{event.detail && <p className="mt-1 text-[13px] leading-5 text-secondary">{event.detail}</p>}</li>)}</ol>}
          </section>
          {run.applyUrl && <a href={run.applyUrl} target="_blank" rel="noopener noreferrer" className={`${BTN_SECONDARY} min-h-11 w-full text-[14px]`}>View employer posting<IconArrowUpRight size={14} /></a>}
        </aside>
      </div>

      {error && <p role="alert" className="text-[14px] text-[var(--error)]">{error}</p>}
    </div>
  );
}

function FinalReview({ run, review, busy, onSubmit }: { run: RunDetail; review: Review; busy: null | "answer" | "resume" | "submit"; onSubmit: () => void }) {
  return (
    <div className="mt-4">
      <h3 className="text-[18px] font-bold text-primary">Final review</h3>
      <p className="mt-2 text-[15px] font-semibold leading-6 text-primary">Nothing will be submitted until you approve this application.</p>
      <p className="mt-1 text-[14px] leading-6 text-secondary">Review the documents, employer, role, destination, and application answers below.</p>
      <div className="mt-4 grid gap-3 rounded-[12px] bg-[var(--z0-bg)] p-4 sm:grid-cols-2"><Info label="Employer" value={run.company ?? "Company unknown"} /><Info label="Role" value={run.title} /><Info label="Resume" value={fileName(run.resumeFile) ?? "None attached"} /><Info label="Cover letter" value={fileName(run.coverLetterFile) ?? "None attached"} /></div>
      {review.answers.length > 0 && <div className="mt-4"><h4 className="text-[14px] font-bold text-primary">Application answers</h4><ul className="mt-2 grid gap-2">{review.answers.map((item) => <li key={item.question} className="rounded-[10px] border border-[var(--border)] p-3 text-[14px] leading-6"><span className="font-medium text-secondary">{item.question}</span><p className="text-primary">{item.value}</p><span className="text-[12px] text-tertiary">Source: {item.source.replace(/_/g, " ").toLowerCase()}</span></li>)}</ul></div>}
      {review.warnings.length > 0 && <ul className="mt-4 grid gap-2 text-[14px] leading-6 text-[var(--warning)]">{review.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      {review.unresolved.length > 0 && <div className="mt-4 rounded-[11px] bg-[var(--pill-red-bg)] p-4"><h4 className="text-[14px] font-bold text-[var(--pill-red-fg)]">Still unanswered</h4><ul className="mt-2 grid gap-1 text-[13px] leading-5 text-secondary">{review.unresolved.map((item) => <li key={item.question}>{item.question} — {item.reason}</li>)}</ul></div>}
      <button type="button" onClick={onSubmit} disabled={busy !== null || !review.canApprove} className={`${BTN_PRIMARY} mt-5 min-h-11 text-[14px]`}>{busy === "submit" ? "Submitting…" : "Approve & Submit"}</button>
      {!review.canApprove && <p className="mt-2 text-[13px] leading-5 text-tertiary">Answer everything still unresolved before this application can be submitted.</p>}
    </div>
  );
}

function BatchQuestionForm({
  run: _run,
  humanQuestions,
  batchAnswers,
  batchReuse,
  busy,
  onAnswerChange,
  onReuseChange,
  onSave,
}: {
  run: RunDetail;
  humanQuestions: HumanQuestion[];
  batchAnswers: Record<string, string>;
  batchReuse: Record<string, boolean>;
  busy: null | "answer" | "resume" | "submit";
  onAnswerChange: (id: string, value: string) => void;
  onReuseChange: (id: string, value: boolean) => void;
  onSave: () => void;
}) {
  const allAnswered = humanQuestions.every((q) => (batchAnswers[q.id]?.trim() ?? "").length > 0);
  return (
    <div className="mt-4">
      <h3 className="text-[17px] font-bold text-primary">Questions from the employer</h3>
      <p className="mt-1 text-[14px] leading-6 text-secondary">Answer all questions below, then JobHunt will continue filling your application automatically.</p>
      <div className="mt-4 grid gap-5">
        {humanQuestions.map((q) => (
          <div key={q.id} className="rounded-[12px] border border-[var(--border)] bg-[var(--z0-bg)] p-4">
            <label htmlFor={`batch-${q.id}`} className="block text-[14px] font-semibold text-primary">{q.label}{q.required && <span className="ml-1 text-[var(--error)]" aria-label="required">*</span>}</label>
            {q.reason && <p className="mt-1 text-[12px] leading-5 text-tertiary">{q.reason}</p>}
            {q.options && q.options.length > 0 ? (
              <select
                id={`batch-${q.id}`}
                value={batchAnswers[q.id] ?? ""}
                onChange={(e) => onAnswerChange(q.id, e.target.value)}
                className="mt-2 min-h-11 w-full rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <option value="">Choose an option…</option>
                {q.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            ) : (
              <input
                id={`batch-${q.id}`}
                type="text"
                value={batchAnswers[q.id] ?? ""}
                onChange={(e) => onAnswerChange(q.id, e.target.value)}
                placeholder="Your answer"
                className="mt-2 min-h-11 w-full rounded-[10px] border border-[var(--border-control)] bg-[var(--z3-bg)] px-3 text-[16px] text-primary outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              />
            )}
            {q.questionType !== "voluntary_demographic" && (
              <label className="mt-2 flex min-h-9 items-center gap-2 text-[13px] text-secondary">
                <input
                  type="checkbox"
                  checked={batchReuse[q.id] ?? false}
                  onChange={(e) => onReuseChange(q.id, e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                Remember this answer for equivalent questions
              </label>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={busy !== null || !allAnswered}
        className={`${BTN_PRIMARY} mt-5 min-h-11 text-[14px]`}
      >
        {busy === "answer" ? "Saving…" : "Save Answers & Continue"}
      </button>
      <p className="mt-2 text-[13px] leading-5 text-tertiary">Saving answers does not submit the application. JobHunt will continue filling the form and stop again if it needs more from you.</p>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[12px] font-semibold uppercase tracking-[0.07em] text-tertiary">{label}</dt><dd className="mt-1 break-words text-[14px] leading-6 text-primary">{value}</dd></div>;
}
