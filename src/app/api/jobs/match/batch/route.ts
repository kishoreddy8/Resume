import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getMatchAffectingSettings } from "@/db/queries/candidateSettings";
import { getJob, listJobs } from "@/db/queries/jobs";
import { getJobMatchResult, insertJobMatchResult } from "@/db/queries/jobMatches";
import { insertMatchRun } from "@/db/queries/matchRuns";
import { buildEvaluateJobMatchInput } from "@/lib/match/buildMatchInput";
import { evaluateJobMatch } from "@/lib/match/evaluateJobMatch";
import type { JobWithCompany } from "@/types";

/**
 * Bounded, resumable, failure-isolated batch evaluation (Phase 2's approved batch design — mirrors
 * src/lib/scan.ts's per-company isolation). Deterministic only — zero AI, so no cost concern; the
 * bound exists purely to keep one request fast and to make DB writes observable per-run, not to
 * ration a paid resource. Never triggered automatically by scanning — always an explicit call.
 *
 * Phase 2.5: always exactly ONE candidate per batch call (candidateId required in the body) — never
 * a cross-candidate batch. Each of the 3-4 local candidates gets its own explicit batch call; see
 * CAREER_OPS_HANDOFF.md's Phase 2.5 design record §12/13 for why this stays fully synchronous and
 * in-request rather than introducing any queue/worker infrastructure.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const candidateId = typeof body?.candidateId === "number" ? body.candidateId : null;
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const requestedLimit = typeof body?.limit === "number" ? body.limit : DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(MAX_LIMIT, requestedLimit));

  let targets: JobWithCompany[];
  if (Array.isArray(body?.jobIds) && body.jobIds.every((v: unknown) => typeof v === "number")) {
    targets = (body.jobIds as number[])
      .slice(0, limit)
      .map((id) => getJob(id))
      .filter((j): j is JobWithCompany => Boolean(j));
  } else {
    targets = listJobs({ activeOnly: true }).slice(0, limit);
  }

  const candidateSettings = getMatchAffectingSettings(candidateId);
  const startedAt = new Date().toISOString();

  let blocked = 0;
  let needsReview = 0;
  let ready = 0;
  let errored = 0;
  const errorMessages: string[] = [];
  const outcomes: { jobId: number; status: string; decision?: string; reason?: string }[] = [];

  for (const job of targets) {
    try {
      const result = evaluateJobMatch(buildEvaluateJobMatchInput(job), candidateSettings, candidateId);
      if (result.status === "unavailable") {
        outcomes.push({ jobId: job.id, status: "unavailable", reason: result.reason });
        continue;
      }
      const existing = getJobMatchResult({
        candidateId: result.data.candidateId,
        dedupeKey: result.data.dedupeKey,
        matchEngineVersion: result.data.matchEngineVersion,
        matchKnowledgeHash: result.data.matchKnowledgeHash,
        candidateProfileHash: result.data.candidateProfileHash,
        candidateSettingsHash: result.data.candidateSettingsHash,
        jdContentHash: result.data.jdContentHash,
      });
      insertJobMatchResult(result.data);
      if (result.data.decision === "BLOCKED") blocked++;
      else if (result.data.decision === "NEEDS_REVIEW") needsReview++;
      else ready++;
      outcomes.push({ jobId: job.id, status: existing ? "cached" : "ok", decision: result.data.decision });
    } catch (err) {
      // One bad job must never abort the batch — failure isolation, same principle as
      // src/lib/scan.ts's per-company try/catch.
      errored++;
      const message = err instanceof Error ? err.message : String(err);
      errorMessages.push(`job ${job.id}: ${message}`);
      outcomes.push({ jobId: job.id, status: "error", reason: message });
    }
  }

  const finishedAt = new Date().toISOString();
  const run = insertMatchRun({
    candidateId,
    startedAt,
    finishedAt,
    jobsEvaluated: targets.length,
    jobsBlocked: blocked,
    jobsNeedsReview: needsReview,
    jobsReady: ready,
    jobsErrored: errored,
    errorSummary: errorMessages.length > 0 ? errorMessages.slice(0, 20).join("; ") : null,
  });

  return NextResponse.json({ run, outcomes });
}
