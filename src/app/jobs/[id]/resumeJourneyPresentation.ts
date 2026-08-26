import { presentDisposition } from "@/lib/resumeQuality/dispositionPresentation";
import type { FinalDisposition } from "@/lib/resumeQuality/finalDisposition";

/**
 * UI-5 — the ONE presentation-layer mapping from the resume workflow's real engine state to the
 * candidate-facing journey. A pure function, like resumeStage.ts and dispositionPresentation.ts
 * beside it (reused here, not reimplemented) — it re-decides nothing, interpolates nothing, and
 * advances nothing on a timer. Every field it reads already exists on the response
 * ResumeQualityPipeline fetches; this adds no request.
 *
 * WHY FOUR STAGES, NOT FIVE. The approved design language describes five conceptual beats
 * (Understanding the job / Building strategy / Tailoring your experience / Checking quality /
 * Finalizing). The first two are already their own real, separately-truthful steps in the outer
 * Job Workspace (MatchStep, ResumeStudioStep) — this module is specifically the presentation for
 * the resume-GENERATION pipeline itself, which the engine only ever reports as four real phases:
 * Writer → Review → Improvement → Ready. Splitting "understanding the job" and "building strategy"
 * out of the Writer phase as two more stage-rail nodes would be inventing progress the engine does
 * not expose — the writer performs both in one atomic pass. So this rail has four nodes, labelled to
 * read as a journey, each backed by a real, observable status transition.
 */

export type JourneyStageKey = "tailoring" | "checking_quality" | "finalizing" | "ready";

export type JourneyStepState = "completed" | "current" | "upcoming" | "attention";

export interface JourneyStage {
  key: JourneyStageKey;
  label: string;
  state: JourneyStepState;
}

export type JourneyTone = "progress" | "attention" | "review" | "ready";

export interface ResumeJourneyPresentation {
  /** Null only when no workflow exists yet — there is no journey to show. */
  stages: JourneyStage[] | null;
  currentStageKey: JourneyStageKey | null;
  headline: string;
  explanation: string;
  tone: JourneyTone;
  /** True only when the engine says a package may actually be downloaded — mirrors
   *  presentDisposition().offerDownloads exactly; never derived independently. */
  offerDownloads: boolean;
  /** True only for a genuine, terminal safety failure — never for "still working". */
  isBlocked: boolean;
  /** A truthful safe-best-attempt is neither ready nor a plain failure — see dispositionPresentation. */
  isSafeBestAttempt: boolean;
  blockingReason: string | null;
}

const STAGE_ORDER: { key: JourneyStageKey; label: string }[] = [
  { key: "tailoring", label: "Tailoring your resume" },
  { key: "checking_quality", label: "Checking quality" },
  { key: "finalizing", label: "Finalizing" },
  { key: "ready", label: "Ready" },
];

const STAGE_EXPLANATION: Record<JourneyStageKey, string> = {
  tailoring: "Reading the role and drafting your resume from your verified experience and skills.",
  checking_quality: "Checking alignment, factual consistency and resume quality.",
  finalizing: "Refining the resume based on the quality check before a final pass.",
  ready: "Passed every stage of tailoring and quality review.",
};

function stagesUpTo(currentIndex: number, attentionAt?: number): JourneyStage[] {
  return STAGE_ORDER.map((s, i) => ({
    key: s.key,
    label: s.label,
    state:
      attentionAt !== undefined && i === attentionAt
        ? "attention"
        : i < currentIndex
          ? "completed"
          : i === currentIndex
            ? "current"
            : "upcoming",
  }));
}

/**
 * @param status Raw workflow.status, or null if no workflow exists.
 * @param waitingFor The response's own waitingFor field.
 * @param disposition Stage 28's finalDisposition.disposition, or null.
 * @param blockingReason The first real blocking reason the engine reported, if any (never invented
 *   here — pass qualityGate.blockingIssues[0] or finalDisposition.safety.blockers[0]).
 */
export function presentResumeJourney(input: {
  status: string | null;
  waitingFor: string | null;
  disposition: FinalDisposition | null;
  blockingReason: string | null;
}): ResumeJourneyPresentation {
  const { status, waitingFor, disposition, blockingReason } = input;

  if (!status) {
    return {
      stages: null,
      currentStageKey: null,
      headline: "Tailoring hasn't started",
      explanation: "Approve this job for tailoring to begin.",
      tone: "progress",
      offerDownloads: false,
      isBlocked: false,
      isSafeBestAttempt: false,
      blockingReason: null,
    };
  }

  // Reuses the same authority ResumeQualityPipeline/ValidationStep already read from, rather than
  // re-deriving READY/SAFE_BEST_ATTEMPT/BLOCKED from the raw status a second way.
  const presentation = presentDisposition({ workflowStatus: status, disposition });
  const isSafeBestAttempt = presentation.tone === "REVIEW" && disposition === "SAFE_BEST_ATTEMPT";

  if (status === "READY" && !isSafeBestAttempt) {
    return {
      stages: stagesUpTo(4),
      currentStageKey: "ready",
      headline: "Your resume is ready",
      explanation: STAGE_EXPLANATION.ready,
      tone: "ready",
      offerDownloads: presentation.offerDownloads,
      isBlocked: false,
      isSafeBestAttempt: false,
      blockingReason: null,
    };
  }

  if (isSafeBestAttempt) {
    return {
      // Reached the end of the pipeline with usable output, but it genuinely requires the
      // candidate's own review before use — so the Ready node itself carries "attention" (the one
      // state that means "needs a real user action"), never "current" (nothing is still running)
      // and never plain "completed" (it isn't actually ready). currentStageKey must point at the
      // same node stagesUpTo marks non-upcoming, or aria-current lands on a different <li> than the
      // one styled as active — a real mismatch this fixes.
      stages: stagesUpTo(3, 3),
      currentStageKey: "ready",
      headline: "Ready for your review",
      explanation:
        "This resume passed every truthfulness and safety check but did not clear the full quality bar. Review it and decide whether to use it.",
      tone: "review",
      offerDownloads: presentation.offerDownloads,
      isBlocked: false,
      isSafeBestAttempt: true,
      blockingReason: null,
    };
  }

  if (status === "FAILED") {
    // A genuine safety blocker — presentDisposition already refuses downloads for this case.
    return {
      stages: stagesUpTo(2, 2),
      currentStageKey: "finalizing",
      headline: "Needs your attention",
      explanation: blockingReason ?? "This attempt did not produce a safe resume to send.",
      tone: "attention",
      offerDownloads: false,
      isBlocked: true,
      isSafeBestAttempt: false,
      blockingReason: blockingReason ?? null,
    };
  }

  if (status === "IMPROVEMENT_RUNNING") {
    return {
      stages: stagesUpTo(2),
      currentStageKey: "finalizing",
      headline: "Finalizing",
      explanation: STAGE_EXPLANATION.finalizing,
      tone: "progress",
      offerDownloads: false,
      isBlocked: false,
      isSafeBestAttempt: false,
      blockingReason: null,
    };
  }

  if (status === "REVIEW_RUNNING" || status === "REVIEW_COMPLETED") {
    return {
      stages: stagesUpTo(1),
      currentStageKey: "checking_quality",
      headline: "Checking quality",
      explanation: STAGE_EXPLANATION.checking_quality,
      tone: "progress",
      offerDownloads: false,
      isBlocked: false,
      isSafeBestAttempt: false,
      blockingReason: null,
    };
  }

  // CREATED | WRITER_RUNNING | WRITER_COMPLETED — including CREATED, which means "approved,
  // waiting for the writer's first draft" (see resumeStage.ts), never "nothing has happened".
  return {
    stages: stagesUpTo(0),
    currentStageKey: "tailoring",
    headline: waitingFor === "EXTERNAL_WRITER" ? "Awaiting the resume writer" : "Tailoring your resume",
    explanation: STAGE_EXPLANATION.tailoring,
    tone: "progress",
    offerDownloads: false,
    isBlocked: false,
    isSafeBestAttempt: false,
    blockingReason: null,
  };
}
