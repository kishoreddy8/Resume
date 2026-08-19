import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import {
  getApplicationLifecycleCounts,
  getCandidateMatchDecisionCounts,
  getConnectorHealthSummary,
  getGlobalResumePipelineCounts,
  getLatestScanActivity,
  getMatchingWindowSummary,
  getNotificationSummary,
  getRecentCandidateMatchRuns,
  getResumeQualitySummary,
  getScanningWindowSummary,
  getTotalNotificationsEverCreated,
  listRecentNotifications,
  listTopFailingConnectors,
  WINDOW_DAYS,
  type WindowKey,
} from "@/db/queries/operations";
import { getScanLockStatus } from "@/lib/scheduler/lock";
import { getSchedulerRuntimeState } from "@/lib/scheduler/state";
import { nextEligibleRunAt } from "@/lib/scheduler/window";
import { getResumeWriterHealth } from "@/lib/resumeQuality/writers/writerHealth";
import { getAppSettings } from "@/db/queries/settings";
import {
  classifyConnectorHealth,
  classifyMatchingHealth,
  classifyNotificationsHealth,
  classifyResumePipelineHealth,
  classifyScanningHealth,
  classifySchedulerHealth,
} from "@/lib/operations/healthRules";

/**
 * Phase 4 Stage 6 — GET /api/operations?candidateId=<id>&window=24h|7d|30d
 *
 * One coherent read-only endpoint, not a scatter of tiny per-widget routes — every section the
 * Operations dashboard needs is assembled here in a small, fixed number of SQL queries (see
 * src/db/queries/operations.ts; none of them load a full table into JS). READ ONLY: nothing in this
 * route, or anything it calls, writes to the database, calls an ATS provider, or triggers a
 * scan/match/rematch/notification/tailoring run.
 *
 * candidateId is required and validated via requireActiveCandidate — every candidate-scoped section
 * (matching.candidate, notifications, rematching, resumeQuality, applications) is threaded through
 * that one validated id, the same discipline every other candidate-scoped route in this app follows.
 * Global/operational sections (scheduler, scanning, connectors, matching.global) are NOT
 * candidate-scoped by nature — they describe the shared pipeline, not any one candidate's data.
 */

const RECENT_NOTIFICATIONS_LIMIT = 10;
const RECENT_MATCH_RUNS_LIMIT = 10;
const TOP_FAILING_CONNECTORS_LIMIT = 10;

function isWindowKey(value: string | null): value is WindowKey {
  return value === "24h" || value === "7d" || value === "30d";
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const candidateIdParam = params.get("candidateId");
  const candidateId = candidateIdParam === null ? NaN : Number(candidateIdParam);
  if (!Number.isInteger(candidateId)) {
    return NextResponse.json({ error: "candidateId is required and must be an integer" }, { status: 400 });
  }
  const candidate = requireActiveCandidate(candidateId);
  if (!candidate) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const windowParam = params.get("window");
  const window: WindowKey = windowParam === null ? "24h" : isWindowKey(windowParam) ? windowParam : ("" as WindowKey);
  if (windowParam !== null && !isWindowKey(windowParam)) {
    return NextResponse.json({ error: `window must be one of: 24h, 7d, 30d` }, { status: 400 });
  }
  const windowDays = WINDOW_DAYS[window];

  // --- Scheduler (Stage 1 state, read-only reuse — no second status calculation) ----------------
  const schedulerSettings = getAppSettings().scheduler;
  const schedulerRuntime = getSchedulerRuntimeState();
  const lock = getScanLockStatus();
  const schedulerHealth = classifySchedulerHealth({ settings: schedulerSettings, runtime: schedulerRuntime });

  // --- Scanning -----------------------------------------------------------------------------------
  const scanningWindow = getScanningWindowSummary(windowDays);
  const latestScan = getLatestScanActivity();
  const scanningHealth = classifyScanningHealth({
    window: { runs: scanningWindow.runs, successCount: scanningWindow.successCount, partialCount: scanningWindow.partialCount, failedCount: scanningWindow.failedCount },
    schedulerEnabled: schedulerSettings.enabled,
  });

  // --- Connectors -----------------------------------------------------------------------------------
  const connectorSummary = getConnectorHealthSummary();
  const topFailingConnectors = listTopFailingConnectors(TOP_FAILING_CONNECTORS_LIMIT);
  const connectorHealth = classifyConnectorHealth(connectorSummary);

  // --- Matching (global + this candidate's current decision counts) ------------------------------
  const matchingWindow = getMatchingWindowSummary(windowDays);
  const matchingHealth = classifyMatchingHealth({ runs: matchingWindow.runs, jobsErrored: matchingWindow.jobsErrored });
  const candidateDecisionCounts = getCandidateMatchDecisionCounts(candidateId);

  // --- Notifications (candidate-scoped) + global health signal -----------------------------------
  const notificationSummary = getNotificationSummary(candidateId, windowDays);
  const recentNotifications = listRecentNotifications(candidateId, RECENT_NOTIFICATIONS_LIMIT);
  const notificationsHealth = classifyNotificationsHealth(getTotalNotificationsEverCreated());

  // --- Candidate rematch (Stage 5) — provenance limitation, not inferred/guessed -----------------
  const recentCandidateMatchRuns = getRecentCandidateMatchRuns(candidateId, RECENT_MATCH_RUNS_LIMIT);

  // --- Resume / quality pipeline (candidate-scoped) + global health signal -----------------------
  const resumeQuality = getResumeQualitySummary(candidateId);
  const globalResumePipelineCounts = getGlobalResumePipelineCounts();
  const resumePipelineHealth = classifyResumePipelineHealth({ workflows: globalResumePipelineCounts.workflows, failed: globalResumePipelineCounts.failed });

  // --- Application lifecycle (candidate-scoped) ---------------------------------------------------
  const applications = getApplicationLifecycleCounts(candidateId);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    window,
    candidateId,
    overview: {
      scheduler: schedulerHealth,
      scanning: scanningHealth,
      connectors: connectorHealth,
      matching: matchingHealth,
      notifications: notificationsHealth,
      resumePipeline: resumePipelineHealth,
      lastActivity: latestScan?.startedAt ?? null,
      lastSuccessfulScheduledScan: schedulerRuntime.lastSuccessfulAt,
    },
    scheduler: {
      settings: schedulerSettings,
      runtime: schedulerRuntime,
      lock,
      nextEligibleRunAt: nextEligibleRunAt(schedulerSettings, schedulerRuntime.lastStartedAt),
      health: schedulerHealth,
    },
    // Stage 27 — the resume writer's own operational state, so an operator can see in one place
    // whether approved work is actually moving and, if it is not, exactly what is holding it up
    // (usage limit, sign-in, exhausted technical retries, stale approval, window, or simply nothing
    // queued). Read-only: this endpoint never starts, stops, or resets anything.
    resumeWriter: getResumeWriterHealth(),
    scanning: {
      window: scanningWindow,
      latest: latestScan,
      health: scanningHealth,
    },
    connectors: {
      summary: connectorSummary,
      topFailing: topFailingConnectors,
      health: connectorHealth,
    },
    matching: {
      global: { window: matchingWindow, health: matchingHealth },
      candidate: candidateDecisionCounts,
      cacheVisibility: {
        historicalCacheHitDataAvailable: false,
        note:
          "job_match_results/match_runs persist the current decision per job and per-page evaluation " +
          "counts, but not how many pairs were cache hits vs. freshly evaluated — that split (Stage 5's " +
          "resultsCreated/resultsReused) is only ever returned in-memory from a single rematch/scan call " +
          "and is never written to the database, so historical cache-hit rates cannot be shown here.",
      },
    },
    notifications: {
      candidate: notificationSummary,
      recent: recentNotifications,
      health: notificationsHealth,
    },
    rematching: {
      recentMatchRuns: recentCandidateMatchRuns,
      provenanceLimitation:
        "match_runs has no column distinguishing Stage 2's scan-triggered incremental matching from " +
        "Stage 5's candidate-profile/settings-triggered rematching — both write identically-shaped rows. " +
        "The runs above are genuinely scoped to this candidate, but individual rows cannot be attributed " +
        "to one trigger or the other.",
    },
    resumeQuality: {
      candidate: resumeQuality,
      health: resumePipelineHealth,
    },
    applications: {
      candidate: applications,
    },
  });
}
