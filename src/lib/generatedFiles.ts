import fs from "node:fs";
import path from "node:path";
import { slugify } from "@/lib/slugify";

// Mirrors the layout the tailor-resume skill's engine writes to (see generate.ts) and the job
// detail API route already reads from — kept in one place so both stay in sync. Exported so
// src/lib/tailoringArtifacts.ts (Phase 3 Stage 4's candidate/run-scoped layout) can nest its own
// subtree under the exact same root rather than duplicating the "data/generated" path segment.
//
// CAREER_OPS_GENERATED_DIR is a test-only override (mirroring src/db/index.ts's CAREER_OPS_DB_PATH
// and src/lib/match/candidateProfile.ts's CAREER_OPS_CANDIDATES_DIR conventions) — real app code
// never sets this env var. Without it, Phase 3 Stage 5's executeTailoringRun tests would write real
// files into this project's actual data/generated/ tree.
export function getGeneratedRoot(): string {
  return process.env.CAREER_OPS_GENERATED_DIR ?? path.join(process.cwd(), "data", "generated");
}
export const GENERATED_ROOT = process.env.CAREER_OPS_GENERATED_DIR ?? path.join(process.cwd(), "data", "generated");

export function generatedFilesDir(companyName: string, jobId: number): string {
  return path.join(getGeneratedRoot(), slugify(companyName), String(jobId));
}

/**
 * Deletes a job's generated-output directory (Resume.docx, CoverLetter.docx, ATS/Recruiter reports,
 * cold email) when the job record itself is deleted — Not Interested, or the age-based sweep
 * removing an unapplied posting older than 10 days. Never touches the tailor-resume engine itself
 * (tools/tailoring-engine/), only its output under data/generated/.
 *
 * Guarded to only ever delete a path that resolves inside data/generated/ — slugify() already can't
 * produce a traversal segment, but this is cheap, explicit defense in depth against ever deleting
 * outside the intended directory rather than trusting that invariant silently.
 *
 * Returns false (no-op, not an error) if there was nothing to delete — most jobs are deleted before
 * ever being tailored, so this is the common case, not a failure.
 */
export function deleteGeneratedFiles(companyName: string, jobId: number): boolean {
  const dir = generatedFilesDir(companyName, jobId);
  const resolvedRoot = path.resolve(getGeneratedRoot()) + path.sep;
  const resolvedDir = path.resolve(dir);
  if (!resolvedDir.startsWith(resolvedRoot)) {
    throw new Error(`Refusing to delete a path outside data/generated/: ${resolvedDir}`);
  }
  if (!fs.existsSync(resolvedDir)) return false;
  fs.rmSync(resolvedDir, { recursive: true, force: true });
  return true;
}
