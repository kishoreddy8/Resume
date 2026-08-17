import fs from "node:fs";
import path from "node:path";
import { getCandidate } from "@/db/queries/candidates";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getResumeQualityWorkflow } from "@/db/queries/resumeQualityWorkflows";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { getTailoringRun } from "@/db/queries/tailoringRuns";
import { buildAtsCoverageReport, renderAtsCoverageReport } from "../atsCoverageReport";
import { CANONICAL_TAILORING_INSTRUCTIONS, INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { buildJdPriorityMatrix, type JdPriorityMatrix } from "../jdPriorityMatrix";
import { recommendedPositioningSummary } from "../positioningEngine";
import { recommendedSkillOrder } from "../skillRanking";
import { buildWorkspacePackage } from "../workspacePackage";
import { getIterationDirectory, getHandoffDirectory, type QualityWorkflowLocation } from "../workspace";
import { buildResumeWriterInput, ResumeQualityOrchestrationError } from "../orchestrator";
import type {
  ExternalHandoffExportResult,
  ResumeWriterInput,
  StructuredResumeReview,
  WorkflowStatusFile,
} from "../types";

export interface ExportExternalWriterPackageInput {
  candidateId: number;
  workflowId: number;
  targetIterationNumber?: number;
  overwriteExisting?: boolean;
}

/**
 * Builds the deterministic markdown instructions for an external subscription agent
 * (Claude Code, Codex, Antigravity, local agents).
 */
export function buildExternalWriterPrompt(input: {
  candidateId: number;
  candidateName: string;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  iterationNumber: number;
  selectedTrack: string | null;
  latestReview?: StructuredResumeReview;
  requiredCorrections?: ResumeWriterInput["requiredCorrections"];
  blockingIssues?: string[];
  /** Stage 21 (Evidence-Grounded Resume Quality V2) — the computed JD Priority Matrix/positioning/
   *  skill-order/ATS-coverage data the writer should actually USE, not just prose guidance about it.
   *  All optional: absent only when neither jobRequirements nor a target role title were available
   *  at export time (never fabricated to fill the gap). */
  jdPriorityMatrix?: JdPriorityMatrix;
  positioningRecommendation?: string;
  recommendedSkillOrder?: string[];
  atsCoverageReportText?: string;
}): string {
  const { candidateName, iterationNumber, selectedTrack, latestReview, requiredCorrections, blockingIssues } = input;

  const correctionsBlock =
    requiredCorrections && requiredCorrections.length > 0
      ? requiredCorrections
          .map((c) => `- **[${c.priority}]**: ${c.description}`)
          .join("\n")
      : "None identified.";

  const blockingBlock =
    blockingIssues && blockingIssues.length > 0
      ? blockingIssues.map((b) => `- **[BLOCKING]**: ${b}`).join("\n")
      : "None.";

  const scoresBlock = latestReview
    ? `- Overall Quality Score: ${latestReview.overallScore}/100
- ATS Keyword Alignment Score: ${latestReview.atsScore}/100
- Truthfulness / Master Profile Consistency: ${latestReview.truthfulnessScore}/100
- Architecture & Technology Consistency: ${latestReview.architectureConsistencyScore}/100
- Recruiter Readability Score: ${latestReview.recruiterReadabilityScore}/100
- Formatting & Structural Completeness Score: ${latestReview.formattingScore}/100`
    : "Initial tailoring iteration (no prior review scores).";

  return `# External Resume Writer Agent Task — Iteration ${iterationNumber}

## Role & Context
You are acting as an external expert resume tailoring agent for **${candidateName}**.
You are preparing **Iteration ${iterationNumber}** of a tailored, interview-defensible resume for a specific job opportunity.

Target Role Track: **${selectedTrack ?? "General Engineering Track"}**

---

## THE CANONICAL STANDARD IS MANDATORY

\`resume_tailoring_instructions.md\` in this package (instruction version **${INSTRUCTION_VERSION}**, hash \`${INSTRUCTION_HASH}\`) is the full, authoritative Resume Tailoring System Instructions — not a summary. You must follow it in its entirety, not just the highlights below. CareerOps will independently re-review your output against this exact same text; nothing you self-report can substitute for actually satisfying it.

## CRITICAL TAILORING GUARDRAILS & OBJECTIVES

1. **Truthfulness & Factual Grounding (Absolute Rule — hard facts are immutable)**:
   - The Master Resume (\`master_resume_reference.json\` / \`master_resume.txt\`) is the **sole authoritative record** for employers, job titles, employment dates, education, certifications, and project attribution. These facts may never be changed, invented, or altered to fit the JD.
   - You must NEVER fabricate an employer, title, degree, certification, or client.
   - The Master Skills Inventory (\`master_skills_inventory.md\`) constrains what you may claim: only technologies genuinely present there (or in the Master Resume's own experience entries) may appear anywhere in the resume or cover letter — never introduce a technology solely because the JD mentions it.

2. **Deep rewrite is required — light keyword replacement is a failure mode**:
   - A pass that only swaps a few keywords into the existing bullets will be REJECTED by CareerOps's review. Rewrite the summary, skills ordering, and experience bullets so the resume reads as though it were written specifically for this JD and this company.
   - Materially different Job Descriptions must produce materially different resumes — if your output would look nearly identical regardless of which JD it was tailored for, it has not done the job.

3. **Architecture integrity takes priority over raw keyword coverage**:
   - Maintain a coherent, believable technology architecture within each employer/project. Do not combine competing tools (e.g. Azure Data Factory + AWS Glue, or Databricks + EMR) in the same bullet or the same project unless explicitly and legitimately framed as a migration.
   - Prefer one primary technology per responsibility rather than listing every adjacent tool as a laundry list.

4. **Fix Required Quality Corrections & Blocking Issues**:
   - Resolve every CRITICAL and HIGH severity issue first.
   - Ensure all dominant required job keywords from \`extracted_job_requirements.json\` appear prominently in Technical Skills and are evidenced in relevant experience bullets — but never at the cost of guardrail 1-3 above.

5. **Writing Style & Formatting — every bullet must be interview-defensible**:
   - Begin bullets with strong, varied action verbs (e.g. "Architected", "Engineered", "Optimized", "Spearheaded"), past tense for past roles.
   - NEVER use generic openers like "Responsible for" or "Worked on".
   - Avoid AI clichés (e.g., "testament to", "delve", "leverage synergy", "spearheaded revolution").
   - Every major achievement bullet should include quantifiable, realistic impact you could defend and elaborate on if asked about it in an interview — never an invented or exaggerated metric.

6. **Self-check before returning**: before writing \`writer_output.json\`, re-read \`resume_tailoring_instructions.md\` end to end and verify your draft against every guardrail in it (hard facts, MSI, architecture integrity, technology grouping, no contradicting technologies, metric inference policy, banned language, duplicate bullets, years/education honesty, bullet caps, verb tense, ATS formatting). Report your own findings in the optional \`writerValidation\` field below — but note that this is diagnostic only and does not substitute for CareerOps's own independent review.

7. **Lock the resume before writing the cover letter**: finish and finalize the \`resume\` field FIRST, against the JD Priority Matrix below. Only once that resume is finalized, write the \`coverLetter\` field USING that finalized resume as one of its sources — never generate the cover letter from independent JD-only reasoning. Every technology or accomplishment the cover letter attributes to a specific past employer must be traceable to that SAME employer's bullets in the resume you just wrote (CareerOps's cross-document validator enforces this: e.g. a technology used only at Employer A can never be attributed to Employer B in the cover letter, even if it's genuinely evidenced elsewhere in your history).

---

## JD PRIORITY MATRIX — use this to decide POSITIONING, SKILL ORDER, and BULLET EMPHASIS
${
  input.jdPriorityMatrix
    ? `Target role (P0): **${input.jdPriorityMatrix.targetRoleTitle ?? "not specified"}**

${input.jdPriorityMatrix.requirements
  .slice()
  .sort((a, b) => a.priority.localeCompare(b.priority))
  .map((r) => `- [${r.priority}] ${r.requirement} (${r.requiredOrPreferred}, candidate evidence: ${r.evidenceStrength})`)
  .join("\n")}

P0/P1 are core role identity/must-have requirements — these MUST dominate the headline and summary. P3/P4 (preferred/secondary) technologies may appear as supporting capabilities further down, but must NEVER headline the resume or crowd out P0/P1 content, even if they seem to have more JD mentions. An UNSUPPORTED requirement (candidate evidence: NONE above) must NEVER be added to the resume — report it as a gap, do not fabricate it.`
    : "Not available for this iteration (no structured job requirements or target role title were supplied)."
}

${input.positioningRecommendation ? `**Positioning guidance:** ${input.positioningRecommendation}` : ""}

${
  input.recommendedSkillOrder && input.recommendedSkillOrder.length > 0
    ? `**Recommended skill order (highest JD-relevance first):** ${input.recommendedSkillOrder.slice(0, 12).join(", ")}`
    : ""
}

${input.atsCoverageReportText ? `### ATS Coverage Report (current draft, if any)\n\`\`\`\n${input.atsCoverageReportText}\`\`\`` : ""}

---

## PRIOR QUALITY REVIEW FEEDBACK

### Review Scores
${scoresBlock}

### Blocking Issues to Resolve
${blockingBlock}

### Required Corrections
${correctionsBlock}

---

## OUTPUT REQUIREMENT: \`writer_output.json\`

When your improvements are complete, create the file **\`writer_output.json\`** in this exact directory matching the strict schema below.

### Strict JSON Output Schema (\`writer_output.json\`)
\`\`\`json
{
  "schemaVersion": 1,
  "candidateId": ${input.candidateId},
  "applicationId": ${input.applicationId},
  "jobId": ${input.jobId ?? "null"},
  "tailoringRunId": ${input.tailoringRunId},
  "workflowId": ${input.workflowId},
  "iterationNumber": ${iterationNumber},
  "resume": {
    "name": "${candidateName}",
    "tagline": "Target Job Title / Specialization",
    "location": "City, State or Remote",
    "phone": "Phone",
    "email": "Email",
    "summary": [
      "Professional summary paragraph tailored directly to this JD..."
    ],
    "skillGroups": [
      {
        "label": "Category Name (e.g. Cloud & Data Platforms)",
        "items": ["Skill 1", "Skill 2", "Skill 3"]
      }
    ],
    "experience": [
      {
        "title": "Title (must match Master Resume)",
        "company": "Company (must match Master Resume)",
        "dates": "Dates (must match Master Resume)",
        "bullets": [
          "Action-oriented bullet with measurable impact and relevant technologies..."
        ]
      }
    ],
    "education": [
      "Degree, Major, Institution"
    ],
    "certifications": [
      "Certification Name"
    ]
  },
  "coverLetter": {
    "name": "${candidateName}",
    "location": "City, State",
    "phone": "Phone",
    "email": "Email",
    "salutation": "Dear Hiring Team,",
    "paragraphs": [
      "Opening paragraph...",
      "Core alignment paragraph...",
      "Closing paragraph..."
    ],
    "closing": "Sincerely,\\n${candidateName}"
  },
  "agentMetadata": {
    "provider": "claude-code | codex | antigravity | local | other",
    "model": "your-model-identifier",
    "completedAt": "${new Date().toISOString()}"
  },
  "writerValidation": {
    "instructionVersion": "${INSTRUCTION_VERSION}",
    "instructionHash": "${INSTRUCTION_HASH}",
    "checks": {
      "hardCareerFacts": "PASS | FAIL | REVIEW",
      "masterSkillsInventoryCompliance": "PASS | FAIL | REVIEW",
      "deepRewrite": "PASS | FAIL | REVIEW",
      "architectureIntegrity": "PASS | FAIL | REVIEW",
      "noContradictingTechnologies": "PASS | FAIL | REVIEW"
    },
    "notes": ["Optional free-text notes on anything you were unsure about."]
  }
}
\`\`\`

\`writerValidation\` is entirely optional and purely diagnostic — CareerOps computes its own independent \`instructionCompliance\` result over every guardrail regardless of what you report here, and a self-reported PASS never overrides a CareerOps-detected FAIL.
`;
}

/**
 * Builds the deterministic README.md for the handoff directory.
 */
export function buildExternalWriterReadme(iterationNumber: number): string {
  return `# External Resume Writer Agent Handoff Package — Iteration ${iterationNumber}

This directory contains a complete, self-contained handoff package for an external subscription agent (Claude Code, OpenAI Codex, Google Antigravity, or a local agent) to perform an iteration of resume quality improvement.

## Step-by-Step Instructions

1. **Review Instructions & Feedback**:
   - Read \`writer_prompt.md\` for exact task requirements and prior review feedback.
   - Read \`review_feedback.md\` and \`review.json\` (if present) for detailed scoring diagnostics.
2. **Examine Source Context**:
   - \`job_description.md\` — Full authoritative job posting.
   - \`extracted_job_requirements.json\` — Parsed JD requirements with criticality levels.
   - \`master_resume_reference.json\` / \`master_resume.txt\` — Candidate ground truth for employment history.
   - \`master_skills_inventory.md\` — Candidate verified technical skills inventory.
   - \`resume_tailoring_instructions.md\` — Core tailoring guardrails.
   - \`previous_resume_content.json\` — Structured JSON of the resume from the prior iteration.
3. **Perform Reasoning & Tailoring**:
   - Address all required corrections and blocking issues.
   - Preserve 100% truthfulness to the Master Resume.
   - Enhance ATS alignment and narrative clarity.
4. **Produce Output File**:
   - Write the finalized JSON result to **\`writer_output.json\`** in this exact directory.
   - Adhere strictly to \`schemaVersion: 1\` and the structure defined in \`writer_prompt.md\`.
5. **Safety Constraints**:
   - Do NOT edit or overwrite CareerOps source files.
   - Do NOT alter candidate, application, job, tailoring run, or workflow identity numbers.
   - Do NOT make external paid API calls from within CareerOps.
   - When finished writing \`writer_output.json\`, exit cleanly.
`;
}

/**
 * Exports a deterministic handoff package for external subscription agents (Stage 11).
 */
export function exportExternalWriterPackage(
  input: ExportExternalWriterPackageInput
): ExternalHandoffExportResult {
  const { candidateId, workflowId, overwriteExisting = false } = input;

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

  const targetIterationNumber = input.targetIterationNumber ?? (workflow.current_iteration === 0 ? 1 : workflow.current_iteration + 1);
  if (!Number.isInteger(targetIterationNumber) || targetIterationNumber <= 0) {
    throw new ResumeQualityOrchestrationError("INVALID_ITERATION", `Invalid target iteration: ${targetIterationNumber}`);
  }
  if (targetIterationNumber > workflow.max_iterations) {
    throw new ResumeQualityOrchestrationError(
      "ITERATION_EXCEEDS_MAX",
      `Target iteration ${targetIterationNumber} exceeds max_iterations (${workflow.max_iterations})`
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

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  const handoffDir = getHandoffDirectory(location, targetIterationNumber);

  if (fs.existsSync(handoffDir) && !overwriteExisting) {
    const existingFiles = fs.readdirSync(handoffDir);
    if (existingFiles.length > 0) {
      throw new ResumeQualityOrchestrationError(
        "HANDOFF_PACKAGE_ALREADY_EXISTS",
        `Handoff package for iteration ${targetIterationNumber} already exists at ${handoffDir}. Set overwriteExisting: true to replace.`
      );
    }
  }

  fs.mkdirSync(handoffDir, { recursive: true });

  const wsPkg = buildWorkspacePackage({
    candidateId,
    applicationId: workflow.application_id,
    dedupeKey: workflow.dedupe_key,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    runId: workflow.tailoring_run_id,
    selectedTrack: null,
    phase2Context: null,
  });

  const writerInput = buildResumeWriterInput(candidateId, workflowId);
  writerInput.iterationNumber = targetIterationNumber;

  const candidateName = `${candidate.first_name || ""} ${candidate.last_name || ""}`.trim() || "Candidate";

  const packageFiles: string[] = [];

  function writePackageFile(filename: string, content: string): string {
    const filePath = path.join(handoffDir, filename);
    fs.writeFileSync(filePath, content, "utf-8");
    packageFiles.push(filename);
    return filePath;
  }

  function copyPackageFile(srcPath: string, filename: string): boolean {
    if (fs.existsSync(srcPath)) {
      const destPath = path.join(handoffDir, filename);
      fs.copyFileSync(srcPath, destPath);
      packageFiles.push(filename);
      return true;
    }
    return false;
  }

  // 1. writer_input.json
  writePackageFile(
    "writer_input.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        candidateId,
        applicationId: workflow.application_id,
        jobId: tailoringRun.job_id,
        tailoringRunId: workflow.tailoring_run_id,
        workflowId: workflow.id,
        targetIterationNumber,
        selectedTrack: wsPkg.selectedTrack,
        dedupeKey: workflow.dedupe_key,
        instructionVersion: INSTRUCTION_VERSION,
        instructionHash: INSTRUCTION_HASH,
        requiredCorrections: writerInput.requiredCorrections ?? [],
        blockingIssues: writerInput.blockingIssues ?? [],
        currentResume: writerInput.currentResume,
        currentCoverLetter: writerInput.currentCoverLetter,
        latestReview: writerInput.latestReview,
        targetRoleTitle: getJobByDedupeKey(workflow.dedupe_key)?.title ?? null,
      },
      null,
      2
    )
  );

  // Stage 21 — compute the JD Priority Matrix/positioning/skill-order/ATS-coverage data the writer
  // prompt below actually embeds, so the writer sees the real ranked structure rather than only
  // prose guidance about it. The JD is never treated as candidate evidence here either — evidence
  // strength is computed against writerInput.masterProfile exclusively (see jdPriorityMatrix.ts).
  const exportTargetRoleTitle = getJobByDedupeKey(workflow.dedupe_key)?.title;
  const exportJdPriorityMatrix = buildJdPriorityMatrix(
    writerInput.jobRequirements,
    exportTargetRoleTitle ?? null,
    writerInput.masterProfile
  );
  const exportPositioningRecommendation = recommendedPositioningSummary(exportJdPriorityMatrix);
  const exportSkillOrder = writerInput.masterProfile ? recommendedSkillOrder(writerInput.masterProfile, exportJdPriorityMatrix) : [];
  const exportAtsCoverageText = writerInput.currentResume
    ? renderAtsCoverageReport(buildAtsCoverageReport(writerInput.currentResume, exportJdPriorityMatrix))
    : undefined;

  // 2. writer_prompt.md
  const promptContent = buildExternalWriterPrompt({
    candidateId,
    candidateName,
    applicationId: workflow.application_id,
    jobId: tailoringRun.job_id,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    iterationNumber: targetIterationNumber,
    selectedTrack: wsPkg.selectedTrack,
    latestReview: writerInput.latestReview,
    requiredCorrections: writerInput.requiredCorrections,
    blockingIssues: writerInput.blockingIssues,
    jdPriorityMatrix: exportJdPriorityMatrix,
    positioningRecommendation: exportPositioningRecommendation,
    recommendedSkillOrder: exportSkillOrder,
    atsCoverageReportText: exportAtsCoverageText,
  });
  writePackageFile("writer_prompt.md", promptContent);

  // 3. job_description.md
  if (!copyPackageFile(wsPkg.jobDescriptionPath, "job_description.md")) {
    if (writerInput.jobDescriptionMarkdown) {
      writePackageFile("job_description.md", writerInput.jobDescriptionMarkdown);
    } else {
      writePackageFile("job_description.md", "# Job Description\nNo description text available.");
    }
  }

  // 4. extracted_job_requirements.json
  if (!copyPackageFile(wsPkg.extractedJobRequirementsPath, "extracted_job_requirements.json")) {
    if (writerInput.jobRequirements) {
      writePackageFile("extracted_job_requirements.json", JSON.stringify(writerInput.jobRequirements, null, 2));
    } else {
      writePackageFile("extracted_job_requirements.json", "[]");
    }
  }

  // 5. resume_tailoring_instructions.md — ALWAYS the full canonical standard (CANONICAL_TAILORING_INSTRUCTIONS),
  // never the copyPackageFile fallback: wsPkg.tailoringInstructionsPath is populated only by a legacy
  // workspace-package path that the resume-quality POST route never writes to in practice, so relying
  // on it silently degraded every real handoff package down to a 1-line placeholder instead of the
  // real guardrails. The canonical module is the single source of truth (see canonicalInstructions.ts)
  // and is what CareerOps's own reviewer independently checks against, so the writer must see the
  // exact same text.
  writePackageFile(
    "resume_tailoring_instructions.md",
    `# Resume Tailoring Instructions\n\nInstruction version: ${INSTRUCTION_VERSION}\nInstruction hash (SHA-256): ${INSTRUCTION_HASH}\n\n---\n\n${CANONICAL_TAILORING_INSTRUCTIONS}`
  );

  // 6. master_resume_reference.json / master_resume.txt
  if (writerInput.masterProfile) {
    writePackageFile("master_resume_reference.json", JSON.stringify(writerInput.masterProfile, null, 2));
  } else if (!copyPackageFile(wsPkg.masterResumePath, "master_resume.txt")) {
    writePackageFile("master_resume_reference.json", "{}");
  }

  // 7. master_skills_inventory.md / master_skills.json
  if (!copyPackageFile(wsPkg.masterSkillsInventoryPath, "master_skills_inventory.md")) {
    writePackageFile("master_skills_inventory.md", "# Master Skills Inventory\nNo explicit skills inventory available.");
  }

  // 8. previous_resume_content.json & previous_cover_letter_content.json
  if (writerInput.currentResume) {
    writePackageFile("previous_resume_content.json", JSON.stringify(writerInput.currentResume, null, 2));
  }
  if (writerInput.currentCoverLetter) {
    writePackageFile("previous_cover_letter_content.json", JSON.stringify(writerInput.currentCoverLetter, null, 2));
  }

  // 9. review.json & review_feedback.md (if previous iteration exists)
  if (workflow.current_iteration > 0) {
    const priorIterDir = getIterationDirectory(location, workflow.current_iteration);
    copyPackageFile(path.join(priorIterDir, "review.json"), "review.json");
    copyPackageFile(path.join(priorIterDir, "review_feedback.md"), "review_feedback.md");
  }

  // 10. workflow_status.json
  const statusPayload: WorkflowStatusFile = {
    candidateId,
    applicationId: workflow.application_id,
    jobId: tailoringRun.job_id,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    currentIteration: workflow.current_iteration,
    targetIteration: targetIterationNumber,
    maxIterations: workflow.max_iterations,
    workflowStatus: workflow.status,
    latestOverallScore: workflow.latest_overall_score,
    qualityGateResult: workflow.status === "READY" ? "READY" : workflow.status === "FAILED" ? "FAILED" : "IMPROVEMENT_NEEDED",
    waitingFor: "EXTERNAL_WRITER",
    createdAt: workflow.created_at,
    updatedAt: workflow.updated_at,
  };
  writePackageFile("workflow_status.json", JSON.stringify(statusPayload, null, 2));

  // 11. README.md
  writePackageFile("README.md", buildExternalWriterReadme(targetIterationNumber));

  return {
    candidateId,
    applicationId: workflow.application_id,
    jobId: tailoringRun.job_id,
    tailoringRunId: workflow.tailoring_run_id,
    workflowId: workflow.id,
    targetIterationNumber,
    handoffDirectory: handoffDir,
    packageFiles,
    waitingStatus: "WAITING_FOR_EXTERNAL_WRITER",
  };
}
