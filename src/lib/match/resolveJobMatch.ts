import { getJobMatchResult, insertJobMatchResult, type JobMatchResultRow } from "@/db/queries/jobMatches";
import type { AppSettings } from "@/lib/settings";
import type { JobWithCompany } from "@/types";
import { buildEvaluateJobMatchInput } from "./buildMatchInput";
import { evaluateJobMatch } from "./evaluateJobMatch";
import { buildJobMatchResultKey, hashJdContent, type CandidateMatchIdentity } from "./matchIdentity";
import type { Decision } from "./types";

/**
 * Phase 4 Stage 5 — the single "reuse it or evaluate it" step every batch matching path goes
 * through (src/lib/match/incrementalMatch.ts's scan-triggered matching and
 * src/lib/match/rematchCandidate.ts's candidate-triggered paging).
 *
 * WHY THIS EXISTS — the orchestration order used to be:
 *     evaluateJobMatch()  ->  getJobMatchResult()  ->  reuse the existing row
 * which meant a 100% cache-hit pass still paid the engine's full CPU cost. Measured on 2000 real
 * production jobs against the real 535-skill candidate profile: 20.82 ms/job on first pass and
 * 20.57 ms/job on a second, all-cache-hit pass — i.e. the cache was saving a write, never the
 * compute. The order is now:
 *     buildJobMatchResultKey()  ->  getJobMatchResult()  ->  evaluateJobMatch() only on a miss
 *
 * NOTHING about scoring, eligibility or decisions changes: on a miss the exact same
 * buildEvaluateJobMatchInput() + evaluateJobMatch() + insertJobMatchResult() calls run, in the same
 * order, with the same arguments; on a hit the row returned is the very row insertJobMatchResult()
 * would itself have returned (it is hit-or-insert and returns the existing row untouched for an
 * exact key — including NOT re-running its supersede UPDATE, so the hit path is byte-identical to
 * before). Cached rows are immutable per key, so a hit's `decision` is exactly what a fresh
 * evaluation would have produced for that key.
 */

export type JobMatchResolution =
  | { status: "reused"; row: JobMatchResultRow; decision: Decision }
  | { status: "created"; row: JobMatchResultRow; decision: Decision }
  /** Same two reasons evaluateJobMatch() reports — see matchIdentity.ts's mapping note. */
  | { status: "unavailable"; reason: string };

export interface ResolveJobMatchOptions {
  job: JobWithCompany;
  candidateId: number;
  candidateSettings: AppSettings["candidate"];
  /** Resolved ONCE per candidate by the caller (resolveCandidateMatchIdentity) — it is identical
   *  for every job in the pass, and recomputing it per job would reintroduce a per-job cost. */
  identity: CandidateMatchIdentity;
  /** Test seam only: lets a test count how many times the engine was actually invoked, so
   *  "a cache hit does not call the evaluator" is provable without wall-clock timing. Production
   *  callers never pass this — they get the real engine via the default. */
  evaluate?: typeof evaluateJobMatch;
}

export function resolveJobMatchResult(options: ResolveJobMatchOptions): JobMatchResolution {
  const { job, candidateId, candidateSettings, identity, evaluate = evaluateJobMatch } = options;

  const key = buildJobMatchResultKey({
    candidateId,
    dedupeKey: job.dedupe_key,
    identity,
    // Same two values buildEvaluateJobMatchInput puts on the engine input (jobTitle/descriptionText),
    // hashed by the same function the engine uses — see matchIdentity.hashJdContent.
    jdContentHash: hashJdContent(job.title, job.description_text),
  });

  const cached = getJobMatchResult(key);
  if (cached) return { status: "reused", row: cached, decision: cached.decision as Decision };

  const evaluated = evaluate(buildEvaluateJobMatchInput(job), candidateSettings, candidateId);
  if (evaluated.status === "unavailable") return { status: "unavailable", reason: evaluated.reason };

  // insertJobMatchResult stays hit-or-insert: if the candidate's profile file changed in the
  // microseconds between `identity` being resolved and this call, the engine's own freshly-loaded
  // hashes — not the pre-check's — decide the row that gets written, so a stale pre-check can only
  // ever cost an extra evaluation, never write or return a wrong result.
  const row = insertJobMatchResult(evaluated.data);
  return { status: "created", row, decision: evaluated.data.decision };
}
