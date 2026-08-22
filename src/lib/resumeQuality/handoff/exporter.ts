import fs from "node:fs";
import path from "node:path";
import { getCandidate } from "@/db/queries/candidates";
import { getJobByDedupeKey } from "@/db/queries/jobs";
import { getResumeQualityWorkflow } from "@/db/queries/resumeQualityWorkflows";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { getTailoringRun } from "@/db/queries/tailoringRuns";
import { deserializeJobMatchResult, getLatestJobMatchResult } from "@/db/queries/jobMatches";
import { buildTailoringPlan } from "@/lib/tailoringIntelligence/plan";
import { renderExperienceEmphasisSection, renderDistributedEvidenceSection } from "@/lib/tailoringIntelligence/writerSection";
import { buildAtsCoverageReport, renderAtsCoverageReport } from "../atsCoverageReport";
import { CANONICAL_TAILORING_INSTRUCTIONS, INSTRUCTION_HASH, INSTRUCTION_VERSION } from "../canonicalInstructions";
import { buildJdPriorityMatrix, type JdPriorityMatrix } from "../jdPriorityMatrix";
import { recommendedPositioningSummary } from "../positioningEngine";
import { recommendedSkillOrder } from "../skillRanking";
import { buildWorkspacePackage } from "../workspacePackage";
import { getIterationDirectory, getHandoffDirectory, getWorkspaceDirectory, type QualityWorkflowLocation } from "../workspace";
import { ensureResumeWriterRuntimeContract } from "../runtimeContract";
import { buildEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";
import { buildResumeWriterInput, ResumeQualityOrchestrationError } from "../orchestrator";
import { renderRepairPlanSection } from "../repairScope";
import { deriveProfessionalIdentity, renderProfessionalIdentitySection } from "../professionalIdentity";
import {
  collectRoleProjectEvidence,
  renderPresentationStandardSection,
  renderRoleProjectEvidenceSection,
} from "../presentationStructure";
import type {
  ExternalHandoffExportResult,
  RequiredCorrection,
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
  writerMode?: ResumeWriterInput["writerMode"];
  selectedTrack: string | null;
  latestReview?: StructuredResumeReview;
  requiredCorrections?: ResumeWriterInput["requiredCorrections"];
  blockingIssues?: string[];
  /** Stage 26 — the reviewer's HARD blocking failures. These are what actually withhold READY
   *  (qualityGate.ts condition 7) and can be non-empty while blockingIssues is empty, so a prompt that
   *  showed only the latter told the writer nothing about why it was rejected. */
  blockingFailures?: ResumeWriterInput["blockingFailures"];
  /** Stage 26B — every non-PASS compliance check that blocks READY, hard-gate and soft-gate alike,
   *  each carrying the reviewer's own reason. */
  complianceCorrections?: RequiredCorrection[];
  /** Stage 26B — verified real contact details, stated to the writer as immutable facts. */
  candidateContact?: ResumeWriterInput["candidateContact"];
  /** Stage 28 — per-employer supported/not-evidenced technologies, so cross-employer attribution is
   *  prevented BEFORE writing rather than caught afterwards. See employerEvidence.ts. */
  employerEvidenceSection?: string;
  /** Stage 28 — the targeted-repair brief for a correction attempt. Absent on iteration 1. */
  repairPlanSection?: string;
  /** Findings proven resolved in the retry lineage. They are guardrails, never new edit tasks. */
  resolvedFindingKeys?: string[];
  /** Stage 30 — the candidate's own professional identity, so the headline and summary lead with who
   *  the candidate is rather than with the job's title. */
  professionalIdentitySection?: string;
  /** Stage 31 — the reference presentation standard: section order, the Project:/Environment: lines
   *  and the evidence rules that govern them. Structure only — never the reference's content. */
  presentationStandardSection?: string;
  /** Stage 31 correction — the per-employer material the Project:/Environment: lines are built from.
   *  Without it the writer was being asked for a scope line with no evidence in front of it. */
  roleProjectEvidenceSection?: string;
  /** Stage 21 (Evidence-Grounded Resume Quality V2) — the computed JD Priority Matrix/positioning/
   *  skill-order/ATS-coverage data the writer should actually USE, not just prose guidance about it.
   *  All optional: absent only when neither jobRequirements nor a target role title were available
   *  at export time (never fabricated to fill the gap). */
  /** Additive — job-specific employer emphasis order. Absent leaves the prompt exactly as it was.
   *  See tailoringIntelligence/writerSection.ts for why it carries only the ordering. */
  experienceEmphasisSection?: string;
  /** Additive — distributed-evidence guidance for depth-requested JD requirements the candidate can
   *  evidence at more than one compatible employer. Same absent-means-unchanged contract as above. */
  distributedEvidenceSection?: string;
  jdPriorityMatrix?: JdPriorityMatrix;
  positioningRecommendation?: string;
  recommendedSkillOrder?: string[];
  atsCoverageReportText?: string;
}): string {
  const { candidateName, iterationNumber, selectedTrack, latestReview, requiredCorrections, blockingIssues, blockingFailures } = input;
  const writerMode = input.writerMode ?? (input.repairPlanSection ? "TARGETED_REPAIR" : "INITIAL_GENERATION");
  const complianceCorrections = input.complianceCorrections ?? [];

  // Stated as hard facts, in the same breath as the truthfulness guardrail, because that is exactly
  // what they are: the writer may format them but must never substitute or invent one. Before this
  // block existed the handoff exposed no contact details at all, so a writer correctly refusing to
  // fabricate produced an empty header and the DOCX renderer rejected the document outright.
  const contactBlock = input.candidateContact
    ? [
        `- Full name: ${input.candidateContact.name}`,
        `- Email: ${input.candidateContact.email}`,
        `- Phone: ${input.candidateContact.phone}`,
        `- Location: ${input.candidateContact.location}`,
        ...(input.candidateContact.linkedin ? [`- LinkedIn: ${input.candidateContact.linkedin}`] : []),
        ...(input.candidateContact.github ? [`- GitHub: ${input.candidateContact.github}`] : []),
      ].join("\n")
    : "NOT PROVIDED — do not invent any contact value; CareerOps stops a workflow before this point when contact details are missing.";

  // The reviewer already emits a boilerplate "Canonical instruction compliance — <check>: <status>"
  // correction for each failing HARD gate. Those same checks now appear in the dedicated compliance
  // block below, with their reasons attached, so they are filtered out here rather than stated twice.
  const complianceBoilerplate = /^Canonical instruction compliance — /;
  const otherCorrections = (requiredCorrections ?? []).filter((c) => !complianceBoilerplate.test(c.description));

  const correctionsBlock =
    otherCorrections.length > 0 ? otherCorrections.map((c) => `- **[${c.priority}]**: ${c.description}`).join("\n") : "None identified.";

  // Never "None identified." while the gate is actually blocking on a compliance check — that exact
  // contradiction is what made a real writer rewrite blind and regress.
  const complianceBlock =
    complianceCorrections.length > 0
      ? complianceCorrections.map((c) => `- **[${c.priority}]**: ${c.description}`).join("\n")
      : "None — every named compliance check passes.";

  const blockingBlock =
    blockingIssues && blockingIssues.length > 0
      ? blockingIssues.map((b) => `- **[BLOCKING]**: ${b}`).join("\n")
      : "None.";

  // Rendered with the reviewer's own recommendedCorrection so the writer is told exactly what to do,
  // not merely that something is wrong. Observed on the real corpus: four PLACEHOLDER_CONTACT failures
  // withheld approval from a resume scoring 100 across the board, and appeared in no feedback the
  // writer could see — so the next iteration would have repeated the same mistake.
  const blockingFailuresBlock =
    blockingFailures && blockingFailures.length > 0
      ? blockingFailures
          .map((f) => `- **[${f.type}]**: ${f.description}${f.recommendedCorrection ? `\n  - Correction: ${f.recommendedCorrection}` : ""}`)
          .join("\n")
      : "None.";

  const scoresBlock = latestReview
    ? `- Overall Quality Score: ${latestReview.overallScore}/100
- ATS Keyword Alignment Score: ${latestReview.atsScore}/100
- Truthfulness / Master Profile Consistency: ${latestReview.truthfulnessScore}/100
- Architecture & Technology Consistency: ${latestReview.architectureConsistencyScore}/100
- Recruiter Readability Score: ${latestReview.recruiterReadabilityScore}/100
- Formatting & Structural Completeness Score: ${latestReview.formattingScore}/100`
    : "Initial tailoring iteration (no prior review scores).";

  const rewriteRule =
    writerMode === "INITIAL_GENERATION"
      ? `2. **Initial generation must be genuinely tailored — light keyword replacement is a failure mode**:
   - Rewrite the summary, skills ordering, project descriptions, and experience bullets from the authoritative evidence so this first draft is specific to this JD and company.
   - The summary must be 3-4 concise recruiter-facing sentences with varied construction: target role, strongest relevant platform/capability, supported domain context, and 2-4 grounded differentiators. Do not use repetitive "Expertise spans" / "Proven ability" templates or dump technologies.
   - Give each employer its own evidence-backed engineering identity. Do not make every role sound like the same project. Project descriptions are 1-2 short sentences about objective and architecture, never stack dumps.
   - Bullet ceilings remain 7 / 6 / 5 by role recency and 18 total; ceilings are not targets. Add a bullet only for distinct employer-supported evidence that materially improves JD alignment.`
      : `2. **Surgical repair is mandatory — full/deep rewriting is forbidden**:
   - Start from \`previous_resume_content.json\` and \`previous_cover_letter_content.json\`.
   - Apply only the explicit repair operations and editable paths in the targeted-repair contract above.
   - Do not rewrite, improve, reorder, re-tailor, or rephrase any frozen content, even if you prefer different wording.
   - Previously resolved findings must not return: ${input.resolvedFindingKeys?.length ? input.resolvedFindingKeys.join(" | ") : "none recorded"}.
   - A substantially different resume is a failed repair. CareerOps deterministically rejects any collateral change before consuming a quality iteration.`;

  const priorReviewSection =
    writerMode === "INITIAL_GENERATION"
      ? `## PRIOR QUALITY REVIEW FEEDBACK

### Review Scores
${scoresBlock}

### Hard Blocking Failures — these alone prevent approval, resolve every one
${blockingFailuresBlock}

### Compliance Checks Blocking Approval — every one of these must reach PASS
${complianceBlock}

### Blocking Issues to Resolve
${blockingBlock}

### Required Corrections
${correctionsBlock}`
      : `## REPAIR REVIEW CONTRACT

The normalized root findings and explicit operations in **TARGETED REPAIR** above are the complete content-edit instructions for this pass. Raw compliance statuses, duplicate reporting layers, and the derived \`finalValidation\` status are deliberately not repeated as separate writing tasks. The full CareerOps validator still runs after the repair.`;

  return `# External Resume Writer Agent Task — Iteration ${iterationNumber}

**Writer mode: ${writerMode}.**

## Role & Context
You are acting as an external expert resume tailoring agent for **${candidateName}**.
You are preparing **Iteration ${iterationNumber}** of a tailored, interview-defensible resume for a specific job opportunity.

Target Role Track: **${selectedTrack ?? "General Engineering Track"}**

---

## THE CANONICAL STANDARD IS MANDATORY

\`resume_tailoring_instructions.md\` in this package (instruction version **${INSTRUCTION_VERSION}**, hash \`${INSTRUCTION_HASH}\`) is the full, authoritative Resume Tailoring System Instructions — not a summary. You must follow it in its entirety, not just the highlights below. CareerOps will independently re-review your output against this exact same text; nothing you self-report can substitute for actually satisfying it.

## CANDIDATE CONTACT DETAILS — VERIFIED HARD FACTS, REPRODUCE EXACTLY
${contactBlock}

These are hard facts in the sense of guardrail 1 below: you may not alter, abbreviate, re-format
into a different value, or substitute a placeholder for any of them, and you
must never invent one that is missing.

Where each value goes:
- **Full name, email, phone, location** — reproduce verbatim in BOTH the resume and the cover letter
  header. These four must be character-for-character identical in the two documents.
- **LinkedIn** — resume only, and only when given above. The cover letter header does not carry it.
  Omitting it from the cover letter is correct and is not an inconsistency between the documents.

${input.repairPlanSection ?? ""}${input.professionalIdentitySection ?? ""}${input.presentationStandardSection ?? ""}${input.roleProjectEvidenceSection ?? ""}${input.employerEvidenceSection ?? ""}${input.experienceEmphasisSection ?? ""}${input.distributedEvidenceSection ?? ""}## CRITICAL TAILORING GUARDRAILS & OBJECTIVES

1. **Truthfulness & Factual Grounding (Absolute Rule — hard facts are immutable)**:
   - The Master Resume (\`master_resume_reference.json\` / \`master_resume.txt\`) is the **sole authoritative record** for employers, job titles, employment dates, education, certifications, and project attribution. These facts may never be changed, invented, or altered to fit the JD.
   - You must NEVER fabricate an employer, title, degree, certification, or client.
   - The Master Skills Inventory (\`master_skills_inventory.md\`) constrains what you may claim: only technologies genuinely present there (or in the Master Resume's own experience entries) may appear anywhere in the resume or cover letter — never introduce a technology solely because the JD mentions it.

${rewriteRule}

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

${priorReviewSection}

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
    "tagline": "<candidate's professional identity> | <JD-relevant specialization> | <key technologies>",
    "location": "City, State or Remote",
    "phone": "Phone",
    "email": "Email",
    "summary": [
      "Opens by naming the candidate's professional identity and the specialization this JD needs — never 'Engineer with...', 'Professional with...' or any other generic opener, and never a years-of-experience figure CareerOps has not verified..."
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
        "location": "City, ST — OMIT this field entirely unless the Master Resume states it",
        "dates": "Dates (must match Master Resume)",
        "projectDescription": "One sentence naming what this role's work was — restating ONLY scope this same role's bullets already establish. Never a new system, client, domain or metric.",
        "bullets": [
          "Action-oriented bullet with measurable impact and relevant technologies..."
        ],
        "environment": ["Only technologies THIS employer's evidence supports", "..."]
      }
    ],
    "keyProjects": [
      { "name": "Project name", "description": "What it does", "technologies": ["..."], "url": "https://... (only if the Master Resume records one)" }
    ],
    "education": [
      "Degree, Institution - Dates"
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
  const runtimeContract = ensureResumeWriterRuntimeContract(getWorkspaceDirectory(location));

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
        runtimeContract,
        requiredCorrections: writerInput.requiredCorrections ?? [],
        blockingIssues: writerInput.blockingIssues ?? [],
        blockingFailures: writerInput.blockingFailures ?? [],
        complianceCorrections: writerInput.complianceCorrections ?? [],
        candidateContact: writerInput.candidateContact,
        // Structured, auditable record of what Stage 28 decided. The human-readable renderings of
        // both live in writer_prompt.md; duplicating that prose here would double the package size.
        employerEvidenceEmployers: writerInput.masterProfile
          ? buildEmployerEvidenceMap(writerInput.masterProfile).employers.map((e) => ({
              employer: e.employer,
              supportedCount: e.supported.length,
              msiAvailableCount: e.availableViaMsi.length,
              prohibitedCount: e.prohibitedHere.length,
            }))
          : undefined,
        repairPlan: writerInput.repairPlan,
        writerMode: writerInput.writerMode,
        retryLineage: writerInput.retryLineage,
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
  /* Additive Tailoring Intelligence: which of this candidate's roles carry the most weight for
   * THIS posting. Built from the match result Phase 2 already persisted — never re-evaluated here,
   * so the writer sees the same evidence the rest of the app shows. Absent when the job has not
   * been evaluated or no profile is loaded, in which case the prompt is unchanged. */
  const exportMatchRow = getLatestJobMatchResult(candidateId, workflow.dedupe_key);
  const exportTailoringPlan =
    exportMatchRow && writerInput.masterProfile
      ? buildTailoringPlan(deserializeJobMatchResult(exportMatchRow), writerInput.masterProfile)
      : null;
  const exportExperienceEmphasis = exportTailoringPlan ? renderExperienceEmphasisSection(exportTailoringPlan) : undefined;
  /* Distributed-evidence guidance — same plan, computed once above and reused here rather than a
   * second buildTailoringPlan call, so the two sections can never see different evidence. */
  const exportDistributedEvidence = exportTailoringPlan ? renderDistributedEvidenceSection(exportTailoringPlan) : undefined;

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
    writerMode: writerInput.writerMode,
    selectedTrack: wsPkg.selectedTrack,
    latestReview: writerInput.latestReview,
    requiredCorrections: writerInput.requiredCorrections,
    blockingIssues: writerInput.blockingIssues,
    blockingFailures: writerInput.blockingFailures,
    complianceCorrections: writerInput.complianceCorrections,
    candidateContact: writerInput.candidateContact,
    employerEvidenceSection: writerInput.masterProfile
      ? renderEmployerEvidenceSection(buildEmployerEvidenceMap(writerInput.masterProfile))
      : undefined,
    repairPlanSection: writerInput.repairPlan ? renderRepairPlanSection(writerInput.repairPlan) : undefined,
    resolvedFindingKeys: writerInput.retryLineage?.resolvedFindingKeys,
    professionalIdentitySection: writerInput.masterProfile
      ? renderProfessionalIdentitySection(
          deriveProfessionalIdentity(writerInput.masterProfile),
          writerInput.masterProfile.totalYearsExperience ?? null
        )
      : undefined,
    experienceEmphasisSection: exportExperienceEmphasis || undefined,
    distributedEvidenceSection: exportDistributedEvidence || undefined,
    presentationStandardSection: renderPresentationStandardSection(writerInput.masterProfile),
    roleProjectEvidenceSection: renderRoleProjectEvidenceSection(
      collectRoleProjectEvidence(writerInput.currentResume, writerInput.masterProfile)
    ),
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
