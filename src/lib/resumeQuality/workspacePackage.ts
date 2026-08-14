import fs from "node:fs";
import path from "node:path";
import { getWorkspaceDirectory, type QualityWorkflowLocation } from "./workspace";
import type { ResumeTailoringWorkspacePackage } from "./types";

/**
 * Mirrors src/lib/match/candidateProfile.ts's own env-var-aware root derivation (same
 * CAREER_OPS_CANDIDATES_DIR test override) exactly, but is intentionally NOT imported from that
 * Phase 2 module — Stage 7 must not modify or take on a new dependency on Phase 2 internals. This is
 * the smallest safe read of a single manifest field (the current master filename), not a competing
 * implementation of candidate-profile loading/validation, which stays entirely owned by Phase 2.
 */
function candidatesRoot(): string {
  return process.env.CAREER_OPS_CANDIDATES_DIR ?? path.join(process.cwd(), "data", "candidates");
}
function masterDir(candidateId: number): string {
  return path.join(candidatesRoot(), String(candidateId), "master");
}

interface MasterManifestEntry {
  filename: string;
}
type MasterManifest = Partial<Record<"resume" | "skills", MasterManifestEntry>>;

function readMasterManifest(candidateId: number): MasterManifest {
  const manifestPath = path.join(masterDir(candidateId), "manifest.json");
  if (!fs.existsSync(manifestPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as MasterManifest;
  } catch {
    return {};
  }
}

export interface BuildWorkspacePackageInput {
  candidateId: number;
  applicationId: number;
  dedupeKey: string;
  tailoringRunId: number;
  workflowId: number;
  /** Needed to resolve the workspace directory via Stage 4's run-scoped hierarchy. */
  runId: number;
  selectedTrack: string | null;
  phase2Context: ResumeTailoringWorkspacePackage["phase2Context"];
}

/**
 * Assembles the future writer/reviewer agents' input package from EXISTING sources of truth — the
 * candidate's own master-files manifest (for the current resume/skills filenames) and this
 * workflow's own workspace directory (Stage 7's additive extension of Stage 4's artifact hierarchy).
 * Never duplicates the actual resume/JD/instructions CONTENT into the database or a new copy — every
 * field here is a filesystem reference, resolved fresh each call rather than cached/persisted stale.
 */
export function buildWorkspacePackage(input: BuildWorkspacePackageInput): ResumeTailoringWorkspacePackage {
  const manifest = readMasterManifest(input.candidateId);
  const dir = masterDir(input.candidateId);
  const resumeFilename = manifest.resume?.filename ?? "resume";
  const skillsFilename = manifest.skills?.filename ?? "skills";

  const location: QualityWorkflowLocation = {
    candidateId: input.candidateId,
    dedupeKey: input.dedupeKey,
    runId: input.runId,
    workflowId: input.workflowId,
  };
  const workspaceDir = getWorkspaceDirectory(location);

  return {
    candidateId: input.candidateId,
    applicationId: input.applicationId,
    dedupeKey: input.dedupeKey,
    tailoringRunId: input.tailoringRunId,
    workflowId: input.workflowId,
    selectedTrack: input.selectedTrack,
    phase2Context: input.phase2Context,
    jobDescriptionPath: path.join(workspaceDir, "job_description.md"),
    extractedJobRequirementsPath: path.join(workspaceDir, "extracted_job_requirements.json"),
    masterResumePath: path.join(dir, resumeFilename),
    masterSkillsInventoryPath: path.join(dir, skillsFilename),
    tailoringInstructionsPath: path.join(workspaceDir, "resume_tailoring_instructions.md"),
  };
}
