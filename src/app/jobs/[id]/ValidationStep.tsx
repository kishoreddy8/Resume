"use client";

import type { QualityWorkflowData } from "./useQualityWorkflow";
import { useState } from "react";
import { EmptyNote, StepSectionHeading, WsCard } from "./WorkspaceUI";

/**
 * Step 4 — Validation, as a verification strip.
 *
 * THE DIMENSIONS ARE THE VALIDATOR'S OWN, not a set invented to fill a row. The pipeline returns
 * exactly five scored dimensions — ATS keyword alignment, truthfulness/master consistency,
 * architecture consistency, recruiter readability and document formatting — plus an overall score.
 * There is no separate employer-claims validator and no separate certification validator in the
 * output, so neither is shown. A named check that no validator produces is a fabricated assurance,
 * and this is the one screen where that would matter most.
 *
 * THE VERDICT IS NOT THE SCORE. On real data these disagree: this job's review scores 100 on every
 * dimension while the quality gate has NOT passed and readiness is BLOCKED, because the typed
 * blocking-failure analysis is missing — "not the same as having passed", in the engine's words.
 * So the summary leads with `applicationReadiness`, which is the authority on whether a human may
 * send the package, and the score is reported beside it rather than as it. A green wall of
 * dimension scores above a blocked verdict is exactly the misreading this ordering prevents.
 *
 * NOTHING HERE CAN UPGRADE A RESULT. Every value is passed through; no threshold is re-applied.
 */

interface Dimension {
  label: string;
  score: number | null;
  detail: string;
}

/** Only dimensions the review actually scored. A null score is omitted, never shown as zero. */
function dimensions(data: QualityWorkflowData): Dimension[] {
  const r = data.review;
  if (!r) return [];
  const all: Dimension[] = [
    { label: "ATS keyword alignment", score: r.keywordAlignmentScore ?? r.atsScore, detail: "Keywords against the role's stated requirements" },
    { label: "Truthfulness", score: r.truthfulnessScore, detail: "Every claim traced to your master documents" },
    { label: "Architecture consistency", score: r.architectureConsistencyScore, detail: "Sections and structure hold together" },
    { label: "Recruiter readability", score: r.recruiterReadabilityScore, detail: "Reads cleanly to a human reviewer" },
    { label: "Document formatting", score: r.formattingScore, detail: "Layout survives an ATS parse" },
  ];
  return all.filter((d) => typeof d.score === "number");
}

function toneFor(score: number | null): { dot: string; text: string; word: string } {
  if (score === null) return { dot: "bg-[var(--border-control)]", text: "text-tertiary", word: "Not scored" };
  if (score >= 90) return { dot: "bg-[var(--pill-success-fg)]", text: "text-[var(--pill-success-fg)]", word: "Passed" };
  if (score >= 70) return { dot: "bg-[var(--pill-amber-fg)]", text: "text-[var(--pill-amber-fg)]", word: "Needs review" };
  return { dot: "bg-[var(--error)]", text: "text-[var(--error)]", word: "Failed" };
}

/** The engine's readiness, in a candidate's words. BLOCKED is never softened. */
function verdict(data: QualityWorkflowData): { text: string; tone: "ok" | "warn" | "bad"; note: string | null } {
  const readiness = data.readiness?.readiness ?? null;
  if (readiness === "READY") return { text: "Ready to use", tone: "ok", note: null };
  if (readiness === "BLOCKED")
    return { text: "Blocked", tone: "bad", note: data.readiness?.blockingReasons[0] ?? null };
  if (readiness === "SAFE_BEST_ATTEMPT" || readiness === "NEEDS_REVIEW" || data.gate?.passed === false)
    return {
      text: "Needs your review",
      tone: "warn",
      note: data.readiness?.improvementReasons[0] ?? data.readiness?.blockingReasons[0] ?? null,
    };
  return { text: "Not validated yet", tone: "warn", note: null };
}

/**
 * The one blocked state a candidate can resolve themselves.
 *
 * IT REFRESHES THE CHECKS, IT DOES NOT CLEAR THEM. Pressing this re-runs today's deterministic
 * review over the resume that already exists and records the answer. Whether the package becomes
 * sendable is decided afterwards by the same gate every other review passes through — if the fresh
 * review finds something, this screen simply shows the new reason instead of the old one.
 *
 * The copy never mentions the analyses by name: "typed blocking-failure analysis" is a fact about
 * the pipeline's history, not something a person applying for a job should have to understand.
 */
function RevalidateCard({
  candidateId,
  jobId,
  onDone,
}: {
  candidateId: number;
  jobId: number;
  onDone: () => void;
}) {
  const [state, setState] = useState<"idle" | "running" | "error">("idle");

  async function run() {
    setState("running");
    try {
      const res = await fetch(
        `/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/revalidate`,
        { method: "POST" }
      );
      if (!res.ok) return setState("error");
      /* The parent re-reads the workflow; every verdict on screen comes from that refetch, never
       * from this response. There is no optimistic "passed" state to get wrong. */
      onDone();
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <WsCard tone="warm" title="Validation needs to be refreshed">
      <p className="text-[12.5px] leading-relaxed text-secondary">
        This review was created before JobHunt&apos;s current safety checks were available. Re-run
        validation to evaluate this resume with the latest checks.
      </p>
      <button
        type="button"
        onClick={run}
        disabled={state === "running"}
        aria-busy={state === "running"}
        className="mt-3 flex h-[40px] items-center rounded-[9px] bg-[var(--accent)] px-4 text-[13px] font-semibold text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "running" ? "Re-running validation…" : "Re-run validation"}
      </button>
      <p aria-live="polite" className="mt-2 text-[11px] leading-relaxed text-tertiary">
        {state === "error"
          ? "We couldn't re-run validation. Nothing changed — try again."
          : "Your existing review history will be preserved."}
      </p>
    </WsCard>
  );
}

export function ValidationStep({
  data,
  candidateId,
  jobId,
  onRevalidated,
}: {
  data: QualityWorkflowData;
  candidateId: number;
  jobId: number;
  onRevalidated?: () => void;
}) {
  const dims = dimensions(data);
  const v = verdict(data);
  const overall = data.review?.overallScore ?? null;

  const verdictTone = {
    ok: "text-[var(--pill-success-fg)]",
    warn: "text-[var(--pill-amber-fg)]",
    bad: "text-[var(--error)]",
  }[v.tone];

  return (
    <div>
      <StepSectionHeading
        title="Validation"
        blurb="Whether the tailored resume is truthful and safe to send. The validator decides; this reports."
      />

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* summary — the verdict first, the score beside it */}
        <WsCard title="Validation summary">
          <div className={`text-[19px] font-bold leading-tight ${verdictTone}`}>{v.text}</div>
          {overall !== null && (
            <div className="mt-1.5 text-[12.5px] text-tertiary">
              Review score <span className="font-semibold tabular-nums text-primary">{overall}</span> / 100
            </div>
          )}
          {data.gate && (
            <div className="mt-1 text-[12px] text-tertiary">
              Quality gate: <span className="font-medium text-primary">{data.gate.passed ? "Passed" : "Not passed"}</span>
            </div>
          )}
          {v.note && (
            /* The engine's own sentence, verbatim. Not summarised and not softened. */
            <p className="mt-2.5 border-t border-[#F2F3F7] pt-2.5 text-[11.5px] leading-relaxed text-tertiary dark:border-[var(--separator)]">
              {v.note}
            </p>
          )}
        </WsCard>

        {/* the strip of real dimensions */}
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:[grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
          {dims.length === 0 ? (
            <WsCard>
              <EmptyNote>This resume has not been reviewed yet, so there is nothing to report.</EmptyNote>
            </WsCard>
          ) : (
            dims.map((d) => {
              const t = toneFor(d.score);
              return (
                <WsCard key={d.label}>
                  <div className="flex items-start gap-2">
                    <span aria-hidden="true" className={`mt-[5px] h-2 w-2 shrink-0 rounded-full ${t.dot}`} />
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-semibold leading-snug text-primary">{d.label}</div>
                      {/* Word and number together — the colour is never carrying the state alone. */}
                      <div className={`mt-0.5 text-[11.5px] font-medium ${t.text}`}>
                        {t.word}
                        {d.score !== null && <span className="tabular-nums text-tertiary"> · {d.score}/100</span>}
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-tertiary">{d.detail}</p>
                    </div>
                  </div>
                </WsCard>
              );
            })
          )}
        </div>
      </div>

      {/* The recoverable case, offered only when the review genuinely predates today's checks and
       *  the workflow still has a pass left to record one. */}
      {data.revalidation?.isLegacyMissingAnalysis && data.revalidation.canRevalidate && (
        <div className="mt-3.5">
          <RevalidateCard candidateId={candidateId} jobId={jobId} onDone={() => onRevalidated?.()} />
        </div>
      )}

      {/* Anything the validator actually flagged. Silent when the lists are empty. */}
      {data.review && data.review.blockingIssues.length + data.review.truthfulnessIssues.length > 0 && (
        <div className="mt-3.5">
          <WsCard title="What the validator flagged">
            <ul className="flex flex-col gap-1">
              {[...data.review.blockingIssues, ...data.review.truthfulnessIssues].slice(0, 6).map((issue) => (
                <li key={issue} className="text-[12px] leading-relaxed text-secondary">
                  {issue}
                </li>
              ))}
            </ul>
          </WsCard>
        </div>
      )}
    </div>
  );
}
