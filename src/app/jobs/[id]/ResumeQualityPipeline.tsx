"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { formatQualityScore, summarizeResumeStage, type ResumeStageSummary } from "./resumeStage";
import { presentDisposition } from "@/lib/resumeQuality/dispositionPresentation";
import { presentResumeJourney } from "./resumeJourneyPresentation";
import { StageRail } from "./StageRail";
import { jobWorkspaceUrl } from "./workspaceRoute";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { ResumePreview } from "@/app/resume/ResumePreview";
import { Button, Disclosure, LoadingRegion, SkeletonRows, BTN_PRIMARY, BTN_SECONDARY } from "@/components/ui";
import type { StructuredResumeReview, RequiredCorrection } from "@/lib/resumeQuality/types";

/**
 * UI-5 — the candidate-facing resume-tailoring journey.
 *
 * STATE OWNERSHIP UNCHANGED FROM BEFORE UI-5. This component still owns every fetch, every poll and
 * every mutation for this job's quality workflow — nothing below reads or writes this state from
 * anywhere else, and nothing here creates a second polling loop or a second workflow-state machine.
 * UI-5 only replaces HOW this state is presented: a premium candidate journey (stage rail, plain-
 * language explanation, resume preview, a genuine "ready" arrival) with every diagnostic that used to
 * live on the primary surface preserved, verbatim in spirit, behind ONE "Technical details"
 * disclosure — see the DiagnosticsPanel component at the bottom of this file.
 *
 * `variant="journey"` (the default) is the primary experience — used where this component is the
 * main thing on screen (the Tailoring Results step). `variant="technical"` renders the same real
 * actions and the same diagnostics, without the stage rail/preview/ready-arrival chrome that would
 * duplicate what ValidationStep already shows — used where this component sits inside Validation's
 * own "open the full resume pipeline" disclosure, which exists specifically to reach these actions
 * and this record, not to repeat the verdict Validation already renders.
 */

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
  candidateRepairQuestions?: Array<{
    findingKey: string;
    question: string;
    choices: ["Yes", "No", "Not sure"];
  }>;
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
      | "BLOCKED_MAX_ATTEMPTS"
      | "SUBSCRIPTION_LIMIT_REACHED"
      | "AUTH_REQUIRED"
      | "UNAUTHORIZED_APPROVAL_STALE";
    detail: string;
    schedulerEnabled: boolean;
    writerEnabled: boolean;
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
  safeAttemptPublication?: { directory: string; resume: string; coverLetter: string; reviewFeedback: string | null } | null;
  humanApproval?: {
    workflowId: number;
    selectedIterationNumber: number;
    overallScore: number | null;
    truthfulnessScore: number | null;
    architectureConsistencyScore: number | null;
    approvedAt: string;
  } | null;
}

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

const WRITER_OPERATOR_ACTION_STATES = new Set([
  "BLOCKED_MAX_ATTEMPTS",
  "SUBSCRIPTION_LIMIT_REACHED",
  "AUTH_REQUIRED",
  "UNAUTHORIZED_APPROVAL_STALE",
]);

function humanizeCheckName(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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

function PriorityBadge({ priority }: { priority: string }) {
  const colors: Record<string, string> = {
    CRITICAL: "bg-[var(--pill-red-bg)] text-[var(--pill-red-fg)]",
    HIGH: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
    MEDIUM: "bg-[var(--pill-amber-bg)] text-[var(--pill-amber-fg)]",
    LOW: "bg-[var(--z1-bg)] text-tertiary",
  };
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${colors[priority] ?? colors.LOW}`}>
      {priority}
    </span>
  );
}

function ScoreBar({ label, score, target = 95 }: { label: string; score: number | null; target?: number }) {
  const val = score ?? 0;
  const isPass = val >= target;
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11.5px]">
        <span className="font-medium text-secondary">{label}</span>
        <span className={`font-semibold ${isPass ? "text-[var(--pill-success-fg)]" : "text-primary"}`}>
          {score !== null ? `${score}/100` : "—"}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--z1-bg)]">
        <div
          className={`h-full transition-all duration-300 ${
            val >= 95 ? "bg-[var(--pill-success-fg)]" : val >= 80 ? "bg-[var(--accent)]" : val >= 60 ? "bg-[var(--pill-amber-fg)]" : "bg-[var(--error)]"
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
  variant = "journey",
}: {
  jobId: number;
  jobTitle: string;
  companyName: string;
  /** Reports the workflow stage upward so the command center can show where the resume stands.
   *  This is a REPORT of the response this component already fetched — it adds no request. */
  onStageChange?: (stage: ResumeStageSummary) => void;
  /** "journey" (default): the primary candidate experience — stage rail, explanation, preview,
   *  ready-arrival. "technical": the same real actions and diagnostics without that chrome, for
   *  where this component sits behind Validation's own disclosure. */
  variant?: "journey" | "technical";
}) {
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<QualityWorkflowResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [selectedIterationNumber, setSelectedIterationNumber] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const isAwaitingWriter = data?.waitingFor === "EXTERNAL_WRITER";
  useEffect(() => {
    if (!isAwaitingWriter) return;
    const timer = setInterval(() => {
      loadData();
    }, 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAwaitingWriter, candidateId, jobId]);

  async function handleReTailor() {
    const confirmed = window.confirm(
      "Create a fresh tailored version for this job?\n\n" +
        "Your current READY resume will remain available until the new version passes review."
    );
    if (!confirmed) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      const matchDecision = data?.authorization.matchDecision;
      if (!matchDecision || (matchDecision !== "READY_FOR_TAILORING" && matchDecision !== "NEEDS_REVIEW")) {
        throw new Error(
          `Cannot re-tailor: current match decision is ${matchDecision ?? "unknown"}. Resolve profile gaps before tailoring.`
        );
      }
      const approvalType: "READY_DIRECT" | "NEEDS_REVIEW_OVERRIDE" =
        matchDecision === "NEEDS_REVIEW" ? "NEEDS_REVIEW_OVERRIDE" : "READY_DIRECT";

      const patchRes = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateId,
          markedForTailoring: true,
          approval: {
            approvalType,
            decision: matchDecision,
          },
        }),
      });
      if (!patchRes.ok) {
        const patchBody = await patchRes.json().catch(() => ({}));
        throw new Error(patchBody.error ?? "Failed to refresh tailoring approval");
      }

      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ freshRewrite: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to start re-tailor");
      setActionMessage({
        type: "success",
        text: body.awaitingWriter
          ? "Re-tailor started. The resume writer will pick this up automatically — your current READY version remains available until the new one is approved."
          : "New tailoring version created.",
      });
      await loadData();
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Error starting re-tailor" });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleStartTailoring(approvalType?: "READY_DIRECT" | "NEEDS_REVIEW_OVERRIDE") {
    setActionBusy(true);
    setActionMessage(null);
    try {
      if (approvalType && data?.authorization.matchDecision) {
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

  async function handleApprove() {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId: data?.workflow?.id ?? null }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to approve this resume");
      setActionMessage({
        type: "success",
        text: body.alreadyApproved ? "Already approved." : "Approved. This resume is now eligible for applications.",
      });
      await loadData();
    } catch (err: unknown) {
      setActionMessage({ type: "error", text: err instanceof Error ? err.message : "Error approving resume" });
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
      <div className="rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] p-5">
        <LoadingRegion label="Loading your resume's tailoring progress" />
        <SkeletonRows rows={3} />
      </div>
    );
  }

  if (!data) return null;

  const { workflow, authorization, applicationId, tailoringRun, iterations, bestAttempt, availableArtifacts, writer, iterationBudget, publication, finalDisposition, humanApproval } = data;
  const isApprovedForCurrentWorkflow = humanApproval != null && humanApproval.workflowId === workflow?.id;

  const presentation = presentDisposition({
    workflowStatus: workflow?.status ?? "",
    disposition: finalDisposition?.disposition ?? null,
  });
  const isSafeBestAttempt = presentation.tone === "REVIEW" && finalDisposition?.disposition === "SAFE_BEST_ATTEMPT";
  const isBlockedUnsafe = workflow?.status === "FAILED" && !isSafeBestAttempt;
  const safeSelectedIteration = finalDisposition?.selectedIterationNumber ?? null;

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

  const journey = presentResumeJourney({
    status: workflow?.status ?? null,
    waitingFor: data.waitingFor,
    disposition: finalDisposition?.disposition ?? null,
    blockingReason: finalDisposition?.safety.blockers[0] ?? data.qualityGate?.blockingIssues[0] ?? null,
  });

  const canPreview = (workflow?.current_iteration ?? 0) >= 1;
  const canContinueToApplication =
    journey.tone === "ready" || (isSafeBestAttempt && isApprovedForCurrentWorkflow);
  const applicationHref = jobWorkspaceUrl(jobId, { step: "application" });

  // UI-5.1 checkpoint fix — computed BEFORE the fixed wrapper below so the wrapper itself can be
  // entirely absent (not just visually empty) whenever no genuine action exists. The wrapper used to
  // always render for variant="journey", border/shadow/padding and all, even while this resolved to
  // null — an invisible-content but still-present, still click-intercepting bar sitting permanently
  // above MobileBottomNav on every journey state, confirmed by an actual pointer-event interception
  // in Playwright. Its own reserved bottom padding (below) exists only when this is non-null, for the
  // same reason: an always-on reservation would starve real content of scroll space for no purpose.
  const stickyAction =
    variant !== "journey"
      ? null
      : journey.tone === "ready" && canContinueToApplication ? (
          <Link href={applicationHref} className={`${BTN_PRIMARY} block w-full text-center`}>
            Continue to application
          </Link>
        ) : journey.tone === "ready" ? (
          <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/resume`} download className={`${BTN_PRIMARY} block w-full text-center`}>
            Download resume
          </a>
        ) : isSafeBestAttempt && !isApprovedForCurrentWorkflow ? (
          <Button variant="attention" className="w-full" state={actionBusy ? "loading" : "idle"} loadingLabel="Approving…" onClick={handleApprove} disabled={actionBusy}>
            Approve & use for applications
          </Button>
        ) : isSafeBestAttempt && canContinueToApplication ? (
          <Link href={applicationHref} className={`${BTN_PRIMARY} block w-full text-center`}>
            Continue to application
          </Link>
        ) : !workflow ? (
          authorization.isAuthorized ? (
            <Button variant="primary" className="w-full" state={actionBusy ? "loading" : "idle"} loadingLabel="Starting…" onClick={() => handleStartTailoring()} disabled={actionBusy}>
              Start tailoring
            </Button>
          ) : null
        ) : workflow.status === "FAILED" ? (
          <Button
            variant="primary"
            className="w-full"
            state={actionBusy ? "loading" : "idle"}
            loadingLabel="Starting…"
            onClick={() => handleStartTailoring(authorization.matchDecision === "NEEDS_REVIEW" ? "NEEDS_REVIEW_OVERRIDE" : "READY_DIRECT")}
            disabled={actionBusy}
          >
            Re-tailor resume
          </Button>
        ) : null;

  return (
    <div className={`flex flex-col gap-5 ${stickyAction ? "pb-[84px] lg:pb-0" : ""}`}>
      {variant === "journey" && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[18px] font-bold tracking-[-0.015em] text-primary">Resume tailoring</h2>
            <p className="mt-0.5 text-[13px] text-tertiary">
              {companyName} — {jobTitle}
              {applicationId && <span className="ml-1.5">· Application #{applicationId}</span>}
              {tailoringRun && <span className="ml-1.5">· Run #{tailoringRun.id}</span>}
            </p>
          </div>
          {canPreview && (
            <Button variant="secondary" onClick={() => setPreviewing(true)}>
              View resume
            </Button>
          )}
        </div>
      )}

      {actionMessage && (
        <div
          role={actionMessage.type === "error" ? "alert" : "status"}
          className={`rounded-[12px] px-3.5 py-2.5 text-[12.5px] ${
            actionMessage.type === "success"
              ? "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]"
              : "bg-[var(--pill-red-bg)] text-[var(--pill-red-fg)]"
          }`}
        >
          {actionMessage.text}
        </div>
      )}

      {variant === "journey" && journey.stages && (
        <div className="rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] p-4 sm:p-5">
          <StageRail stages={journey.stages} currentStageKey={journey.currentStageKey} />
          {/* Always announced via the one live region (Part 7) — including the ready transition,
           *  which matters most to a screen-reader user. The ready banner below restates it more
           *  richly for sighted users; the brief overlap is a smaller cost than an unannounced
           *  arrival. */}
          <p aria-live="polite" className="mt-4 text-[14px] font-semibold text-primary">
            {journey.headline}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-secondary">{journey.explanation}</p>
        </div>
      )}

      {/* Unstarted, unapproved — or a terminal FAILED workflow that may be retried. A retry always
       *  passes an approvalType so evaluateWorkflowRetry never refuses it as a stale approval. */}
      {(!workflow || workflow.status === "FAILED") && (
        <div className="rounded-[18px] border border-[var(--border)] bg-[var(--z1-bg)] p-4 sm:p-5">
          <h3 className="text-[14px] font-semibold text-primary">
            {workflow ? "Re-tailor this resume" : "Start tailoring"}
          </h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-secondary">
            {workflow
              ? "This attempt finished without a sendable resume. Starting again creates a new attempt beside it — the version above and its review history are kept, never overwritten."
              : authorization.isAuthorized
                ? "This posting is approved and ready for tailoring."
                : authorization.blockingReason ?? "Tailoring approval required."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {workflow ? (
              <Button
                variant="primary"
                state={actionBusy ? "loading" : "idle"}
                loadingLabel="Starting…"
                onClick={() => handleStartTailoring(authorization.matchDecision === "NEEDS_REVIEW" ? "NEEDS_REVIEW_OVERRIDE" : "READY_DIRECT")}
                disabled={actionBusy}
              >
                Re-tailor resume
              </Button>
            ) : authorization.isAuthorized ? (
              <Button variant="primary" state={actionBusy ? "loading" : "idle"} loadingLabel="Starting…" onClick={() => handleStartTailoring()} disabled={actionBusy}>
                Start tailoring
              </Button>
            ) : authorization.matchDecision === "READY_FOR_TAILORING" ? (
              <Button variant="primary" state={actionBusy ? "loading" : "idle"} loadingLabel="Authorizing…" onClick={() => handleStartTailoring("READY_DIRECT")} disabled={actionBusy}>
                Approve & start tailoring
              </Button>
            ) : authorization.matchDecision === "NEEDS_REVIEW" && authorization.insufficientJdSignal ? (
              <div className="space-y-1.5">
                <p className="text-[12.5px] font-medium text-[var(--attention-fg)]">
                  Evaluated with insufficient structured job data — this is not a real match judgment yet.
                </p>
                <Button variant="secondary" onClick={() => window.location.reload()}>
                  Re-evaluate from the job page, then return here
                </Button>
              </div>
            ) : authorization.matchDecision === "NEEDS_REVIEW" ? (
              <Button variant="attention" state={actionBusy ? "loading" : "idle"} loadingLabel="Authorizing…" onClick={() => handleStartTailoring("NEEDS_REVIEW_OVERRIDE")} disabled={actionBusy}>
                Approve override & start tailoring
              </Button>
            ) : (
              <p className="text-[12.5px] font-medium italic text-tertiary">
                Match decision is {authorization.matchDecision}. Resolve profile gaps before tailoring.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Ready — the one place a genuinely completed resume gets a distinct arrival treatment. */}
      {workflow?.status === "READY" && !isSafeBestAttempt && (
        <div className="relative overflow-hidden rounded-[20px] border border-[color-mix(in_oklab,var(--accent)_20%,var(--border))] bg-[linear-gradient(135deg,color-mix(in_oklab,var(--accent-soft)_55%,var(--z3-bg)),color-mix(in_oklab,var(--secondary-soft,var(--accent-soft))_35%,var(--z3-bg)))] p-5 sm:p-6">
          <span className="inline-flex min-h-7 items-center rounded-full bg-[color-mix(in_oklab,var(--accent)_14%,transparent)] px-3 text-[12.5px] font-semibold text-[var(--accent)]">
            Your resume is ready
          </span>
          <p className="mt-3 max-w-xl text-[13.5px] leading-relaxed text-secondary">
            Quality score: <strong className="text-primary">{formatQualityScore(workflow.latest_overall_score)}</strong>. Approved at
            iteration {workflow.final_approved_iteration ?? workflow.current_iteration}.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/resume`} download className={BTN_PRIMARY}>
              Download resume
            </a>
            {availableArtifacts.hasFinalCoverLetter && (
              <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/coverLetter`} download className={BTN_SECONDARY}>
                Download cover letter
              </a>
            )}
            {canContinueToApplication && (
              <Link
                href={applicationHref}
                className="candidate-control inline-flex h-[42px] items-center justify-center gap-1.5 rounded-[10px] bg-[var(--accent)] px-4 text-[13px] font-semibold text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98]"
              >
                Continue to application
              </Link>
            )}
          </div>

          {publication?.status === "PUBLISHED" && publication.directory && (
            <div className="mt-4 border-t border-[color-mix(in_oklab,var(--accent)_18%,transparent)] pt-3">
              <p className="text-[12px] font-medium text-secondary">Published application folder</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <code className="rounded bg-[var(--z1-bg)] px-2 py-1 text-[11px] text-secondary">{publication.directory}</code>
                <Button
                  variant="quiet"
                  onClick={() => {
                    void navigator.clipboard?.writeText(publication.directory ?? "");
                    setActionMessage({ type: "success", text: "Published folder path copied." });
                  }}
                >
                  Copy path
                </Button>
              </div>
            </div>
          )}
          {publication?.status === "FAILED" && (
            <div className="mt-4 rounded-[12px] bg-[var(--pill-amber-bg)] p-3">
              <p className="text-[12px] font-semibold text-[var(--pill-amber-fg)]">Resume approved, but not copied to the applications folder</p>
              <p className="mt-1 text-[11.5px] text-secondary">{publication.error ?? "Publication did not complete."} The downloads above are still available.</p>
            </div>
          )}

          <div className="mt-4 border-t border-[color-mix(in_oklab,var(--accent)_18%,transparent)] pt-3">
            <Button variant="quiet" state={actionBusy ? "loading" : "idle"} loadingLabel="Starting…" onClick={handleReTailor} disabled={actionBusy}>
              Re-tailor resume
            </Button>
            <p className="mt-1 text-[11.5px] leading-relaxed text-tertiary">
              Creates a new tailored version alongside this one. Your current ready resume stays available until the new version passes review.
            </p>
          </div>
        </div>
      )}

      {/* Safe best attempt — every truthfulness/safety guardrail passed; the optimisation bar did
       *  not. Never styled as success and never as failure. */}
      {isSafeBestAttempt && finalDisposition && (
        <div className="rounded-[20px] border border-[color-mix(in_oklab,var(--attention-fg)_25%,var(--border))] bg-[var(--attention-bg)] p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-[14px] font-semibold text-[var(--attention-fg)]">Ready for your review</h3>
              <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-secondary">
                This resume passed every truthfulness and safety check but did not clear the full quality bar. Review it, then decide for
                yourself — Career-Ops never submits an application.
              </p>
            </div>
            <div className="shrink-0 text-right text-[12px] text-tertiary">
              Iteration {finalDisposition.selectedIterationNumber} of {workflow?.max_iterations}
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-secondary">
            <span>Safety <strong className={finalDisposition.safety.safe ? "text-[var(--pill-success-fg)]" : "text-[var(--error)]"}>{finalDisposition.safety.safe ? "Passed" : "Not passed"}</strong></span>
            <span>Blocking issues <strong className="text-primary">{finalDisposition.safety.blockers.length}</strong></span>
            <span>Application by hand <strong className="text-primary">{finalDisposition.humanMaySend ? "Allowed after review" : "Not allowed"}</strong></span>
          </div>

          {finalDisposition.optimizationFindings.length > 0 && (
            <div className="mt-3 rounded-[12px] bg-[color-mix(in_oklab,var(--z0-bg)_60%,transparent)] p-3">
              <p className="text-[12px] font-semibold text-primary">Remaining findings — none is a truthfulness blocker</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[12px] text-secondary">
                {finalDisposition.optimizationFindings.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {safeSelectedIteration !== null && (
            <div className="mt-3 flex flex-wrap gap-2">
              <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/resume?iteration=${safeSelectedIteration}`} className={BTN_SECONDARY}>
                Download resume
              </a>
              <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/coverLetter?iteration=${safeSelectedIteration}`} className={BTN_SECONDARY}>
                Download cover letter
              </a>
            </div>
          )}

          <div className="mt-3">
            {isApprovedForCurrentWorkflow ? (
              <div className="rounded-[12px] bg-[var(--pill-success-bg)] p-3">
                <p className="text-[12.5px] font-semibold text-[var(--pill-success-fg)]">Human approved</p>
                <p className="mt-1 text-[11.5px] text-secondary">
                  Score: {humanApproval?.overallScore ?? "—"} · Reviewed:{" "}
                  {humanApproval ? new Date(humanApproval.approvedAt).toLocaleString() : "—"}. This resume is eligible for applications.
                </p>
                {canContinueToApplication && (
                  <Link href={applicationHref} className="mt-2 inline-flex text-[12.5px] font-semibold text-[var(--accent)] underline-offset-2 hover:underline">
                    Continue to application →
                  </Link>
                )}
              </div>
            ) : (
              <Button variant="attention" state={actionBusy ? "loading" : "idle"} loadingLabel="Approving…" onClick={handleApprove} disabled={actionBusy}>
                Approve & Use for Applications
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Blocked — a genuine, unresolved safety/truthfulness blocker. The only case that must never
       *  offer downloads of the primary package (a best-attempt package for manual review is still
       *  reachable, further down in the disclosure/legacy section). */}
      {isBlockedUnsafe && finalDisposition && (
        <div className="rounded-[20px] border border-[color-mix(in_oklab,var(--error)_25%,var(--border))] bg-[color-mix(in_oklab,var(--error)_6%,var(--z3-bg))] p-4 sm:p-5">
          <h3 className="text-[14px] font-semibold text-[var(--error)]">Needs your attention</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-secondary">
            This package has {finalDisposition.safety.blockers.length} unresolved safety blocker{finalDisposition.safety.blockers.length === 1 ? "" : "s"}. It must
            not be sent, and no download is offered for it.
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[12px] text-secondary">
            {finalDisposition.safety.blockers.slice(0, 10).map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Writer status — shown only while the writer genuinely owns the next step. */}
      {data.waitingFor === "EXTERNAL_WRITER" && writer && (
        <div
          className={`rounded-[18px] border p-4 ${
            writer.state === "PROCESSING"
              ? "border-[var(--border)] bg-[var(--tile-blue-bg)]"
              : writer.state === "TECHNICAL_FAILURE" || writer.state === "BLOCKED_MAX_ATTEMPTS"
                ? "border-[color-mix(in_oklab,var(--error)_20%,var(--border))] bg-[color-mix(in_oklab,var(--error)_6%,var(--z3-bg))]"
                : "border-[color-mix(in_oklab,var(--attention-fg)_20%,var(--border))] bg-[var(--attention-bg)]"
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-[13.5px] font-semibold text-primary">
                {workflow?.status === "CREATED" ? "Approved — awaiting first draft" : "Corrections required — awaiting next draft"}
              </h3>
              <p className="mt-0.5 text-[12px] text-secondary">
                {WRITER_STATE_LABEL[writer.state] ?? writer.state}: {writer.detail}
              </p>
            </div>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${writer.writerEnabled ? "bg-[var(--pill-success-bg)] text-[var(--pill-success-fg)]" : "bg-[var(--z1-bg)] text-tertiary"}`}>
              Resume writer {writer.writerEnabled ? "on" : "off"}
            </span>
          </div>

          {writer.state === "UNAVAILABLE_SCHEDULER_DISABLED" && (
            <p className="mt-2 text-[12px] font-medium text-[var(--attention-fg)]">
              This job is approved and queued, but nothing will write it until background automation is enabled in Settings.
            </p>
          )}
          {writer.state === "CANDIDATE_CONTACT_REQUIRED" && (
            <p className="mt-2 text-[12px] font-medium text-[var(--attention-fg)]">
              This is a configuration issue, not a resume problem —{" "}
              <a href={`/candidates/${candidateId}/settings`} className="underline">add your contact details</a> and this job resumes
              automatically on the next scheduled pass.
            </p>
          )}
          {(writer.state === "TECHNICAL_FAILURE" || WRITER_OPERATOR_ACTION_STATES.has(writer.state)) && writer.state !== "CANDIDATE_CONTACT_REQUIRED" && (
            <p className="mt-2 text-[12px] font-medium text-[var(--error)]">
              {writer.state === "SUBSCRIPTION_LIMIT_REACHED"
                ? "Your Claude subscription usage limit is exhausted, so the writer is waiting rather than retrying."
                : writer.state === "AUTH_REQUIRED"
                  ? "The Claude CLI is not signed in on this Mac, so nothing can be written."
                  : writer.state === "UNAUTHORIZED_APPROVAL_STALE"
                    ? "The tailoring approval recorded for this job no longer matches its current match decision."
                    : "No resume was produced and no quality iteration was consumed."}
            </p>
          )}
          {WRITER_OPERATOR_ACTION_STATES.has(writer.state) && writer.state !== "UNAUTHORIZED_APPROVAL_STALE" && (
            <div className="mt-2">
              <Button variant="secondary" state={actionBusy ? "loading" : "idle"} loadingLabel="Retrying…" onClick={handleRetryWriter} disabled={actionBusy}>
                Retry writer
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Mobile sticky primary action — only when a real, genuine action exists (never while
       *  tailoring is simply processing, per Part 20). The wrapper itself is absent, not just
       *  visually empty, whenever stickyAction is null — see its computation above for why that
       *  matters. Fixed above MobileBottomNav using the same safe-area/height convention AppShell's
       *  own content padding already uses, so it never overlaps the nav or gets clipped by it.
       *  Desktop/laptop never shows this — the same action is already inline above. */}
      {stickyAction && (
        <div className="fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 border-t border-[var(--border)] bg-[var(--z3-bg)] p-3 shadow-[var(--shadow-hero)] lg:hidden">
          {stickyAction}
        </div>
      )}

      <DiagnosticsPanel
        variant={variant}
        data={data}
        workflow={workflow}
        bestAttempt={bestAttempt}
        writer={writer}
        iterationBudget={iterationBudget}
        displayedReview={displayedReview}
        iterations={iterations}
        activeIterNum={activeIterNum}
        candidateId={candidateId}
        jobId={jobId}
        actionBusy={actionBusy}
        onSelectIteration={setSelectedIterationNumber}
        onExportPackage={handleExportPackage}
        onFileUpload={handleFileUpload}
        fileInputRef={fileInputRef}
        isSafeBestAttempt={isSafeBestAttempt}
      />

      {previewing && candidateId !== null && (
        <ResumePreview
          candidateId={candidateId}
          jobId={jobId}
          company={companyName}
          role={jobTitle}
          hasCoverLetter={availableArtifacts.hasFinalCoverLetter || availableArtifacts.hasIterationCoverLetter}
          downloadHref={(doc) => `/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/${doc}`}
          onClose={() => setPreviewing(false)}
        />
      )}
    </div>
  );
}

/**
 * Everything below the primary journey — real diagnostics, real actions, never deleted, just moved
 * behind ONE "Technical details" disclosure (Part 15). In `variant="technical"` this renders
 * unwrapped (no second nested disclosure), since JobWorkspace's own Validation-step disclosure is
 * already what a person opened to reach it.
 */
function DiagnosticsPanel({
  variant,
  data,
  workflow,
  bestAttempt,
  writer,
  iterationBudget,
  displayedReview,
  iterations,
  activeIterNum,
  candidateId,
  jobId,
  actionBusy,
  onSelectIteration,
  onExportPackage,
  onFileUpload,
  fileInputRef,
  isSafeBestAttempt,
}: {
  variant: "journey" | "technical";
  data: QualityWorkflowResponse;
  workflow: QualityWorkflowResponse["workflow"];
  bestAttempt: QualityWorkflowResponse["bestAttempt"];
  writer: QualityWorkflowResponse["writer"];
  iterationBudget: QualityWorkflowResponse["iterationBudget"];
  displayedReview: StructuredResumeReview | null;
  iterations: QualityWorkflowResponse["iterations"];
  activeIterNum: number;
  candidateId: number | null;
  jobId: number;
  actionBusy: boolean;
  onSelectIteration: (n: number) => void;
  onExportPackage: () => void;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  isSafeBestAttempt: boolean;
}) {
  const content = (
    <div className="flex flex-col gap-4">
      {/* Legacy FAILED detail — retained for the diagnostic best-attempt scores and downloads. */}
      {workflow?.status === "FAILED" && !isSafeBestAttempt && (
        <div className="rounded-[14px] border border-[color-mix(in_oklab,var(--error)_20%,var(--border))] bg-[color-mix(in_oklab,var(--error)_5%,var(--z3-bg))] p-3.5">
          <h4 className="text-[12.5px] font-semibold text-primary">Human review required</h4>
          <p className="mt-1 text-[12px] text-secondary">
            {workflow.max_iterations} automatic quality attempt{workflow.max_iterations === 1 ? "" : "s"} completed.{" "}
            {workflow.failure_reason ?? "Max improvement iterations reached without meeting quality threshold."}
          </p>
          {(data.candidateRepairQuestions?.length ?? 0) > 0 && (
            <div className="mt-2 rounded-[10px] bg-[var(--z1-bg)] p-2.5">
              <p className="text-[11.5px] font-semibold text-primary">Candidate evidence questions</p>
              <ul className="mt-1.5 space-y-2 text-[11.5px] text-secondary">
                {data.candidateRepairQuestions?.map((item) => (
                  <li key={item.findingKey}>
                    <p>{item.question}</p>
                    <p className="mt-0.5 text-tertiary">Choices: {item.choices.join(" · ")}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {bestAttempt && (
            <div className="mt-2 rounded-[10px] bg-[var(--z1-bg)] p-2.5">
              <p className="text-[11.5px] font-semibold text-primary">Best attempt: iteration {bestAttempt.iterationNumber}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-secondary sm:grid-cols-4">
                <div><dt className="text-tertiary">Overall</dt><dd className="font-medium text-primary">{bestAttempt.overallScore}</dd></div>
                <div><dt className="text-tertiary">ATS match</dt><dd className="font-medium text-primary">{bestAttempt.atsScore}</dd></div>
                <div><dt className="text-tertiary">Truthfulness</dt><dd className="font-medium text-primary">{bestAttempt.truthfulnessScore}</dd></div>
                <div><dt className="text-tertiary">Architecture</dt><dd className="font-medium text-primary">{bestAttempt.architectureConsistencyScore}</dd></div>
              </dl>
              <p className="mt-2 text-[11.5px] text-secondary">
                Instruction compliance: {bestAttempt.instructionCompliancePassCount}/{bestAttempt.instructionComplianceTotal} pass
              </p>
              {bestAttempt.failingChecks.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11.5px] text-secondary">
                  {bestAttempt.failingChecks.map((name) => (
                    <li key={name}>{humanizeCheckName(name)}</li>
                  ))}
                </ul>
              )}
              {/* UI-5.1 checkpoint fix: this block only ever renders when isSafeBestAttempt is false
               *  for a FAILED workflow — i.e. exactly the BLOCKED case the primary surface already
               *  tells the candidate "no download is offered for it" (a genuine, unresolved safety
               *  blocker). The resume/cover-letter download links previously here served that same
               *  disposition-unaware artifact route with no safety check, directly contradicting that
               *  promise one click away. Diagnostic-only artifacts (the review record, the failed-
               *  check list) stay — neither is the sendable document itself. */}
              <div className="mt-2 flex flex-wrap gap-2">
                <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/review`} download className="text-[11.5px] font-medium text-[var(--accent)] underline-offset-2 hover:underline">
                  View review
                </a>
                <a href={`/api/candidates/${candidateId}/jobs/${jobId}/quality-workflow/artifacts/feedback`} download className="text-[11.5px] font-medium text-[var(--accent)] underline-offset-2 hover:underline">
                  View failed checks
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Writer scheduler/queue detail. */}
      {data.waitingFor === "EXTERNAL_WRITER" && writer && (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--z1-bg)] p-3.5">
          <p className="text-[11.5px] font-semibold uppercase tracking-wide text-tertiary">Writer schedule</p>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] text-secondary sm:grid-cols-4">
            {writer.processingSince && <div><dt className="text-tertiary">Started</dt><dd className="font-medium text-primary">{new Date(writer.processingSince).toLocaleString()}</dd></div>}
            {writer.nextAttemptAt && <div><dt className="text-tertiary">Next attempt</dt><dd className="font-medium text-primary">{new Date(writer.nextAttemptAt).toLocaleString()}</dd></div>}
            {writer.lastPassCompletedAt && <div><dt className="text-tertiary">Last pass</dt><dd className="font-medium text-primary">{new Date(writer.lastPassCompletedAt).toLocaleString()}</dd></div>}
            <div><dt className="text-tertiary">Queue</dt><dd className="font-medium text-primary">{writer.pendingWorkflowCount} awaiting · {writer.batchSize} per pass</dd></div>
            <div><dt className="text-tertiary">Cadence</dt><dd className="font-medium text-primary">every {writer.intervalMinutes} min</dd></div>
            {iterationBudget && <div><dt className="text-tertiary">Writer attempt</dt><dd className="font-medium text-primary">{iterationBudget.targetIteration} of {iterationBudget.max} ({iterationBudget.writerAttemptsRemaining} remaining)</dd></div>}
          </dl>
          {writer.workflowOutcome && (
            <p className="mt-1.5 text-[11.5px] text-secondary">
              Last outcome: <strong className="text-primary">{writer.workflowOutcome.outcome.replace(/_/g, " ")}</strong>
              {writer.workflowOutcome.error ? ` — ${writer.workflowOutcome.error}` : ""}
            </p>
          )}
        </div>
      )}

      {/* Manual writer handoff — a power-user fallback, not the normal path since the scheduled
       *  writer now does this automatically. */}
      {data.waitingFor === "EXTERNAL_WRITER" && (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--z1-bg)] p-3.5">
          <h4 className="text-[12.5px] font-semibold text-primary">Manual writer handoff (optional)</h4>
          <p className="mt-1 text-[11.5px] text-secondary">
            Target iteration {(workflow?.current_iteration ?? 0) + 1} of {workflow?.max_iterations ?? 0} — only needed to write this draft
            yourself with an external agent instead of waiting for the scheduled writer.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="secondary" state={actionBusy ? "loading" : "idle"} loadingLabel="Exporting…" onClick={onExportPackage} disabled={actionBusy}>
              Export writer package
            </Button>
            <input type="file" ref={fileInputRef} accept=".json" onChange={onFileUpload} className="hidden" id="writer-output-upload" />
            <label
              htmlFor="writer-output-upload"
              className={`candidate-control inline-flex h-[42px] cursor-pointer items-center rounded-[10px] border border-[var(--border)] bg-[var(--z3-bg)] px-4 text-[13px] font-medium text-secondary hover:bg-[var(--surface-hover)] ${actionBusy ? "pointer-events-none opacity-50" : ""}`}
            >
              {actionBusy ? "Processing import…" : "Import writer_output.json"}
            </label>
          </div>
        </div>
      )}

      {/* Quality score + sub-scores + canonical compliance + reviewer diagnostics. */}
      {displayedReview && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="flex flex-col justify-between rounded-[14px] border border-[var(--border)] bg-[var(--z1-bg)] p-3.5">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-tertiary">Overall quality score</div>
              <div className="mt-1.5 flex items-baseline gap-1.5">
                <span className="text-[26px] font-bold text-primary">{displayedReview.overallScore}</span>
                <span className="text-[13px] font-semibold text-tertiary">/ 100</span>
              </div>
            </div>
            <div className="mt-3 border-t border-[var(--separator)] pt-2.5 text-[11.5px]">
              <div className="mb-1 font-medium text-secondary">Quality gate</div>
              {reviewPassesStrengthenedGate(displayedReview) ? (
                <span className="font-semibold text-[var(--pill-success-fg)]">Passed</span>
              ) : (
                <span className="font-semibold text-[var(--attention-fg)]">Needs improvement</span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2.5 rounded-[14px] border border-[var(--border)] bg-[var(--z1-bg)] p-3.5 md:col-span-2">
            <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary">Deterministic review components</div>
            <ScoreBar label="ATS keyword alignment" score={displayedReview.atsScore} target={90} />
            <ScoreBar label="Truthfulness / master consistency" score={displayedReview.truthfulnessScore} target={100} />
            <ScoreBar label="Architecture consistency" score={displayedReview.architectureConsistencyScore} target={100} />
            <ScoreBar label="Recruiter readability" score={displayedReview.recruiterReadabilityScore} target={85} />
            <ScoreBar label="Document formatting" score={displayedReview.formattingScore} target={95} />
          </div>
        </div>
      )}

      {displayedReview?.instructionCompliance && (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--z1-bg)] p-3.5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">Canonical instruction compliance</div>
            <span className="text-[11px] text-tertiary">
              Standard v{displayedReview.instructionCompliance.instructionVersion}
              {data.qualityGate?.instructionCompliance && !data.qualityGate.instructionCompliance.isCurrent && (
                <span className="ml-1 font-semibold text-[var(--attention-fg)]">(stale — re-review required)</span>
              )}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px] sm:grid-cols-3">
            {Object.entries(displayedReview.instructionCompliance.checks).map(([name, status]) => (
              <div key={name} className="flex items-center gap-1.5">
                <span className={status === "PASS" ? "text-[var(--pill-success-fg)]" : status === "FAIL" ? "text-[var(--error)]" : status === "NOT_APPLICABLE" ? "text-tertiary" : "text-[var(--attention-fg)]"}>
                  {status === "PASS" ? "✓" : status === "FAIL" ? "✗" : status === "NOT_APPLICABLE" ? "–" : "⚠"}
                </span>
                <span className="text-secondary">{name.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}</span>
              </div>
            ))}
          </div>
          {displayedReview.instructionCompliance.notes.length > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 border-t border-[var(--separator)] pl-4 pt-2 text-[11.5px] text-secondary">
              {displayedReview.instructionCompliance.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {displayedReview && (
        <div className="flex flex-col gap-3">
          {displayedReview.blockingIssues.length > 0 && (
            <div className="rounded-[12px] bg-[var(--pill-red-bg)] p-3">
              <h4 className="mb-1.5 text-[11.5px] font-semibold text-[var(--pill-red-fg)]">Blocking issues ({displayedReview.blockingIssues.length})</h4>
              <ul className="list-disc space-y-1 pl-4 text-[11.5px] text-[var(--pill-red-fg)]">
                {displayedReview.blockingIssues.map((issue, i) => <li key={i}>{issue}</li>)}
              </ul>
            </div>
          )}
          {displayedReview.requiredCorrections && displayedReview.requiredCorrections.length > 0 && (
            <div>
              <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
                Required corrections ({displayedReview.requiredCorrections.length})
              </h4>
              <div className="flex flex-col gap-1.5">
                {displayedReview.requiredCorrections.map((corr: RequiredCorrection, i: number) => (
                  <div key={i} className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] bg-[var(--z3-bg)] p-2.5 text-[11.5px]">
                    <PriorityBadge priority={corr.priority} />
                    <p className="flex-1 text-secondary">{corr.description}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 gap-2.5 text-[11.5px] md:grid-cols-2">
            {displayedReview.missingRequiredSkills.length > 0 && (
              <div className="rounded-[10px] border border-[var(--border)] p-2.5">
                <div className="mb-1.5 font-medium text-secondary">Missing required skills</div>
                <div className="flex flex-wrap gap-1">
                  {displayedReview.missingRequiredSkills.map((s, i) => (
                    <span key={i} className="rounded bg-[var(--pill-red-bg)] px-2 py-0.5 text-[var(--pill-red-fg)]">{s}</span>
                  ))}
                </div>
              </div>
            )}
            {displayedReview.truthfulnessIssues.length > 0 && (
              <div className="rounded-[10px] border border-[var(--border)] p-2.5">
                <div className="mb-1.5 font-medium text-secondary">Truthfulness diagnostics</div>
                <ul className="list-disc space-y-0.5 pl-4 text-secondary">
                  {displayedReview.truthfulnessIssues.map((t, i) => <li key={i}>{t}</li>)}
                </ul>
              </div>
            )}
            {displayedReview.incorrectTechnologyUsage.length > 0 && (
              <div className="rounded-[10px] border border-[var(--border)] p-2.5">
                <div className="mb-1.5 font-medium text-secondary">Technology usage warnings</div>
                <ul className="list-disc space-y-0.5 pl-4 text-secondary">
                  {displayedReview.incorrectTechnologyUsage.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </div>
            )}
            {displayedReview.genericBullets.length > 0 && (
              <div className="rounded-[10px] border border-[var(--border)] p-2.5">
                <div className="mb-1.5 font-medium text-secondary">Generic / weak bullets</div>
                <p className="text-tertiary">{displayedReview.genericBullets.length} bullet(s) flagged for generic phrasing.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {iterations.length > 0 && (
        <div className="border-t border-[var(--separator)] pt-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-tertiary">Iteration history</div>
          <div className="flex flex-wrap gap-2">
            {iterations.map((iter) => {
              const isSelected = iter.iteration_number === activeIterNum;
              const isReady = iter.overall_score !== null && iter.overall_score >= 95 && iter.blocking_issue_count === 0;
              const isBestAttempt = bestAttempt?.iterationNumber === iter.iteration_number;
              return (
                <button
                  key={iter.id}
                  onClick={() => onSelectIteration(iter.iteration_number)}
                  className={`rounded-[9px] border px-3 py-1.5 text-[11.5px] font-medium transition-colors duration-150 ease-out ${
                    isSelected ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] bg-[var(--z3-bg)] text-secondary hover:bg-[var(--surface-hover)]"
                  }`}
                >
                  Iteration {iter.iteration_number} — {iter.overall_score ?? "—"}/100
                  {isReady && " ✓"}
                  {isBestAttempt && <span className="ml-1.5 rounded bg-[var(--pill-amber-bg)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--pill-amber-fg)]">Best attempt</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  if (variant === "technical") return content;

  return (
    <Disclosure title="Technical details" hint={workflow ? `Iteration ${workflow.current_iteration} of ${workflow.max_iterations}` : undefined}>
      {content}
    </Disclosure>
  );
}
