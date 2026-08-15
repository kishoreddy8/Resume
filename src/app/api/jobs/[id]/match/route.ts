import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate } from "@/db/queries/candidates";
import { getMatchAffectingSettings } from "@/db/queries/candidateSettings";
import { getJob } from "@/db/queries/jobs";
import { deserializeJobMatchResult, getJobMatchResult, getLatestJobMatchResult, insertJobMatchResult } from "@/db/queries/jobMatches";
import { buildEvaluateJobMatchInput } from "@/lib/match/buildMatchInput";
import { evaluateJobMatch } from "@/lib/match/evaluateJobMatch";

/**
 * Single-job Phase 2 matching. Deterministic only — zero AI calls, zero cost, cheap enough to run
 * synchronously (unlike "Enrich with AI", GET is safe to call on page mount). Never mutates any
 * `jobs.*` column — writes only into job_match_results, the same "AI/Phase-2-output namespaced away
 * from authoritative data" pattern ai-enrich already established for the AI layer.
 */

function parseJobId(id: string): number | null {
  const jobId = Number(id);
  return Number.isInteger(jobId) ? jobId : null;
}

/** candidateId is required explicitly (query param on GET, JSON body on POST) — never read from a
 *  global "active candidate" setting. See CAREER_OPS_HANDOFF.md's Phase 2.5 design record §8/9: this
 *  is data-isolation/correctness (two browser tabs on two different candidates must not cross-
 *  contaminate), not an authentication boundary — there are no security principals in this local app. */
function parseCandidateId(raw: string | null): number | null {
  if (raw === null) return null;
  const candidateId = Number(raw);
  return Number.isInteger(candidateId) && candidateId > 0 ? candidateId : null;
}

/** Evaluate (or return the existing cached result for) this job, for one explicit candidate. Always
 *  computes fresh and lets insertJobMatchResult's own exact-key lookup decide cache-hit vs.
 *  fresh-insert — cheap enough (pure, deterministic, no I/O beyond one candidate-profile file read)
 *  that a redundant compute on a cache hit is not worth optimizing away with a separate pre-check. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = parseJobId(id);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const candidateId = parseCandidateId(body?.candidateId != null ? String(body.candidateId) : null);
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const candidateSettings = getMatchAffectingSettings(candidateId);
  const result = evaluateJobMatch(buildEvaluateJobMatchInput(job), candidateSettings, candidateId);

  if (result.status === "unavailable") {
    return NextResponse.json({ status: "unavailable", reason: result.reason });
  }

  // Check hit/miss BEFORE inserting — insertJobMatchResult itself is hit-or-insert, so this is the
  // only reliable way to report `cached` accurately (comparing timestamps after the fact is not:
  // SQLite's datetime('now') and the JS computedAt ISO string can coincidentally look "different"
  // even on a genuine fresh insert).
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
  return NextResponse.json({ status: "ok", cached: Boolean(existing), result: result.data });
}

/** Latest cached result for one explicit candidate, if any — cheap/deterministic, safe to fetch on
 *  page mount (unlike the AI card's strictly on-demand pattern). Does NOT trigger a fresh evaluation;
 *  use POST for that. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = parseJobId(id);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });

  const candidateId = parseCandidateId(req.nextUrl.searchParams.get("candidateId"));
  if (candidateId === null) return NextResponse.json({ error: "candidateId is required" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const row = getLatestJobMatchResult(candidateId, job.dedupe_key);
  if (!row) return NextResponse.json({ status: "none" });

  return NextResponse.json({ status: "ok", result: deserializeJobMatchResult(row) });
}
