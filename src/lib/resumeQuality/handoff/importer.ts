import fs from "node:fs";
import path from "node:path";
import { getCandidate } from "@/db/queries/candidates";
import { getResumeQualityWorkflow } from "@/db/queries/resumeQualityWorkflows";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { getTailoringRun } from "@/db/queries/tailoringRuns";
import { ResumeQualityOrchestrationError } from "../orchestrator";
import type {
  ExternalHandoffImportResult,
  ExternalWriterOutput,
  ResumeWriterOutput,
} from "../types";
import type { CoverLetterContent, ResumeContent } from "../../../../tools/tailoring-engine/types";

export interface ImportExternalWriterResultInput {
  candidateId: number;
  workflowId: number;
  expectedIterationNumber?: number;
  /** Path to writer_output.json or direct raw JSON string or object */
  inputPath?: string;
  rawJson?: string;
  parsedOutput?: unknown;
}

/**
 * Validates the strict structural schema of a ResumeContent object.
 */
export function validateResumeContentStructure(resume: unknown): ResumeContent {
  if (!resume || typeof resume !== "object") {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent must be a non-null object");
  }

  const r = resume as Partial<ResumeContent>;

  if (typeof r.name !== "string" || r.name.trim().length === 0) {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent.name must be a non-empty string");
  }
  if (!Array.isArray(r.summary) || r.summary.some((s) => typeof s !== "string")) {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent.summary must be an array of strings");
  }
  if (!Array.isArray(r.skillGroups)) {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent.skillGroups must be an array");
  }
  for (const group of r.skillGroups) {
    if (!group || typeof group !== "object" || typeof group.label !== "string" || !Array.isArray(group.items)) {
      throw new ResumeQualityOrchestrationError(
        "INVALID_RESUME_CONTENT",
        "Each skillGroup must have a string label and an array of items"
      );
    }
  }

  if (!Array.isArray(r.experience)) {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent.experience must be an array");
  }
  for (const exp of r.experience) {
    if (
      !exp ||
      typeof exp !== "object" ||
      typeof exp.title !== "string" ||
      typeof exp.company !== "string" ||
      typeof exp.dates !== "string" ||
      !Array.isArray(exp.bullets) ||
      exp.bullets.some((b) => typeof b !== "string")
    ) {
      throw new ResumeQualityOrchestrationError(
        "INVALID_RESUME_CONTENT",
        "Each experience entry must have string title, company, dates, and an array of string bullets"
      );
    }
  }

  if (!Array.isArray(r.education) || r.education.some((e) => typeof e !== "string")) {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent.education must be an array of strings");
  }

  if (r.certifications !== undefined && (!Array.isArray(r.certifications) || r.certifications.some((c) => typeof c !== "string"))) {
    throw new ResumeQualityOrchestrationError("INVALID_RESUME_CONTENT", "ResumeContent.certifications must be an array of strings if provided");
  }

  return resume as ResumeContent;
}

/**
 * Validates the strict structural schema of a CoverLetterContent object.
 */
export function validateCoverLetterContentStructure(coverLetter: unknown): CoverLetterContent {
  if (!coverLetter || typeof coverLetter !== "object") {
    throw new ResumeQualityOrchestrationError("INVALID_COVER_LETTER_CONTENT", "CoverLetterContent must be a non-null object");
  }

  const c = coverLetter as Partial<CoverLetterContent>;

  if (typeof c.name !== "string" || c.name.trim().length === 0) {
    throw new ResumeQualityOrchestrationError("INVALID_COVER_LETTER_CONTENT", "CoverLetterContent.name must be a non-empty string");
  }
  if (typeof c.salutation !== "string" || c.salutation.trim().length === 0) {
    throw new ResumeQualityOrchestrationError("INVALID_COVER_LETTER_CONTENT", "CoverLetterContent.salutation must be a non-empty string");
  }
  if (!Array.isArray(c.paragraphs) || c.paragraphs.length === 0 || c.paragraphs.some((p) => typeof p !== "string")) {
    throw new ResumeQualityOrchestrationError("INVALID_COVER_LETTER_CONTENT", "CoverLetterContent.paragraphs must be a non-empty array of strings");
  }
  if (typeof c.closing !== "string" || c.closing.trim().length === 0) {
    throw new ResumeQualityOrchestrationError("INVALID_COVER_LETTER_CONTENT", "CoverLetterContent.closing must be a non-empty string");
  }

  return coverLetter as CoverLetterContent;
}

/**
 * Imports and strictly validates a writer_output.json payload from an external subscription agent.
 */
export function importExternalWriterResult(
  input: ImportExternalWriterResultInput
): ExternalHandoffImportResult {
  const { candidateId, workflowId } = input;

  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_CANDIDATE_ID", `Invalid candidateId: ${candidateId}`);
  }
  if (!Number.isInteger(workflowId) || workflowId <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_WORKFLOW_ID", `Invalid workflowId: ${workflowId}`);
  }

  const candidate = getCandidate(candidateId);
  if (!candidate) {
    throw new ResumeQualityOrchestrationError("CANDIDATE_NOT_FOUND", `Candidate ${candidateId} not found`);
  }
  if (candidate.status !== "active") {
    throw new ResumeQualityOrchestrationError("NOT_ACTIVE_CANDIDATE", `Candidate ${candidateId} is not active`);
  }

  const workflow = getResumeQualityWorkflow(candidateId, workflowId);
  if (!workflow) {
    throw new ResumeQualityOrchestrationError("WORKFLOW_NOT_FOUND", `Workflow ${workflowId} not found for candidate ${candidateId}`);
  }

  if (workflow.status === "READY" || workflow.status === "FAILED") {
    throw new ResumeQualityOrchestrationError(
      "WORKFLOW_ALREADY_TERMINAL",
      `Cannot import external result into terminal workflow ${workflowId} (status: ${workflow.status})`
    );
  }

  const tailoringRun = getTailoringRun(candidateId, workflow.tailoring_run_id);
  if (!tailoringRun) {
    throw new ResumeQualityOrchestrationError(
      "TAILORING_RUN_NOT_FOUND",
      `Tailoring run ${workflow.tailoring_run_id} not found for candidate ${candidateId}`
    );
  }
  if (tailoringRun.dedupe_key !== workflow.dedupe_key) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Tailoring run dedupe_key (${tailoringRun.dedupe_key}) does not match workflow dedupe_key (${workflow.dedupe_key})`
    );
  }

  const appState = getCandidateJobState(candidateId, workflow.dedupe_key);
  if (appState && appState.id !== workflow.application_id) {
    throw new ResumeQualityOrchestrationError(
      "APPLICATION_MISMATCH",
      `Application ID mismatch: candidate_job_state id is ${appState.id}, workflow application_id is ${workflow.application_id}`
    );
  }

  const expectedIteration = input.expectedIterationNumber ?? (workflow.current_iteration === 0 ? 1 : workflow.current_iteration + 1);

  // 1. Resolve raw JSON payload
  let rawPayload: unknown;
  if (input.parsedOutput !== undefined) {
    rawPayload = input.parsedOutput;
  } else if (input.rawJson !== undefined) {
    try {
      rawPayload = JSON.parse(input.rawJson);
    } catch (err) {
      throw new ResumeQualityOrchestrationError("MALFORMED_JSON", `Failed to parse rawJson: ${(err as Error).message}`);
    }
  } else if (input.inputPath !== undefined) {
    const resolvedPath = path.resolve(input.inputPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new ResumeQualityOrchestrationError("FILE_NOT_FOUND", `Output file not found at ${resolvedPath}`);
    }
    try {
      const fileContent = fs.readFileSync(resolvedPath, "utf-8");
      rawPayload = JSON.parse(fileContent);
    } catch (err) {
      throw new ResumeQualityOrchestrationError("MALFORMED_JSON", `Failed to read/parse output file at ${resolvedPath}: ${(err as Error).message}`);
    }
  } else {
    throw new ResumeQualityOrchestrationError("MISSING_INPUT", "Must provide inputPath, rawJson, or parsedOutput");
  }

  if (!rawPayload || typeof rawPayload !== "object") {
    throw new ResumeQualityOrchestrationError("INVALID_PAYLOAD", "External writer output payload must be a non-null JSON object");
  }

  const payload = rawPayload as Partial<ExternalWriterOutput>;

  // 2. Validate Schema Version
  if (payload.schemaVersion !== 1) {
    throw new ResumeQualityOrchestrationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `Expected schemaVersion 1, got ${payload.schemaVersion}`
    );
  }

  // 3. Validate Identity Tokens
  if (payload.candidateId !== candidateId) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Payload candidateId (${payload.candidateId}) does not match expected candidateId (${candidateId})`
    );
  }
  if (payload.workflowId !== workflowId) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Payload workflowId (${payload.workflowId}) does not match expected workflowId (${workflowId})`
    );
  }
  if (payload.applicationId !== workflow.application_id) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Payload applicationId (${payload.applicationId}) does not match workflow applicationId (${workflow.application_id})`
    );
  }
  if (payload.tailoringRunId !== workflow.tailoring_run_id) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Payload tailoringRunId (${payload.tailoringRunId}) does not match workflow tailoringRunId (${workflow.tailoring_run_id})`
    );
  }
  if (tailoringRun.job_id !== null && payload.jobId !== tailoringRun.job_id) {
    throw new ResumeQualityOrchestrationError(
      "IDENTITY_MISMATCH",
      `Payload jobId (${payload.jobId}) does not match tailoringRun jobId (${tailoringRun.job_id})`
    );
  }
  if (payload.iterationNumber !== expectedIteration) {
    throw new ResumeQualityOrchestrationError(
      "ITERATION_MISMATCH",
      `Payload iterationNumber (${payload.iterationNumber}) does not match expected iteration (${expectedIteration})`
    );
  }

  // 4. Validate Content Structure
  const validatedResume = validateResumeContentStructure(payload.resume);
  const validatedCoverLetter = payload.coverLetter ? validateCoverLetterContentStructure(payload.coverLetter) : undefined;

  const writerOutput: ResumeWriterOutput = {
    resume: validatedResume,
    ...(validatedCoverLetter ? { coverLetter: validatedCoverLetter } : {}),
    // Passed through structurally only — never validated for truthfulness here. CareerOps's own
    // instructionCompliance checks (computed independently below in the review step) are the sole
    // authority; this is provenance/diagnostic data stored for audit trail only.
    ...(payload.writerValidation ? { writerValidation: payload.writerValidation } : {}),
  };

  return {
    candidateId,
    applicationId: workflow.application_id,
    jobId: payload.jobId !== undefined ? payload.jobId : (tailoringRun.job_id ?? null),
    tailoringRunId: workflow.tailoring_run_id,
    workflowId,
    iterationNumber: expectedIteration,
    writerOutput,
    agentMetadata: payload.agentMetadata,
    validated: true,
  };
}
