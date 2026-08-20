"use client";

import { useEffect, useState, useRef } from "react";
import { summarizeResumeStage, type ResumeStageSummary } from "./resumeStage";
import { presentDisposition } from "@/lib/resumeQuality/dispositionPresentation";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { StructuredResumeReview, RequiredCorrection } from "@/lib/resumeQuality/types";

/** Local, dependency-free label formatter — deliberately NOT imported from
 *  src/lib/resumeQuality/reviewFeedback.ts, which transitively pulls in canonicalInstructions.ts's
 *  node:crypto usage and cannot be bundled into a client component. Purely cosmetic string
 *  formatting, not a second definition of any business logic (unlike best-attempt ranking, which
 *  this file only ever displays via the server-computed `bestAttempt` field, never recomputes). */
function humanizeCheckName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface QualityWorkflowResponse {
  candidateId: number;
  jobId: number;
  jobTitle: string;
  companyName: string;
  applicationId: number | null;
  tailoringRun: { id: number; status: string; created_at: string } | null;
  workflow: {
    id: number;
    status: string;
    current_iteration: number;
    max_iterations: number;
    latest_overall_score: number | null;
    final_approved_iteration: number | null;
    failure_reason: string | null;
    created_at: string;
  } | null;
  authorization: {
    isMarked: boolean;
    markedAt: string | null;
    approvalType: string | null;
    approvedDecision: string | null;
    isAuthorized: boolean;
    blockingReason: string | null;
    matchDecision: string;
    insufficientJdSignal: boolean;
  };
  iterations: Array<{
    id: number;
    iteration_number: number;
    overall_score: number | null;
    ats_score: number | null;
    keyword_alignment_score: number | null;
    truthfulness_score: number | null;
    architecture_consistency_score: number | null;
    recruiter_readability_score: number | null;
    formatting_score: number | null;
    blocking_issue_count: number;
    review_json: string | null;
    created_at: string;
  }>;
  latestReview: StructuredResumeReview | null;
  qualityGate: {
    passed: boolean;
    outcome: string;
    reasons: string[];
    blockingIssues: string[];
    instructionCompliance?: {
      instructionVersion: string;
      instructionHash: string;
      isCurrent: boolean;
      failingChecks: string[];
    } | null;
  } | null;
  bestAttempt: {
    iterationNumber: number;
    selectionReason: string;
    overallScore: number;
    atsScore: number;
    truthfulnessScore: number;
    architectureConsistencyScore: number;
    instructionCompliancePassCount: number;
    instructionComplianceTotal: number;
    failingChecks: string[];
    blockingIssues: string[];
  } | null;
  availableArtifacts: {
    hasFinalResume: boolean;
    hasFinalCoverLetter: boolean;
    hasFinalFeedback: boolean;
    hasIterationResume: boolean;
    hasIterationCoverLetter: boolean;
    hasIterationFeedback: boolean;
    hasHandoffPackage: boolean;
    hasHumanReviewResume: boolean;
    hasHumanReviewCoverLetter: boolean;
  };
  waitingFor: "EXTERNAL_WRITER" | "HUMAN_REVIEW" | "COMPLETED" | "NOT_WAITING";
  /** Stage 26 — writer/scheduler health, present only while the writer owns the next step. Never
   *  derived from workflow.status: an approved job waiting to be written says nothing about whether
   *  anything is currently writing it. */
  writer: {
    state:
      | "PROCESSING"
      | "WAITING_FOR_NEXT_ATTEMPT"
      | "IDLE"
      | "UNAVAILABLE_SCHEDULER_DISABLED"
      | "WAITING_OUTSIDE_WINDOW"
      | "UNAVAILABLE_NOT_RUNNING"
      | "TECHNICAL_FAILURE"
      | "CANDIDATE_CONTACT_REQUIRED"
      // Stage 27 — operationally distinct states that used to be reported as ordinary waiting or as
      // a technical failure that "retries on its own schedule".
      | "BLOCKED_MAX_ATTEMPTS"
      | "SUBSCRIPTION_LIMIT_REACHED"
      | "AUTH_REQUIRED"
      | "UNAUTHORIZED_APPROVAL_STALE";
    detail: string;
    schedulerEnabled: boolean;
    withinWindow: boolean;
    intervalMinutes: number;
    batchSize: number;
    pendingWorkflowCount: number;
    lastTickAt: string | null;
    lastPassStartedAt: string | null;
    lastPassCompletedAt: string | null;
    lastPassDurationMs: number | null;
    lastPassOutcome: string | null;
    lastPassError: string | null;
    nextAttemptAt: string | null;
    processingSince: string | null;
    workflowOutcome: { outcome: string; iterationNumber?: number; error?: string } | null;
  } | null;
  iterationBudget: {
    current: number;
    max: number;
    writerAttemptsUsed: number;
    writerAttemptsRemaining: number;
    targetIteration: number | null;
  } | null;
  /** Phase 9A publication outcome for a READY workflow, read from the record written beside the
   *  approved artifacts. "UNKNOWN" means the workflow was approved before this was recorded — it is
   *  never a stand-in for "published". */
  /**
   * Stage 28 — the verdict a human acts on for a finished workflow. Deliberately three distinct
   * words: READY (the unchanged full quality contract), SAFE_BEST_ATTEMPT (every absolute
   * truthfulness/safety guardrail passed, optimisation did not) and BLOCKED (a real safety blocker
   * remains). A safe best attempt must never be shown as READY, and never as a plain failure.
   */
  finalDisposition: {
    disposition: "READY" | "SAFE_BEST_ATTEMPT" | "BLOCKED";
    selectedIterationNumber: number | null;
    selectionReason: string | null;
    safety: { safe: boolean; blockers: string[] };
    optimizationScore: number | null;
    optimizationFindings: string[];
    humanMaySend: boolean;
  } | null;
  writerQueue: {
    concurrency: number;
    pendingApprovedWorkflows: number | null;
    processingSince: string | null;
    schedulerHost: string;
  } | null;
  publication: {
    status: "PUBLISHED" | "FAILED" | "UNKNOWN";
    directory: string | null;
    recordedAt: string | null;
    error: string | null;
  } | null;
  /** Stage 28 — where a SAFE_BEST_ATTEMPT package was written, when one was. */
  safeAttemptPublication?: { directory: string; resume: string; coverLetter: string; reviewFeedback: string | null } | null;
}

/** Stage 26 — one short label per writer state, for the pipeline status chip. */
const WRITER_STATE_LABEL: Record<string, string> = {
  PROCESSING: "Writer processing",
  WAITING_FOR_NEXT_ATTEMPT: "Waiting for writer",
  IDLE: "Writer idle",
  UNAVAILABLE_SCHEDULER_DISABLED: "Writer unavailable",
  WAITING_OUTSIDE_WINDOW: "Waiting for automation window",
  UNAVAILABLE_NOT_RUNNING: "Writer not running",
  TECHNICAL_FAILURE: "Writer technical failure",
  CANDIDATE_CONTACT_REQUIRED: "Contact details required",
  BLOCKED_MAX_ATTEMPTS: "Writer stopped — action needed",
  SUBSCRIPTION_LIMIT_REACHED: "Claude usage limit reached",
  AUTH_REQUIRED: "Claude sign-in required",
  UNAUTHORIZED_APPROVAL_STALE: "Approval no longer valid",
};

/** Stage 27 — the states an operator (not time) has to resolve. They share the "needs you" styling
 *  and are the ones that offer the Retry writer control. */
const WRITER_OPERATOR_ACTION_STATES = new Set([
  "BLOCKED_MAX_ATTEMPTS",
  "SUBSCRIPTION_LIMIT_REACHED",
  "AUTH_REQUIRED",
  "UNAUTHORIZED_APPROVAL_STALE",
]);

function getStepIndex(status: string): number {
  switch (status) {
    // Stage 26 — an approved workflow now waits in CREATED for the scheduled writer to produce
    // iteration 1, so it belongs on the Writer step rather than a "nothing has happened yet" step.
    case "CREATED":
      return 1;
    case "WRITER_RUNNING":
    case "WRITER_COMPLETED":
      return 1;
    case "REVIEW_RUNNING":
    case "REVIEW_COMPLETED":
      return 2;
    case "IMPROVEMENT_RUNNING":
      return 3;
    case "READY":
      return 4;
    case "FAILED":
      return 3;
    default:
      return 0;
  }
}

function PriorityBadge({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    CRITICAL: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300 border-red-200 dark:border-red-800",
    HIGH: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300 border-orange-200 dark:border-orange-800",
    MEDIUM: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300 border-amber-200 dark:border-amber-800",
    LOW: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${
        colors[priority] ?? colors.LOW
      }`}
    >
      {priority}
    </span>
  );
}

/**
 * Mirrors evaluateQualityGate()'s strengthened condition (original 4 Stage 7 scores/blocking-issues
 * PLUS every canonical instruction-compliance check PASS) for whichever review is currently
 * displayed — not just the latest iteration, since the user can browse iteration history. Kept as a
 * plain, dependency-free function rather than importing qualityGate.ts directly: that module pulls
 * in canonicalInstructions.ts's node:crypto usage, which client components can't bundle. The one
 * piece intentionally NOT replicated here is "compliance was computed against the CURRENT canonical
 * instruction hash" (that check needs the crypto-derived constant) — the authoritative READY/FAILED
 * status shown elsewhere on this page always comes from the server-computed workflow.status.
 */
function reviewPassesStrengthenedGate(review: StructuredResumeReview): boolean {
  const originalGate =
    review.overallScore >= 95 &&
    review.truthfulnessScore === 100 &&
    review.architectureConsistencyScore === 100 &&
    review.blockingIssues.length === 0;
  const compliance = review.instructionCompliance;
  const compliancePass = compliance !== undefined && Object.values(compliance.checks).every((status) => status === "PASS");
  return originalGate && compliancePass;
}

function ScoreBar({ label, score, target = 95 }: { label: string; score: number | null; target?: number }) {
  const val = score ?? 0;
  const isPass = val >= target;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-zinc-600 dark:text-zinc-400 font-medium">{label}</span>
        <span className={`font-semibold ${isPass ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-800 dark:text-zinc-200"}`}>
          {score !== null ? `${score}/100` : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${
            val >= 95 ? "bg-emerald-500" : val >= 80 ? "bg-blue-500" : val >= 60 ? "bg-amber-500" : "bg-red-500"
          }`}
          style={{ width: `${Math.min(Math.max(val, 0), 100)}%` }}
        />
      </div>
    </div>
  );
}

export function ResumeQualityPipeline({
  jobId,
  jobTitle,
  companyName,
  onStageChange,
}: {
  jobId: number;
  jobTitle: string;
  companyName: string;
  /** Reports the workflow stage upward so the command center can show where the resume stands.
   *  This is a REPORT of the response this component already fetched — it adds no request. */
  onStageChange?: (stage: ResumeStageSummary) => void;
}) {
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<QualityWorkflowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [selectedIterationNumber, setSelectedIterationNumber] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* Report the workflow stage upward. Keyed on the few primitives the summary actually depends on,
   * so this fires when the STAGE changes rather than on every poll tick that returns the same
   * status. No request is made here — this is the response this component already has. */
  const reportedStatus = data?.workflow?.status ?? null;
  const reportedWaiting = data?.waitingFor ?? null;
  const reportedDisposition = data?.finalDisposition?.disposition ?? null;
  const reportedIteration = data?.workflow?.current_iteration ?? null;
  useEffect(() => {
    if (!onStageChange) return;
    onStageChange(
      summarizeResumeStage({
        status: reportedStatus,
        waitingFor: reportedWaiting,
        disposition: reportedDisposition,
        currentIteration: reportedIteration,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedStatus, reportedWaiting, reportedDisposition, reportedIteration]);

  async function loadData() {
    try {
      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow`);
      if (!res.ok) throw new Error("Failed to load workflow state");
      const json = (await res.json()) as QualityWorkflowResponse;
      setData(json);
      if (selectedIterationNumber === null && json.workflow?.current_iteration) {
        setSelectedIterationNumber(json.workflow.current_iteration);
      }
    } catch {
      // Ignored
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId, jobId]);

  // Stage 26 — while the scheduled writer owns the next step, this page is the only place the user
  // watches progress, and the transitions it reports (writer picks the job up, review runs, gate
  // passes, artifacts publish) now happen without any further click. Polls ONLY in that state, so a
  // READY/FAILED/unstarted page makes no repeat requests.
  const isAwaitingWriter = data?.waitingFor === "EXTERNAL_WRITER";
  useEffect(() => {
    if (!isAwaitingWriter) return;
    const timer = setInterval(() => {
      loadData();
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAwaitingWriter, candidateId, jobId]);

  async function handleStartTailoring(approvalType?: "READY_DIRECT" | "NEEDS_REVIEW_OVERRIDE") {
    setActionBusy(true);
    setActionMessage(null);
    try {
      if (approvalType && data?.authorization.matchDecision) {
        // First mark with approval context
        await fetch(`/api/jobs/${jobId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            candidateId,
            markedForTailoring: true,
            approval: {
              approvalType,
              decision: data.authorization.matchDecision,
            },
          }),
        });
      }

      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to start tailoring workflow");
      }

      setActionMessage({
        type: "success",
        text: body.awaitingWriter
          ? "Approved. The resume writer will pick this up automatically on its next scheduled pass — nothing else to run."
          : "Quality workflow initialized successfully.",
      });
      await loadData();
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Error starting tailoring" });
    } finally {
      setActionBusy(false);
    }
  }

  /**
   * Stage 27 — the operator's "Retry writer" action. Clears only technical-retry bookkeeping so the
   * normal scheduled writer can pick this workflow up again; it writes nothing itself and cannot
   * change an approval, a score, an iteration, or an application.
   */
  async function handleRetryWriter() {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/retry-writer`, {
        method: "POST",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to reset the writer retry state");
      setActionMessage({ type: "success", text: body.message ?? "Writer retry state cleared." });
      await loadData();
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Error resetting writer retry state" });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleExportPackage() {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overwrite: true }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to export writer package");
      }

      setActionMessage({
        type: "success",
        text: `Handoff package exported for iteration ${body.exportResult.targetIterationNumber}.`,
      });
      await loadData();
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Error exporting package" });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setActionBusy(true);
    setActionMessage(null);

    try {
      const text = await file.text();
      // Test parse
      JSON.parse(text);

      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error ?? "Failed to import writer output");
      }

      setActionMessage({
        type: "success",
        text: `Successfully imported writer output and completed iteration review (Score: ${body.result.review.overallScore}/100).`,
      });

      await loadData();
      if (body.workflow?.current_iteration) {
        setSelectedIterationNumber(body.workflow.current_iteration);
      }
    } catch (err: unknown) {
      setActionMessage({
        type: "error",
        text: err instanceof Error ? err.message : "Invalid JSON or import error",
      });
    } finally {
      setActionBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Resume Tailoring Pipeline</h2>
        <p className="mt-2 text-xs text-zinc-500">Loading pipeline status…</p>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const { workflow, authorization, applicationId, tailoringRun, iterations, bestAttempt, availableArtifacts, writer, iterationBudget, publication, finalDisposition } = data;

  // Stage 28 — a terminal FAILED workflow is NOT automatically a failure to the user. When every
  // absolute truthfulness guardrail passed, the safest attempt is a usable human-review package and
  // must be presented as such; only a genuine safety blocker is "do not apply".
  // The presentation rule itself lives in a pure, tested function (dispositionPresentation.ts) so
  // "a safe best attempt never reads as FAILED, and never as READY" is provable, not just visual.
  const presentation = presentDisposition({
    workflowStatus: workflow?.status ?? "",
    disposition: finalDisposition?.disposition ?? null,
  });
  const isSafeBestAttempt = presentation.tone === "REVIEW" && finalDisposition?.disposition === "SAFE_BEST_ATTEMPT";
  const isBlockedUnsafe = workflow?.status === "FAILED" && !isSafeBestAttempt;
  /** The attempt a human should actually download — never simply "the latest". */
  const safeSelectedIteration = finalDisposition?.selectedIterationNumber ?? null;

  // Selected iteration data for historical view
  const activeIterNum = selectedIterationNumber ?? workflow?.current_iteration ?? 1;
  const selectedIterRow = iterations.find((it) => it.iteration_number === activeIterNum);
  let displayedReview: StructuredResumeReview | null = null;
  if (selectedIterRow?.review_json) {
    try {
      displayedReview = JSON.parse(selectedIterRow.review_json) as StructuredResumeReview;
    } catch {
      displayedReview = data.latestReview;
    }
  } else {
    displayedReview = data.latestReview;
  }

  const currentStep = workflow ? getStepIndex(workflow.status) : -1;

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900 space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-100 pb-4 dark:border-zinc-800">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Resume Tailoring Pipeline</h2>
            {workflow && (
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  workflow.status === "READY"
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : isSafeBestAttempt
                    ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                    : workflow.status === "FAILED"
                    ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300"
                    : workflow.status === "IMPROVEMENT_RUNNING" || workflow.status === "CREATED"
                    ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                    : "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                }`}
              >
                {/* Stage 26 — CREATED now means "approved, waiting for the writer's first draft", not
                    "nothing has happened"; the raw enum name would read as the latter.
                    Stage 28 — a terminal workflow whose safety checks all passed reads as SAFE BEST
                    ATTEMPT, never as the bare FAILED enum: the documents are genuinely usable, and
                    the underlying status stays FAILED only because the full gate was not met. */}
                {presentation.label}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {companyName} — {jobTitle}
            {applicationId && <span className="ml-2">· Application #{applicationId}</span>}
            {tailoringRun && <span className="ml-2">· Run #{tailoringRun.id}</span>}
          </p>
        </div>

        {workflow && (
          <div className="text-right">
            <div className="text-xs text-zinc-500">Iteration</div>
            <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              {workflow.current_iteration} of {workflow.max_iterations}
            </div>
          </div>
        )}
      </div>

      {/* Action Notification */}
      {actionMessage && (
        <div
          className={`rounded-md p-3 text-xs ${
            actionMessage.type === "success"
              ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-800"
              : "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200 border border-red-200 dark:border-red-800"
          }`}
        >
          {actionMessage.text}
        </div>
      )}

      {/* State Visualization */}
      {workflow && (
        <div className="py-2">
          <div className="grid grid-cols-5 gap-2 text-center text-xs">
            {["Created", "Writer", "Review", "Improvement", "Ready"].map((stepLabel, idx) => {
              const isPast = currentStep > idx;
              const isCurrent = currentStep === idx;
              const isReady = workflow.status === "READY" && idx === 4;
              // Stage 28 — a safe best attempt reached the end of the pipeline with usable output,
              // so the final step is not painted as a failure.
              const isFailed = presentation.renderAsFailedStep && idx === 3;
              return (
                <div key={stepLabel} className="flex flex-col items-center gap-1.5">
                  <div
                    className={`h-2 w-full rounded-full transition-colors ${
                      isReady
                        ? "bg-emerald-500"
                        : isFailed
                        ? "bg-red-500"
                        : isCurrent
                        ? "bg-blue-600"
                        : isPast
                        ? "bg-blue-300 dark:bg-blue-800"
                        : "bg-zinc-100 dark:bg-zinc-800"
                    }`}
                  />
                  <span
                    className={`text-[11px] font-medium ${
                      isCurrent || isReady || isFailed
                        ? "text-zinc-900 dark:text-zinc-100 font-semibold"
                        : "text-zinc-400 dark:text-zinc-600"
                    }`}
                  >
                    {stepLabel}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 1. Unstarted or Unapproved State */}
      {!workflow && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Tailoring Authorization</h3>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              {authorization.isAuthorized
                ? "This posting is approved and ready for automated deterministic tailoring."
                : authorization.blockingReason ?? "Tailoring approval required."}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {authorization.isAuthorized ? (
              <button
                onClick={() => handleStartTailoring()}
                disabled={actionBusy}
                className="rounded bg-zinc-900 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                {actionBusy ? "Starting Pipeline…" : "Start Tailoring Pipeline"}
              </button>
            ) : authorization.matchDecision === "READY_FOR_TAILORING" ? (
              <button
                onClick={() => handleStartTailoring("READY_DIRECT")}
                disabled={actionBusy}
                className="rounded bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {actionBusy ? "Authorizing…" : "Approve & Start Tailoring"}
              </button>
            ) : authorization.matchDecision === "NEEDS_REVIEW" && authorization.insufficientJdSignal ? (
              // Stage 24A: this is NOT a genuinely-reviewed borderline case — the evaluation ran
              // with too little structured JD data to mean anything (see insufficientJdSignal on
              // JobMatchResult). Offering the same override button here would make "CareerOps
              // failed to evaluate" look identical to "a human reviewed this and it's a real
              // judgment call". Re-evaluating (now that job intelligence exists) is the correct
              // next step, not an exceptional override.
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-500">
                  Evaluated with insufficient structured JD data — this is not a real match judgment yet.
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="rounded border border-amber-300 px-3.5 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/40"
                >
                  Re-evaluate from the job page, then return here
                </button>
              </div>
            ) : authorization.matchDecision === "NEEDS_REVIEW" ? (
              <button
                onClick={() => handleStartTailoring("NEEDS_REVIEW_OVERRIDE")}
                disabled={actionBusy}
                className="rounded bg-amber-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {actionBusy ? "Authorizing…" : "Approve Override & Start Tailoring"}
              </button>
            ) : (
              <span className="text-xs font-medium text-zinc-500 italic">
                Match decision is {authorization.matchDecision}. Resolve profile gaps before tailoring.
              </span>
            )}
          </div>
        </div>
      )}

      {/* 2. Success Banner when READY */}
      {workflow?.status === "READY" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/80 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">
                ✓ Resume Ready for Application
              </h3>
              <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-300">
                Quality score: <strong>{workflow.latest_overall_score ?? 96}/100</strong>. Approved at Iteration{" "}
                {workflow.final_approved_iteration ?? workflow.current_iteration}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/resume`}
                download
                className="inline-flex items-center rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                Download Resume (.docx)
              </a>
              {availableArtifacts.hasFinalCoverLetter && (
                <a
                  href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/coverLetter`}
                  download
                  className="inline-flex items-center rounded border border-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
                >
                  Download Cover Letter (.docx)
                </a>
              )}
            </div>
          </div>

          {/* Stage 26 — where the approved application actually landed on disk (Phase 9A). Shown as a
              repo-relative path with a copy action, never as a link: a browser cannot open a local
              directory, and a link that silently does nothing would be worse than plain text. */}
          {publication?.status === "PUBLISHED" && publication.directory && (
            <div className="mt-3 border-t border-emerald-200/70 pt-3 dark:border-emerald-900/40">
              <p className="text-xs font-medium text-emerald-900 dark:text-emerald-200">Published application folder</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="rounded bg-emerald-100/70 px-2 py-1 text-[11px] text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
                  {publication.directory}
                </code>
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(publication.directory ?? "");
                    setActionMessage({ type: "success", text: "Published folder path copied." });
                  }}
                  className="rounded border border-emerald-600 px-2 py-1 text-[11px] font-medium text-emerald-800 hover:bg-emerald-100 dark:text-emerald-200 dark:hover:bg-emerald-900/40"
                >
                  Copy path
                </button>
              </div>
              <p className="mt-1 text-[11px] text-emerald-700 dark:text-emerald-300">
                Contains the resume, cover letter, review feedback, and a manifest — the same bytes the download
                buttons above serve.
              </p>
            </div>
          )}

          {/* A publication failure never unwinds a genuine approval, so it is reported HERE, beside a
              banner that still correctly says the resume is ready — not by pretending the workflow
              failed, and not by staying silent. */}
          {publication?.status === "FAILED" && (
            <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                Resume approved, but not copied to the applications folder
              </p>
              <p className="mt-1 text-[11px] text-amber-800 dark:text-amber-300">
                {publication.error ?? "Publication did not complete."} The approved documents are still available from the
                download buttons above.
              </p>
            </div>
          )}

          {publication?.status === "UNKNOWN" && (
            <p className="mt-3 text-[11px] text-emerald-700 dark:text-emerald-300">
              Publication status for this approval was not recorded, so the applications-folder copy cannot be confirmed
              from here. The approved documents above are authoritative.
            </p>
          )}
        </div>
      )}

      {/* Stage 28 — SAFE BEST ATTEMPT. A truthful package that did not clear the full optimisation
             bar. Styled as review/warning, never as success and never as failure: showing this in red
             "FAILED" styling was the Stage 28 gap, because the documents are genuinely usable. */}
      {isSafeBestAttempt && finalDisposition && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                SAFE BEST ATTEMPT — HUMAN REVIEW REQUIRED
              </h3>
              <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                This package passed every truthfulness and safety check, but did not clear the full quality gate. It is
                not an approved READY publication. Review it and decide for yourself — CareerOps never submits an
                application.
              </p>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-amber-700 dark:text-amber-400">Selected attempt</div>
              <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                Iteration {finalDisposition.selectedIterationNumber} of {workflow?.max_iterations}
              </div>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-amber-700 dark:text-amber-400">Safety / truthfulness</dt>
              <dd className="font-semibold text-emerald-700 dark:text-emerald-400">
                {finalDisposition.safety.safe ? "PASS" : "FAIL"}
              </dd>
            </div>
            <div>
              <dt className="text-amber-700 dark:text-amber-400">Optimization</dt>
              <dd className="font-semibold text-amber-900 dark:text-amber-200">
                {finalDisposition.optimizationScore ?? "—"}
                <span className="ml-1 font-normal text-[11px] text-amber-700 dark:text-amber-400">(not a pass threshold)</span>
              </dd>
            </div>
            <div>
              <dt className="text-amber-700 dark:text-amber-400">Blocking issues</dt>
              <dd className="font-semibold text-amber-900 dark:text-amber-200">{finalDisposition.safety.blockers.length}</dd>
            </div>
            <div>
              <dt className="text-amber-700 dark:text-amber-400">Human application</dt>
              <dd className="font-semibold text-amber-900 dark:text-amber-200">
                {finalDisposition.humanMaySend ? "Allowed after review" : "Not allowed"}
              </dd>
            </div>
          </dl>

          {/* The remaining findings, stated plainly and never hidden — but labelled for what they
                 are, so a presentation nit is not mistaken for a truthfulness problem. */}
          {finalDisposition.optimizationFindings.length > 0 && (
            <div className="rounded border border-amber-300/70 bg-white/70 p-3 dark:border-amber-800/50 dark:bg-amber-950/20">
              <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">
                Remaining optimization / presentation findings — none of these is a truthfulness blocker
              </p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-amber-800 dark:text-amber-300">
                {finalDisposition.optimizationFindings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Downloads resolve to the SELECTED attempt explicitly, never "the latest iteration". */}
          {safeSelectedIteration !== null && (
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/resume?iteration=${safeSelectedIteration}`}
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
              >
                Download Resume (iteration {safeSelectedIteration})
              </a>
              <a
                href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/coverLetter?iteration=${safeSelectedIteration}`}
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
              >
                Download Cover Letter (iteration {safeSelectedIteration})
              </a>
              <a
                href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/feedback?iteration=${safeSelectedIteration}`}
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-50 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100"
              >
                Review Feedback
              </a>
            </div>
          )}

          {data.safeAttemptPublication?.directory && (
            <p className="text-[11px] text-amber-800 dark:text-amber-300">
              Human-review package published to:{" "}
              <code className="rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-900/40">
                {data.safeAttemptPublication.directory}
              </code>
            </p>
          )}

          {finalDisposition.selectionReason && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">Why this attempt: {finalDisposition.selectionReason}</p>
          )}
        </div>
      )}

      {/* Stage 28 — BLOCKED. A real safety/truthfulness blocker remains, so the package must not be
             sent at all. This is the only case that keeps the hard red "do not apply" styling. */}
      {isBlockedUnsafe && finalDisposition && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/40 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-red-900 dark:text-red-200">BLOCKED / UNSAFE — DO NOT APPLY</h3>
            <p className="mt-1 text-xs text-red-800 dark:text-red-300">
              This package has {finalDisposition.safety.blockers.length} unresolved truthfulness/safety blocker
              {finalDisposition.safety.blockers.length === 1 ? "" : "s"}. It must not be sent, and no application
              download is offered for it.
            </p>
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-red-800 dark:text-red-300">
            {finalDisposition.safety.blockers.slice(0, 10).map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* 3. Human Review / FAILED Banner — the legacy detail panel. Retained for the diagnostic
             best-attempt scores, but no longer the thing that decides how the outcome READS: a safe
             best attempt is headlined by the amber panel above. */}
      {workflow?.status === "FAILED" && !isSafeBestAttempt && (
        <div className="rounded-lg border border-red-200 bg-red-50/80 p-4 dark:border-red-900/60 dark:bg-red-950/30 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-red-900 dark:text-red-200">Human Review Required</h3>
            <p className="mt-1 text-xs text-red-700 dark:text-red-300">
              {workflow.max_iterations} automatic quality attempt{workflow.max_iterations === 1 ? "" : "s"} completed.{" "}
              {workflow.failure_reason ?? "Max improvement iterations reached without meeting quality threshold."}
            </p>
          </div>

          {bestAttempt && (
            <div className="rounded border border-red-200/70 bg-white/60 p-3 dark:border-red-900/40 dark:bg-red-950/10">
              <p className="text-xs font-semibold text-red-900 dark:text-red-200">
                Best Attempt: Iteration {bestAttempt.iterationNumber}
              </p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-red-800 dark:text-red-300 sm:grid-cols-4">
                <div>
                  <dt className="text-red-600 dark:text-red-400">Overall</dt>
                  <dd className="font-medium">{bestAttempt.overallScore}</dd>
                </div>
                <div>
                  <dt className="text-red-600 dark:text-red-400">ATS Match</dt>
                  <dd className="font-medium">{bestAttempt.atsScore}</dd>
                </div>
                <div>
                  <dt className="text-red-600 dark:text-red-400">Truthfulness</dt>
                  <dd className="font-medium">{bestAttempt.truthfulnessScore}</dd>
                </div>
                <div>
                  <dt className="text-red-600 dark:text-red-400">Architecture</dt>
                  <dd className="font-medium">{bestAttempt.architectureConsistencyScore}</dd>
                </div>
              </dl>
              <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                Instruction Compliance: {bestAttempt.instructionCompliancePassCount}/{bestAttempt.instructionComplianceTotal} PASS
              </p>
              {bestAttempt.failingChecks.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-xs font-medium text-red-800 dark:text-red-300">Failed checks:</p>
                  <ul className="mt-0.5 list-disc pl-4 text-xs text-red-700 dark:text-red-300">
                    {bestAttempt.failingChecks.map((name) => (
                      <li key={name}>{humanizeCheckName(name)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-2 text-xs text-red-700 dark:text-red-300">
                This resume did not pass CareerOps approval. It is provided as the strongest attempt for manual review.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {availableArtifacts.hasHumanReviewResume && (
                  <a
                    href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/resume`}
                    download
                    className="inline-flex items-center rounded border border-red-600 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/40"
                  >
                    Download Best Resume
                  </a>
                )}
                {availableArtifacts.hasHumanReviewCoverLetter && (
                  <a
                    href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/coverLetter`}
                    download
                    className="inline-flex items-center rounded border border-red-600 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/40"
                  >
                    Download Best Cover Letter
                  </a>
                )}
                <a
                  href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/review`}
                  download
                  className="inline-flex items-center rounded border border-red-600 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/40"
                >
                  View CareerOps Review
                </a>
                <a
                  href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/feedback`}
                  download
                  className="inline-flex items-center rounded border border-red-600 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100 dark:text-red-200 dark:hover:bg-red-900/40"
                >
                  View Failed Checks
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 3b. Stage 26 — Autonomous writer status. Shown whenever the writer owns the next step
              (CREATED = iteration 1 not written yet, IMPROVEMENT_RUNNING = corrections required).
              Every line here comes from the scheduler/lease/last-pass record, never from the
              workflow status alone. */}
      {data.waitingFor === "EXTERNAL_WRITER" && writer && (
        <div
          className={`rounded-lg border p-4 space-y-2 ${
            writer.state === "PROCESSING"
              ? "border-blue-200 bg-blue-50/70 dark:border-blue-900/50 dark:bg-blue-950/20"
              : writer.state === "TECHNICAL_FAILURE" || writer.state === "BLOCKED_MAX_ATTEMPTS"
              ? "border-red-200 bg-red-50/70 dark:border-red-900/50 dark:bg-red-950/20"
              : WRITER_OPERATOR_ACTION_STATES.has(writer.state)
              ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
              : writer.state === "CANDIDATE_CONTACT_REQUIRED"
              ? "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30"
              : writer.state === "UNAVAILABLE_SCHEDULER_DISABLED" || writer.state === "UNAVAILABLE_NOT_RUNNING"
              ? "border-zinc-300 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800/40"
              : "border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/20"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                {workflow?.status === "CREATED" ? "Approved — awaiting first resume draft" : "Corrections required — awaiting next draft"}
              </h3>
              <p className="mt-0.5 text-xs text-zinc-700 dark:text-zinc-300">
                {WRITER_STATE_LABEL[writer.state] ?? writer.state}: {writer.detail}
              </p>
            </div>
            {iterationBudget && (
              <div className="text-right">
                <div className="text-[11px] text-zinc-500">Writer attempt</div>
                <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                  {iterationBudget.targetIteration} of {iterationBudget.max}
                </div>
                <div className="text-[11px] text-zinc-500">
                  {iterationBudget.writerAttemptsRemaining} remaining
                </div>
              </div>
            )}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400 sm:grid-cols-4">
            {writer.state === "PROCESSING" && writer.processingSince && (
              <div>
                <dt>Started</dt>
                <dd className="font-medium text-zinc-800 dark:text-zinc-200">{new Date(writer.processingSince).toLocaleString()}</dd>
              </div>
            )}
            {writer.state !== "PROCESSING" && writer.nextAttemptAt && (
              <div>
                <dt>Next attempt</dt>
                <dd className="font-medium text-zinc-800 dark:text-zinc-200">{new Date(writer.nextAttemptAt).toLocaleString()}</dd>
              </div>
            )}
            {writer.lastPassCompletedAt && (
              <div>
                <dt>Last writer pass</dt>
                <dd className="font-medium text-zinc-800 dark:text-zinc-200">{new Date(writer.lastPassCompletedAt).toLocaleString()}</dd>
              </div>
            )}
            <div>
              <dt>Queue</dt>
              <dd className="font-medium text-zinc-800 dark:text-zinc-200">
                {writer.pendingWorkflowCount} awaiting · {writer.batchSize} per pass
              </dd>
            </div>
            <div>
              <dt>Cadence</dt>
              <dd className="font-medium text-zinc-800 dark:text-zinc-200">every {writer.intervalMinutes} min</dd>
            </div>
          </dl>

          {writer.workflowOutcome && (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
              Last outcome for this job: <strong>{writer.workflowOutcome.outcome.replace(/_/g, " ")}</strong>
              {writer.workflowOutcome.error ? ` — ${writer.workflowOutcome.error}` : ""}
            </p>
          )}

          {writer.state === "UNAVAILABLE_SCHEDULER_DISABLED" && (
            <p className="text-xs font-medium text-amber-800 dark:text-amber-400">
              This job is approved and queued, but nothing will write it until background automation is enabled in
              Settings. You can also use the manual writer handoff below.
            </p>
          )}
          {writer.state === "CANDIDATE_CONTACT_REQUIRED" && (
            <p className="text-xs font-medium text-amber-900 dark:text-amber-300">
              This is a configuration issue, not a resume problem — no quality iteration was used.{" "}
              <a href={`/candidates/${candidateId}/settings`} className="underline">
                Add your contact details in Candidate Settings
              </a>{" "}
              and this job resumes automatically on the next scheduled pass.
            </p>
          )}
          {writer.state === "TECHNICAL_FAILURE" && (
            <p className="text-xs font-medium text-red-800 dark:text-red-400">
              No resume was produced and no quality iteration was consumed. The writer retries on its own schedule,
              within a bounded number of attempts.
            </p>
          )}
          {/* Stage 27 — this state is terminal for automatic processing. Saying anything about the
              writer "retrying on its own schedule" here would be false, which is exactly what the
              previous single TECHNICAL_FAILURE branch did. */}
          {writer.state === "BLOCKED_MAX_ATTEMPTS" && (
            <p className="text-xs font-medium text-red-800 dark:text-red-400">
              The writer has stopped retrying this job automatically after repeated technical failures. No resume was
              produced and no quality iteration was consumed. Use <strong>Retry writer</strong> below once you know why
              it was failing.
            </p>
          )}
          {writer.state === "SUBSCRIPTION_LIMIT_REACHED" && (
            <p className="text-xs font-medium text-amber-900 dark:text-amber-300">
              Your Claude subscription usage limit is exhausted, so the writer is waiting rather than retrying. No
              quality iteration was consumed. CareerOps is not told when your usage window resets, so it re-checks
              periodically — you can also use <strong>Retry writer</strong> once you know it has reset.
            </p>
          )}
          {writer.state === "AUTH_REQUIRED" && (
            <p className="text-xs font-medium text-amber-900 dark:text-amber-300">
              The Claude CLI is not signed in on this Mac, so nothing can be written. Run <code>claude login</code> in a
              terminal, then use <strong>Retry writer</strong>. Nothing is retried automatically until then, and no
              quality iteration was consumed.
            </p>
          )}
          {writer.state === "UNAUTHORIZED_APPROVAL_STALE" && (
            <p className="text-xs font-medium text-amber-900 dark:text-amber-300">
              The tailoring approval recorded for this job no longer matches its current match decision, so the writer
              declines it on every pass. Review the job and approve it again if you still want it tailored. Nothing was
              written and no quality iteration was consumed.
            </p>
          )}
          {WRITER_OPERATOR_ACTION_STATES.has(writer.state) && writer.state !== "UNAUTHORIZED_APPROVAL_STALE" && (
            <button
              type="button"
              onClick={handleRetryWriter}
              disabled={actionBusy}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100"
            >
              {actionBusy ? "Retrying…" : "Retry writer"}
            </button>
          )}
        </div>
      )}

      {/* 4. Manual writer handoff — the human fallback, no longer the normal path. Since Stage 26 the
              scheduled writer does this automatically; these controls remain for running a draft by
              hand (a different agent, outside the automation window, or after repeated failures). */}
      {data.waitingFor === "EXTERNAL_WRITER" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/50 dark:bg-amber-950/20 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">Manual Writer Handoff (optional)</h3>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                Target Iteration: {(workflow?.current_iteration ?? 0) + 1} of {workflow?.max_iterations ?? 0} — only needed if
                you want to write this draft yourself instead of waiting for the scheduled writer.
              </p>
            </div>
            <button
              onClick={handleExportPackage}
              disabled={actionBusy}
              className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {actionBusy ? "Exporting…" : "Export Writer Package"}
            </button>
          </div>

          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Use this package with <strong>Claude Code</strong>, <strong>Codex</strong>, <strong>Antigravity</strong>, or
            another external writer agent. After it writes <code>writer_output.json</code>, return here and import the
            result.
          </p>

          <div className="pt-2 border-t border-amber-200/60 dark:border-amber-900/40 flex items-center gap-3">
            <input
              type="file"
              ref={fileInputRef}
              accept=".json"
              onChange={handleFileUpload}
              className="hidden"
              id="writer-output-upload"
            />
            <label
              htmlFor="writer-output-upload"
              className={`inline-flex items-center cursor-pointer rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-800 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700 ${
                actionBusy ? "opacity-50 pointer-events-none" : ""
              }`}
            >
              {actionBusy ? "Processing Import…" : "Import writer_output.json"}
            </label>
            <span className="text-[11px] text-zinc-500">Upload the completed writer JSON output</span>
          </div>
        </div>
      )}

      {/* 5. Quality Score & Deterministic Sub-scores */}
      {displayedReview && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
          {/* Prominent Overall Score Card */}
          <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/40 flex flex-col justify-between">
            <div>
              <div className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Overall Quality Score</div>
              <div className="mt-2 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-zinc-900 dark:text-zinc-100">
                  {displayedReview.overallScore}
                </span>
                <span className="text-sm font-semibold text-zinc-400">/ 100</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-700 text-xs">
              <div className="font-medium text-zinc-700 dark:text-zinc-300 mb-1">Quality Gate Status</div>
              {reviewPassesStrengthenedGate(displayedReview) ? (
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">✓ Ready for Application</span>
              ) : (
                <span className="font-semibold text-amber-600 dark:text-amber-400">⚠ Needs Improvement</span>
              )}
            </div>
          </div>

          {/* Component Sub-scores */}
          <div className="md:col-span-2 rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/40 space-y-2.5">
            <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider mb-2">
              Deterministic Review Components
            </div>
            <ScoreBar label="ATS Keyword Alignment" score={displayedReview.atsScore} target={90} />
            <ScoreBar label="Truthfulness / Master Consistency" score={displayedReview.truthfulnessScore} target={100} />
            <ScoreBar label="Architecture Consistency" score={displayedReview.architectureConsistencyScore} target={100} />
            <ScoreBar label="Recruiter Readability" score={displayedReview.recruiterReadabilityScore} target={85} />
            <ScoreBar label="Document Formatting" score={displayedReview.formattingScore} target={95} />
          </div>
        </div>
      )}

      {/* 5b. Canonical Instruction Compliance */}
      {displayedReview && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50/60 p-4 dark:border-zinc-800 dark:bg-zinc-800/40">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
              Canonical Instruction Compliance
            </div>
            {displayedReview.instructionCompliance && (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Standard v{displayedReview.instructionCompliance.instructionVersion}
                {data?.qualityGate?.instructionCompliance && !data.qualityGate.instructionCompliance.isCurrent && (
                  <span className="ml-1 font-semibold text-amber-600 dark:text-amber-400">(stale — re-review required)</span>
                )}
              </span>
            )}
          </div>
          {!displayedReview.instructionCompliance ? (
            <p className="text-xs text-zinc-500 italic">
              No canonical compliance data (legacy review, produced before this standard existed).
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                {Object.entries(displayedReview.instructionCompliance.checks).map(([name, status]) => (
                  <div key={name} className="flex items-center gap-1.5">
                    <span
                      className={
                        status === "PASS"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : status === "FAIL"
                          ? "text-red-600 dark:text-red-400"
                          : "text-amber-600 dark:text-amber-400"
                      }
                    >
                      {status === "PASS" ? "✓" : status === "FAIL" ? "✗" : "⚠"}
                    </span>
                    <span className="text-zinc-600 dark:text-zinc-400">
                      {name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}
                    </span>
                  </div>
                ))}
              </div>
              {displayedReview.instructionCompliance.notes.length > 0 && (
                <ul className="mt-2 pt-2 border-t border-zinc-200 dark:border-zinc-700 list-disc list-inside space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                  {displayedReview.instructionCompliance.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {/* 6. Review Feedback & Diagnostics */}
      {displayedReview && (
        <div className="space-y-4 pt-2">
          {/* Blocking Issues */}
          {displayedReview.blockingIssues.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3.5 dark:border-red-900 dark:bg-red-950/40">
              <h4 className="text-xs font-semibold text-red-900 dark:text-red-200 mb-1.5">
                Blocking Issues ({displayedReview.blockingIssues.length})
              </h4>
              <ul className="list-disc pl-4 space-y-1 text-xs text-red-800 dark:text-red-300">
                {displayedReview.blockingIssues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Required Corrections */}
          {displayedReview.requiredCorrections && displayedReview.requiredCorrections.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Required Corrections ({displayedReview.requiredCorrections.length})
              </h4>
              <div className="space-y-2">
                {displayedReview.requiredCorrections.map((corr: RequiredCorrection, i: number) => (
                  <div
                    key={i}
                    className="flex items-start gap-2.5 rounded-md border border-zinc-200 bg-white p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900/60"
                  >
                    <PriorityBadge priority={corr.priority} />
                    <p className="text-zinc-800 dark:text-zinc-200 flex-1">{corr.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Detailed Diagnostic Pills */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            {displayedReview.missingRequiredSkills.length > 0 && (
              <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">Missing Required Skills</div>
                <div className="flex flex-wrap gap-1">
                  {displayedReview.missingRequiredSkills.map((s, i) => (
                    <span key={i} className="rounded bg-red-100 px-2 py-0.5 text-red-800 dark:bg-red-900/40 dark:text-red-300">
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {displayedReview.truthfulnessIssues.length > 0 && (
              <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">Truthfulness Diagnostics</div>
                <ul className="list-disc pl-4 space-y-0.5 text-zinc-700 dark:text-zinc-300">
                  {displayedReview.truthfulnessIssues.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            )}

            {displayedReview.incorrectTechnologyUsage.length > 0 && (
              <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">Technology Usage Warnings</div>
                <ul className="list-disc pl-4 space-y-0.5 text-zinc-700 dark:text-zinc-300">
                  {displayedReview.incorrectTechnologyUsage.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
            )}

            {displayedReview.genericBullets.length > 0 && (
              <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
                <div className="font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">Generic / Weak Bullets</div>
                <p className="text-zinc-500">{displayedReview.genericBullets.length} bullet(s) flagged for generic phrasing.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 7. Iteration History */}
      {iterations.length > 0 && (
        <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800 space-y-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Iteration History</div>
          <div className="flex flex-wrap gap-2">
            {iterations.map((iter) => {
              const isSelected = iter.iteration_number === activeIterNum;
              const isReady = iter.overall_score && iter.overall_score >= 95 && iter.blocking_issue_count === 0;
              const isBestAttempt = bestAttempt?.iterationNumber === iter.iteration_number;
              return (
                <button
                  key={iter.id}
                  onClick={() => setSelectedIterationNumber(iter.iteration_number)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium border transition-colors ${
                    isSelected
                      ? "bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100"
                      : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-300 dark:border-zinc-800 dark:hover:bg-zinc-800"
                  }`}
                >
                  Iteration {iter.iteration_number} — {iter.overall_score ?? "—"}/100
                  {isReady && " ✓"}
                  {isBestAttempt && (
                    <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
                      Best Attempt
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
