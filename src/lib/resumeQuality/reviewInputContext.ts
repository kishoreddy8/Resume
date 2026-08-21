import fs from "node:fs";
import path from "node:path";
import type { ResumeContent } from "../../../tools/tailoring-engine/types";
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getIterationDirectory, getWorkspaceDirectory, type QualityWorkflowLocation } from "./workspace";

/**
 * The four things a deterministic review needs that are resolved from the candidate, the workspace
 * and the job — rather than handed in by whoever is running the review.
 *
 * WHY THIS IS SHARED. Two callers produce a review: the orchestrator's normal iteration, and legacy
 * revalidation. They differ in exactly one honest way — where the RESUME comes from (fresh writer
 * output versus the artifact already on disk) — and in nothing else. Everything below was being
 * resolved twice, from the same sources, in two files. Two assemblies of the same context is how
 * two paths quietly end up reviewing against different evidence, so there is now one.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No writer, no model, no persistence, no status transition, no
 * iteration mutation, no quality gate, no application readiness. It reads four sources and returns
 * four values. It does not mutate its inputs and it does not mutate anything it reads.
 *
 * `docxValidation`, `resume` and `coverLetter` are NOT here on purpose: the first is async and
 * validates files the orchestrator has just rendered, and the other two have genuinely different
 * provenance per caller. Folding them in would mean inventing a shared shape for something that is
 * not actually shared.
 */

export interface DeterministicReviewContext {
  /** The candidate's own master evidence. Undefined when no profile is loadable. */
  masterResumeProfile: CandidateProfile | undefined;
  /** Requirements the pipeline extracted for this job, as persisted in the workspace. */
  jobRequirements: RequirementUnit[] | undefined;
  /** The immediately preceding iteration's resume, so the deep-rewrite check has a real before. */
  priorResume: ResumeContent | undefined;
  /** The job's OWN posted title — P0 role identity, never derived from the resume or requirements. */
  targetRoleTitle: string | undefined;
}

export interface ResolveDeterministicReviewContextInput {
  candidateId: number;
  location: QualityWorkflowLocation;
  /** The iteration being WRITTEN. `priorResume` is read from the one before it. */
  iterationNumber: number;
  dedupeKey: string;
  /** Callers that already hold either value pass it through untouched. */
  masterResumeProfile?: CandidateProfile;
  jobRequirements?: RequirementUnit[];
}

function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    /* An unparseable artifact is treated as absent — the reviewer's own checks then report what is
     * missing, rather than this function guessing at a repair. */
    return undefined;
  }
}

export function resolveDeterministicReviewContext(
  input: ResolveDeterministicReviewContextInput
): DeterministicReviewContext {
  const { candidateId, location, iterationNumber, dedupeKey } = input;

  let masterResumeProfile = input.masterResumeProfile;
  if (!masterResumeProfile) {
    const profileRes = loadCandidateProfile(candidateId);
    if (profileRes.status === "ok") masterResumeProfile = profileRes.profile;
  }

  let jobRequirements = input.jobRequirements;
  if (!jobRequirements) {
    const raw = readJson<unknown>(
      path.join(getWorkspaceDirectory(location), "extracted_job_requirements.json")
    );
    /* Only an array is accepted, matching the orchestrator's original guard — a malformed file is
     * absent requirements, never a partially-trusted set. */
    if (Array.isArray(raw)) jobRequirements = raw as RequirementUnit[];
  }

  const priorResume =
    iterationNumber > 1
      ? readJson<ResumeContent>(
          path.join(getIterationDirectory(location, iterationNumber - 1), "resume_content.json")
        )
      : undefined;

  const targetRoleTitle = getJobByDedupeKey(dedupeKey)?.title;

  return { masterResumeProfile, jobRequirements, priorResume, targetRoleTitle };
}
