import crypto from "node:crypto";
import type { JobMatchResultKey } from "@/db/queries/jobMatches";
import type { AppSettings } from "@/lib/settings";
import { candidateProfileHash, loadCandidateProfile } from "./candidateProfile";
import { computeCandidateSettingsHash } from "./candidateSettingsHash";
import { computeMatchKnowledgeHash } from "./matchKnowledgeHash";
import { MATCH_ENGINE_VERSION } from "./scoring";

/**
 * Phase 4 Stage 5 — the ONE place the job_match_results cache/version identity is constructed.
 *
 * Every component below already existed and is used verbatim; this module only makes the identity
 * computable BEFORE evaluateJobMatch() runs, so an already-current (candidate, job) pair can be
 * served from job_match_results without paying the engine's full CPU cost (measured at ~20 ms/job
 * for a 535-skill candidate profile). See resolveJobMatch.ts for the short-circuit itself.
 *
 * There is deliberately NO second cache-key definition here: the returned JobMatchResultKey is the
 * exact type getJobMatchResult()/insertJobMatchResult() already key on (src/db/queries/jobMatches.ts),
 * and every field is produced by the same function evaluateJobMatch() itself calls —
 * MATCH_ENGINE_VERSION, computeMatchKnowledgeHash(), candidateProfileHash(), computeCandidateSettingsHash(),
 * hashJdContent(). A pre-check that disagreed with what the engine would have written would produce
 * a false cache hit, so equality here is a correctness requirement, not an optimization detail.
 */

/** Moved verbatim out of evaluateJobMatch.ts (which now imports it from here) so the pre-evaluation
 *  path and the engine hash JD content with literally the same function, not two copies that could
 *  drift. Inputs are the same two values buildMatchInput.ts puts on EvaluateJobMatchInput:
 *  job.title and job.description_text. */
export function hashJdContent(title: string, descriptionText: string | null): string {
  return crypto.createHash("sha256").update(`${title}\n${descriptionText ?? ""}`).digest("hex");
}

/** The candidate-side + code-side half of the cache key — everything that is constant across all
 *  jobs for one candidate in one rematch/scan pass, so it is resolved once per candidate instead of
 *  once per job (computeMatchKnowledgeHash in particular serializes the whole skill taxonomy). */
export interface CandidateMatchIdentity {
  matchEngineVersion: number;
  matchKnowledgeHash: string;
  candidateProfileHash: string;
  candidateSettingsHash: string;
}

export type CandidateMatchIdentityResult =
  | { status: "ok"; identity: CandidateMatchIdentity }
  | { status: "unavailable"; reason: "missing_candidate_profile" | "stale_candidate_profile" };

/**
 * Resolves the candidate's current authoritative matching identity, or reports exactly why it has
 * none. The missing/invalid/stale -> reason mapping is intentionally identical to the one
 * evaluateJobMatch() applies to the same loadCandidateProfile() result (see evaluateJobMatch.ts's
 * first four lines): a caller that pre-checks here and a caller that goes straight to the engine
 * must classify an unusable profile the same way, and "invalid" is never partially trusted.
 */
export function resolveCandidateMatchIdentity(
  candidateId: number,
  candidateSettings: AppSettings["candidate"]
): CandidateMatchIdentityResult {
  const profileLoad = loadCandidateProfile(candidateId);
  if (profileLoad.status === "missing" || profileLoad.status === "invalid") {
    return { status: "unavailable", reason: "missing_candidate_profile" };
  }
  if (profileLoad.status === "stale") {
    return { status: "unavailable", reason: "stale_candidate_profile" };
  }

  return {
    status: "ok",
    identity: {
      matchEngineVersion: MATCH_ENGINE_VERSION,
      matchKnowledgeHash: computeMatchKnowledgeHash(),
      candidateProfileHash: candidateProfileHash(profileLoad.profile),
      candidateSettingsHash: computeCandidateSettingsHash(candidateSettings),
    },
  };
}

/** Assembles the full exact-match cache key for one (candidate, job) pair. Every cache-invalidation
 *  case Stage 5 must honour falls out of this one shape: a changed resume/skills upload changes
 *  candidateProfileHash, a changed match-affecting setting changes candidateSettingsHash, an edited
 *  JD changes jdContentHash, edited matching data changes matchKnowledgeHash, and an algorithm
 *  change changes matchEngineVersion. */
export function buildJobMatchResultKey(input: {
  candidateId: number;
  dedupeKey: string;
  identity: CandidateMatchIdentity;
  jdContentHash: string;
}): JobMatchResultKey {
  return {
    candidateId: input.candidateId,
    dedupeKey: input.dedupeKey,
    matchEngineVersion: input.identity.matchEngineVersion,
    matchKnowledgeHash: input.identity.matchKnowledgeHash,
    candidateProfileHash: input.identity.candidateProfileHash,
    candidateSettingsHash: input.identity.candidateSettingsHash,
    jdContentHash: input.jdContentHash,
  };
}
