"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { Surface, StatusDot, type StatusTone } from "@/components/ui";

/**
 * First-run setup: Master Resume, Master Skills Inventory, target-role preferences, then evaluation.
 *
 * WHY THIS PAGE EXISTS. A tester uploaded both documents, saw them listed as uploaded, and then got
 * zero matches forever with nothing explaining why. Uploading does not build the derived profile
 * the matching engine reads, and no screen said so. Every step is now stated, including the one the
 * app cannot perform itself.
 *
 * THE STEP THE APP CANNOT DO. Building candidate-profile.json means deciding which employer each
 * skill belongs to, what the experience entries are, and what years the resume actually STATES.
 * That is reading comprehension, not text extraction — the app has no .docx reader by design, and a
 * naive XML dump would produce a confident, wrong profile. Since employer-attributed evidence is
 * what gates READY_FOR_TAILORING, a wrong profile would have the system recommend applying on
 * experience the person does not have. So this hands over the exact command instead of faking it.
 *
 * Everything after that step is automatic: once a profile exists, evaluation runs here without
 * being asked, and the page moves on when it finishes.
 */

interface Setup {
  candidateId: number;
  steps: { resume: boolean; skills: boolean; preferences: boolean; profile: boolean; evaluated: boolean };
  blockedOn: string | null;
  complete: boolean;
  profileStatus: "ok" | "missing" | "stale" | "invalid";
  profileCommand: string;
  canEvaluate: boolean;
  counts: { evaluated: number; readyForTailoring: number; needsReview: number; blocked: number };
  preferences: { primaryTargetRole: string | null; secondaryTargetRoles: string[] };
}

const STEP_LABEL: Record<string, string> = {
  resume: "Master Resume",
  skills: "Master Skills Inventory",
  preferences: "Target role",
  profile: "Candidate profile",
  evaluation: "Evaluation",
};

export default function OnboardingPage() {
  const candidateId = useActiveCandidateId();
  const router = useRouter();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [progress, setProgress] = useState<{ done: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/candidates/${candidateId}/setup`);
    if (!res.ok) return null;
    const body = (await res.json()) as Setup;
    setSetup(body);
    if (body.preferences.primaryTargetRole) setRole(body.preferences.primaryTargetRole);
    return body;
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  async function savePreferences() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preferences: { primaryTargetRole: role.trim() } }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Walk the bounded rematch cursor to completion. The endpoint deliberately does one page per
   * request so a full pass cannot block the server for minutes; the client owns the loop.
   */
  const runEvaluation = useCallback(async () => {
    setEvaluating(true);
    setError(null);
    let afterJobId: number | undefined;
    let done = 0;
    try {
      for (let guard = 0; guard < 500; guard++) {
        const res = await fetch(`/api/candidates/${candidateId}/rematch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(afterJobId ? { afterJobId } : {}),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Evaluation failed.");
        const page = await res.json();
        // RematchCandidatePageResult's own field names — pairsAttempted is the count of
        // candidate/job pairs this page actually worked through.
        done += Number(page.pairsAttempted ?? 0);
        setProgress({ done });
        if (!page.hasMore || page.nextCursor == null) break;
        afterJobId = page.nextCursor;
      }
      const latest = await refresh();
      if (latest?.complete) router.push("/jobs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evaluation failed.");
    } finally {
      setEvaluating(false);
    }
  }, [candidateId, refresh, router]);

  // The moment everything it needs is in place, evaluate without being asked.
  useEffect(() => {
    if (setup?.canEvaluate && !setup.steps.evaluated && !evaluating) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runEvaluation();
    }
  }, [setup, evaluating, runEvaluation]);

  const stepTone = (ok: boolean, isBlocker: boolean): StatusTone =>
    ok ? "ready" : isBlocker ? "active" : "neutral";

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 py-6">
      <header>
        <h1 className="page-title">Set up this profile</h1>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-tertiary">
          Four things are needed before jobs can be matched. Everything except the profile build
          happens here.
        </p>
      </header>

      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <ol className="space-y-2.5">
          {(["resume", "skills", "preferences", "profile", "evaluation"] as const).map((k) => {
            const ok =
              k === "evaluation" ? Boolean(setup?.steps.evaluated) : Boolean(setup?.steps[k as keyof Setup["steps"]]);
            const isBlocker = setup?.blockedOn === k;
            return (
              <li key={k} className="flex items-baseline gap-2.5">
                <StatusDot tone={stepTone(ok, isBlocker)} className="translate-y-[-1px]" />
                <span className={`text-[13px] ${ok ? "text-secondary" : isBlocker ? "font-semibold text-primary" : "text-tertiary"}`}>
                  {STEP_LABEL[k]}
                </span>
                {ok && <span className="text-[11px] text-[var(--success)]">done</span>}
                {isBlocker && <span className="text-[11px] text-[var(--accent)]">next</span>}
              </li>
            );
          })}
        </ol>
      </Surface>

      {/* 1 & 2 — the documents */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Documents</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-tertiary">
          Upload the Master Resume and Master Skills Inventory. These are the source of truth —
          nothing is ever invented from outside them.
        </p>
        <Link
          href="/master-files"
          className="mt-3 inline-block rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
        >
          {setup?.steps.resume && setup?.steps.skills ? "Both uploaded — review" : "Upload documents"}
        </Link>
      </Surface>

      {/* 3 — preferences */}
      <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Target role</h2>
        <p className="mt-1.5 text-[12px] leading-relaxed text-tertiary">
          Used for ranking only — it never changes a match score or invents evidence.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="e.g. Data Engineer"
            aria-label="Primary target role"
            className="min-w-[16rem] flex-1 rounded-md border border-[var(--border)] bg-surface px-2.5 py-1.5 text-[13px] text-primary outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          />
          <button
            type="button"
            onClick={savePreferences}
            disabled={saving || !role.trim()}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </Surface>

      {/* 4 — the one manual step, with the exact command */}
      {setup && setup.steps.resume && setup.steps.skills && setup.profileStatus !== "ok" && (
        <Surface level="z3" className="tint-alert rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
            Build the candidate profile
          </h2>
          <p className="mt-1.5 text-[12px] leading-relaxed text-secondary">
            {setup.profileStatus === "stale"
              ? "The documents changed since the profile was built, so matching is paused until it is rebuilt."
              : "The documents are uploaded, but the profile the matching engine reads has not been built yet."}
          </p>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-tertiary">
            Career-Ops does not read .docx itself — working out which employer each skill belongs to
            is reading comprehension, and getting it wrong would put experience you do not have into
            a tailored resume. Run this in Claude Code:
          </p>
          <code className="mt-2 block select-all rounded-md bg-[var(--z0-bg)] px-3 py-2 text-[12.5px] text-primary">
            {setup.profileCommand}
          </code>
          <button
            type="button"
            onClick={() => refresh()}
            className="mt-3 rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
          >
            I&apos;ve run it — check again
          </button>
        </Surface>
      )}

      {/* 5 — automatic */}
      {setup?.canEvaluate && (
        <Surface level="z3" className="rounded-[var(--radius-xl)] px-5 py-4">
          <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Evaluation</h2>
          {evaluating ? (
            <p className="mt-1.5 text-[12.5px] text-secondary">
              Evaluating jobs against this profile… {progress ? `${progress.done.toLocaleString()} so far` : ""}
            </p>
          ) : setup.steps.evaluated ? (
            <p className="mt-1.5 text-[12.5px] text-[var(--success)]">
              {setup.counts.evaluated.toLocaleString()} jobs evaluated · {setup.counts.readyForTailoring} ready for
              tailoring
            </p>
          ) : (
            <p className="mt-1.5 text-[12.5px] text-secondary">Starting automatically…</p>
          )}
        </Surface>
      )}

      {error && <p className="text-[12.5px] text-[var(--error)]">{error}</p>}

      {setup?.complete && (
        <Link
          href="/jobs"
          className="self-start rounded-md bg-[var(--accent)] px-3.5 py-2 text-[13px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
        >
          Open Jobs →
        </Link>
      )}
    </div>
  );
}
