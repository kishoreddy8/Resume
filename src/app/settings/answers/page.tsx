"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_PRIMARY,
  BTN_QUIET,
  BTN_SECONDARY,
  EmptyState,
  ErrorState,
  INPUT,
  LoadingRegion,
  PageHeader,
  Pill,
  SkeletonRows,
} from "@/components/ui";
import { IconDocument } from "@/components/icons";
import type { QuestionType, ReusePolicy } from "@/lib/apply/questionTypes";
import { presentReusePolicy } from "./reusePolicyPresentation";

/**
 * Answer Memory — the one candidate-facing view of the Application Answer Vault.
 *
 * NOT a settings dump, not a database inspector. Every row is a question the candidate has already
 * answered during a real application, in their own words, presented in plain language. Reuse policy
 * is truthful to the real three-value model in questionTypes.ts — there is no per-answer "use for
 * this company only" or "this job only" scope anywhere in the engine, so none is offered here.
 */

interface AnswerRow {
  id: number;
  question: string;
  answer: string;
  questionType: QuestionType;
  reusePolicy: ReusePolicy;
  sensitivity: string;
  approved: boolean;
  autoFillAllowed: boolean;
  updatedAt: string;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function AnswerMemoryPage() {
  const candidateId = useResolvedCandidateId();
  const [answers, setAnswers] = useState<AnswerRow[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/answer-memory`);
      if (!res.ok) return setError(true);
      const body = await res.json();
      setAnswers(body.answers ?? []);
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function saveEdit(id: number, changes: { answerValue?: string; autoFillAllowed?: boolean }): Promise<boolean> {
    if (candidateId === null) return false;
    try {
      const res = await fetch(`/api/candidates/${candidateId}/answer-memory`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...changes }),
      });
      if (!res.ok) return false;
      await load();
      return true;
    } catch {
      return false;
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 pb-12">
      <div>
        <Link href="/settings?category=applications" className="inline-flex min-h-11 w-fit items-center text-[14px] font-semibold text-secondary transition-colors hover:text-primary">‹ Back to Settings</Link>
      </div>
      <PageHeader
        size="lg"
        title="Answer Memory"
        description="Career-Ops can reuse answers you choose to remember so you don't have to enter the same information repeatedly. Nothing here is used without your say."
      />

      {error ? (
        <ErrorState
          title="Couldn't load saved answers"
          whatHappened="Something went wrong loading Answer Memory."
          onRetry={load}
        />
      ) : candidateId === null || answers === null ? (
        <div className="rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)] p-5">
          <LoadingRegion label="Loading saved answers" />
          <SkeletonRows rows={4} />
        </div>
      ) : answers.length === 0 ? (
        <div className="rounded-[16px] border border-[var(--border)] bg-[var(--z3-bg)]">
          <EmptyState
            icon={<IconDocument size={20} />}
            title="Nothing remembered yet"
            description="When you answer a question during an application, it can appear here for future reuse."
          />
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {answers.map((a) => (
            <AnswerCard key={a.id} answer={a} onSave={saveEdit} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AnswerCard({
  answer,
  onSave,
}: {
  answer: AnswerRow;
  onSave: (id: number, changes: { answerValue?: string; autoFillAllowed?: boolean }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(answer.answer);
  const [draftAuto, setDraftAuto] = useState(answer.autoFillAllowed);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const presentation = presentReusePolicy(answer.reusePolicy, answer.autoFillAllowed);

  function startEdit() {
    setDraftValue(answer.answer);
    setDraftAuto(answer.autoFillAllowed);
    setSaveError(null);
    setEditing(true);
  }

  async function handleSave() {
    if (draftValue.trim().length === 0) {
      setSaveError("This can't be blank.");
      return;
    }
    setBusy(true);
    setSaveError(null);
    const changes: { answerValue?: string; autoFillAllowed?: boolean } = {};
    if (draftValue.trim() !== answer.answer) changes.answerValue = draftValue.trim();
    if (presentation.editable && draftAuto !== answer.autoFillAllowed) changes.autoFillAllowed = draftAuto;
    const ok = Object.keys(changes).length === 0 ? true : await onSave(answer.id, changes);
    setBusy(false);
    if (ok) {
      setEditing(false);
    } else {
      setSaveError("Couldn't save changes. Please try again.");
    }
  }

  return (
    <li className="rounded-[14px] border border-[var(--border)] bg-[var(--z3-bg)] p-4 shadow-[var(--lift-1)] sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-[15px] font-semibold leading-6 text-primary">{answer.question}</p>
        <Pill tone={presentation.editable && answer.autoFillAllowed ? "info" : "neutral"}>{presentation.label}</Pill>
      </div>

      {editing ? (
        <div className="mt-3 flex flex-col gap-3">
          <label className="block">
            <span className="sr-only">Answer</span>
            <input
              value={draftValue}
              onChange={(e) => setDraftValue(e.target.value)}
              className={`${INPUT} text-[14px]`}
              maxLength={5000}
            />
          </label>
          {presentation.editable && (
            <label className="flex min-h-11 items-center gap-3 text-[13.5px] text-secondary">
              <input
                type="checkbox"
                checked={draftAuto}
                onChange={(e) => setDraftAuto(e.target.checked)}
                className="h-5 w-5 accent-[var(--accent)]"
              />
              Use this answer automatically next time
            </label>
          )}
          {saveError && <p role="alert" className="text-[13px] text-[var(--error)]">{saveError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={handleSave} disabled={busy} className={`${BTN_PRIMARY} min-h-11 text-[13.5px]`}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy} className={`${BTN_SECONDARY} min-h-11 text-[13.5px]`}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-2 text-[14px] leading-6 text-secondary">{answer.answer}</p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-tertiary">{presentation.explanation}</p>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-tertiary">Last updated {formatDate(answer.updatedAt)}</p>
            <button type="button" onClick={startEdit} className={`${BTN_QUIET} min-h-11`}>
              Edit
            </button>
          </div>
        </>
      )}
    </li>
  );
}
