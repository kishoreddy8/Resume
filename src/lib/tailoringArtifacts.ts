import crypto from "node:crypto";
import path from "node:path";
import { getGeneratedRoot } from "@/lib/generatedFiles";

/**
 * Phase 3 Stage 4 — candidate/job/run-scoped tailoring artifact storage.
 *
 * The legacy layout (see generatedFiles.ts) is company+job scoped only:
 *   data/generated/<company-slug>/<jobId>/
 * That collides across candidates and across repeated tailoring runs for the same job — a second
 * run silently overwrites the first. This module defines a new, additive subtree under the SAME
 * generated-artifact root, scoped by the actual identity that matters for a tailoring attempt:
 *
 *   data/generated/candidates/<candidateId>/jobs/<jobIdentityHash>/runs/<runId>/
 *     Resume.docx
 *     CoverLetter.docx
 *
 * candidate_id + run_id are already-validated positive integers from tailoringRuns.ts. The job
 * segment is a stable hash of dedupe_key (never the mutable company name/job title/URL slug —
 * dedupe_key is the one identity that's authoritative and stable across a job's lifetime, same
 * discipline as job_match_results/candidate_job_state/tailoring_runs).
 *
 * This module does not write any files itself — it only computes where the tailoring-engine
 * generator (tools/tailoring-engine/generate.ts) should write, and where a future artifact-serving
 * route would read from. output_files stored in tailoring_runs stays relative-filename metadata
 * (e.g. "Resume.docx") — never these absolute paths — so a row stays portable across machines/paths;
 * the full location is always re-derived from candidate_id + dedupe_key + run_id, never persisted.
 */

export interface TailoringArtifactLocation {
  candidateId: number;
  dedupeKey: string;
  runId: number;
}

export interface TailoringArtifactPaths {
  dir: string;
  resumePath: string;
  coverLetterPath: string;
}

/**
 * Deterministic, filesystem-safe, low-collision stand-in for a job's dedupe_key. SHA-256 truncated
 * to 16 hex characters (64 bits) — a raw dedupe_key can contain characters that are awkward or
 * unsafe in a path segment (":", "/", long provider-specific IDs), and the full 64-char hex digest
 * is needlessly long for a directory name. 64 bits of digest space is astronomically collision-safe
 * at this application's scale (a single-candidate personal job tracker, thousands not billions of
 * jobs) — see the birthday-bound test below for the concrete guarantee this relies on.
 */
export function hashJobIdentity(dedupeKey: string): string {
  if (typeof dedupeKey !== "string" || dedupeKey.trim().length === 0) {
    throw new Error("hashJobIdentity: dedupeKey must be a non-empty string");
  }
  return crypto.createHash("sha256").update(dedupeKey).digest("hex").slice(0, 16);
}

function validateLocation(location: TailoringArtifactLocation): void {
  if (!Number.isInteger(location.candidateId) || location.candidateId <= 0) {
    throw new Error(`Invalid candidateId for tailoring artifact path: ${location.candidateId}`);
  }
  if (!Number.isInteger(location.runId) || location.runId <= 0) {
    throw new Error(`Invalid runId for tailoring artifact path: ${location.runId}`);
  }
  if (typeof location.dedupeKey !== "string" || location.dedupeKey.trim().length === 0) {
    throw new Error("Invalid dedupeKey for tailoring artifact path: must be a non-empty string");
  }
}

/** Defense-in-depth, mirroring generatedFiles.ts's deleteGeneratedFiles guard: candidateId/runId
 *  are validated positive integers and the job segment is a fixed-length hex hash, so a path
 *  escaping GENERATED_ROOT should be structurally impossible — this assertion makes that guarantee
 *  explicit and loud rather than silently trusted. */
function assertInsideGeneratedRoot(dir: string): void {
  const resolvedRoot = path.resolve(getGeneratedRoot()) + path.sep;
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedRoot)) {
    throw new Error(`Refusing to resolve a tailoring artifact path outside the generated-artifact root: ${resolvedDir}`);
  }
}

/** The run-scoped directory a tailoring attempt's output belongs in — does not create it on disk. */
export function getTailoringArtifactDirectory(location: TailoringArtifactLocation): string {
  validateLocation(location);
  const jobHash = hashJobIdentity(location.dedupeKey);
  const dir = path.join(
    getGeneratedRoot(),
    "candidates",
    String(location.candidateId),
    "jobs",
    jobHash,
    "runs",
    String(location.runId)
  );
  assertInsideGeneratedRoot(dir);
  return dir;
}

/** Full resolved paths for the two documents the tailoring engine renders. Filenames intentionally
 *  match the existing, already-established convention (generatedFiles.ts's doc comment: "Resume.docx,
 *  CoverLetter.docx, ..."), not a candidate-name-prefixed variant — this repo already supports more
 *  than one candidate, and hardcoding one candidate's name into a shared filename convention would
 *  be exactly the kind of single-candidate assumption Phase 2.5 deliberately removed elsewhere. */
export function resolveTailoringArtifactPaths(location: TailoringArtifactLocation): TailoringArtifactPaths {
  const dir = getTailoringArtifactDirectory(location);
  return {
    dir,
    resumePath: path.join(dir, "Resume.docx"),
    coverLetterPath: path.join(dir, "CoverLetter.docx"),
  };
}
