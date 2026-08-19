import { getAppSettings } from "@/db/queries/settings";
import { listCandidates } from "@/db/queries/candidates";
import { isEnabled, isIntervalDue, isWithinWindow } from "@/lib/scheduler/window";
import { getDb } from "@/db";
import { runAutomaticJobEvaluation, type AutomaticEvaluationResult } from "./autoEvaluate";

/**
 * Stage 24A — bounded scheduled job-match evaluation. Deliberately its OWN tick, never folded into
 * runProductionCycle() (Stage 20/23): that orchestrator has an explicit, tested guarantee of zero
 * matching/lifecycle/notification side effects (orchestrator.test.ts's own "Zero lifecycle
 * maintenance / matching / notification side effects" case) — adding evaluation there would break a
 * deliberate architectural boundary, not extend it. Ingestion (Stage 20) decides what jobs exist;
 * this tick decides which of them deserve a candidate's attention; Stage 21 decides how a resume
 * gets tailored for the ones a human picks — three responsibilities, three independently-cadenced
 * ticks, one shared instrumentation.ts timer (see that file's Stage 24A addition) — not a second
 * scheduling framework.
 */
export const JOB_EVALUATION_BATCH_SIZE_PER_CANDIDATE = 200;

// Independent of both scheduler.intervalMinutes (old scan tick) and PRODUCTION_CYCLE_INTERVAL_MINUTES
// (Stage 23's ingestion tick) — evaluation is synchronous/cheap/zero-cost (no AI, see
// evaluateJobMatch's own doc comment), so it can afford a short, frequent cadence without risking
// runaway cost or duration; 5 minutes keeps a real production-scale backlog (observed: ~19k rows for
// one candidate before Stage 24A's fix) draining steadily without competing for CPU with the
// ingestion tick's own real network-bound work.
export const JOB_EVALUATION_INTERVAL_MINUTES = 5;

const LAST_STARTED_KEY = "job_evaluation_tick.last_started_at";

function getLastStartedAt(): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(LAST_STARTED_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function recordStarted(now: Date): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(LAST_STARTED_KEY, now.toISOString());
}

export type JobEvaluationTickOutcome =
  | { outcome: "SKIPPED_DISABLED" }
  | { outcome: "SKIPPED_OUTSIDE_WINDOW" }
  | { outcome: "SKIPPED_INTERVAL_NOT_DUE" }
  | { outcome: "SKIPPED_NO_CANDIDATES" }
  | { outcome: "RAN"; perCandidate: AutomaticEvaluationResult[] };

/**
 * One scheduled evaluation tick, across every active candidate. Reuses the SAME automation
 * window/timezone/enabled settings as the scan scheduler and the Stage 23 production-cycle tick
 * (settings.scheduler) — the one place an operator already configures "when is background
 * automation allowed to run". Never throws — matches runSchedulerTick/runProductionCycleTick's own
 * contract; runAutomaticJobEvaluation itself already isolates one job's failure from the rest of its
 * batch, and one candidate's batch failing (it cannot — see that function's own try/catch per job)
 * would still never block a different candidate's batch here.
 */
export async function runJobEvaluationTick(now: Date = new Date()): Promise<JobEvaluationTickOutcome> {
  const settings = getAppSettings();
  // Stage 27 — master kill switch, then this tick's own switch (see settings.ts schedulerSchema).
  if (!isEnabled(settings.scheduler) || !settings.scheduler.evaluationEnabled) {
    return { outcome: "SKIPPED_DISABLED" };
  }
  if (!isWithinWindow(now, settings.scheduler)) {
    return { outcome: "SKIPPED_OUTSIDE_WINDOW" };
  }

  if (!isIntervalDue(getLastStartedAt(), JOB_EVALUATION_INTERVAL_MINUTES, now)) {
    return { outcome: "SKIPPED_INTERVAL_NOT_DUE" };
  }

  const candidates = listCandidates();
  if (candidates.length === 0) {
    return { outcome: "SKIPPED_NO_CANDIDATES" };
  }

  recordStarted(now);
  const perCandidate: AutomaticEvaluationResult[] = [];
  for (const candidate of candidates) {
    perCandidate.push(runAutomaticJobEvaluation(candidate.id, JOB_EVALUATION_BATCH_SIZE_PER_CANDIDATE));
  }
  return { outcome: "RAN", perCandidate };
}
