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
import {
  CANONICAL_TAILORING_INSTRUCTIONS,
  INITIAL_GENERATION_INSTRUCTIONS,
  INSTRUCTION_HASH,
  INSTRUCTION_VERSION,
  buildTargetedRepairInstructions,
  classifyRepairInstructionPaths,
} from "../canonicalInstructions";
import { buildJdPriorityMatrix, type JdPriorityMatrix } from "../jdPriorityMatrix";
import { recommendedPositioningSummary } from "../positioningEngine";
import { recommendedSkillOrder } from "../skillRanking";
import { buildWorkspacePackage } from "../workspacePackage";
import { getIterationDirectory, getHandoffDirectory, getWorkspaceDirectory, type QualityWorkflowLocation } from "../workspace";
import { ensureResumeWriterRuntimeContract } from "../runtimeContract";
import { buildEmployerEvidenceMap, filterEmployerEvidenceMap, renderEmployerEvidenceSection } from "../employerEvidence";
import { buildResumeWriterInput, ResumeQualityOrchestrationError } from "../orchestrator";
import { employerScopeForRepair, renderRepairPlanSection } from "../repairScope";
import { deriveProfessionalIdentity, renderProfessionalIdentitySection } from "../professionalIdentity";
import {
  buildInitialGenerationMasterReference,
  buildRepairScopedMasterReference,
  shouldUseFullMasterReferenceForRepair,
} from "./masterReferenceProjection";
import { isPatchEligibleRepairPlan } from "./patchRepair";
import { projectResumeContextForPatchRepair, renderContextManifestSection, shouldOmitCoverLetterContext } from "./patchContextProjection";
import {
  collectRoleProjectEvidence,
  filterRoleProjectEvidence,
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
  /** PATCH-BASED TARGETED_REPAIR (2026-08-23) — the FULL ("resume."/"coverLetter."-prefixed)
   *  editable paths this repair authorizes, offered to the writer ONLY when
   *  patchRepair.ts's isPatchEligibleRepairPlan already confirmed every one of them is safely
   *  reconstructable. Absent (or on INITIAL_GENERATION) means the legacy full-document schema is
   *  used, exactly as before this feature existed. */
  patchEligiblePaths?: readonly string[];
  /** PHASE 2 TOKEN OPTIMIZATION (2026-08-23) — true when this handoff omitted
   *  previous_cover_letter_content.json entirely (see patchContextProjection.ts's
   *  shouldOmitCoverLetterContext). Only ever true alongside isPatchMode. */
  coverLetterContextOmitted?: boolean;
  /** PHASE 2 TOKEN OPTIMIZATION (2026-08-23) — compact, human-readable record of what this
   *  handoff's previous_resume_content.json actually contains, so the writer (and anyone debugging
   *  the package by hand) knows exactly what was reduced. Rendered verbatim; absent renders nothing. */
  contextManifestSection?: string;
  /** PHASE 3 / INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — describes exactly what
   *  resume_tailoring_instructions.md contains in THIS package whenever it is not the full,
   *  unmodified canonical standard, so the prompt's own description of the file can never overstate
   *  what it actually contains. Absent (undefined) means the file IS the complete document. */
  instructionsScopeNote?: string;
}): string {
  const { candidateName, iterationNumber, selectedTrack, latestReview, requiredCorrections, blockingIssues, blockingFailures } = input;
  const writerMode = input.writerMode ?? (input.repairPlanSection ? "TARGETED_REPAIR" : "INITIAL_GENERATION");
  const complianceCorrections = input.complianceCorrections ?? [];
  // PATCH-BASED TARGETED_REPAIR (2026-08-23) — only ever true for a repair the exporter has already
  // confirmed is patch-eligible (see exportExternalWriterPackage's own call to
  // isPatchEligibleRepairPlan before setting this). INITIAL_GENERATION never sets it.
  const isPatchMode = writerMode === "TARGETED_REPAIR" && (input.patchEligiblePaths?.length ?? 0) > 0;

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

  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — true only when every one of the five blocks
  // above is genuinely its vacuous "None"/default value. In the real orchestrator path this is
  // ALWAYS true for INITIAL_GENERATION (latestReview/requiredCorrections/blockingIssues/
  // blockingFailures/complianceCorrections are only ever populated alongside a repairPlan, which
  // forces writerMode to "TARGETED_REPAIR" — see orchestrator.ts's own
  // `writerMode: repairPlan ? "TARGETED_REPAIR" : "INITIAL_GENERATION"`) — but this is computed from
  // the actual rendered blocks, not assumed from writerMode alone, so a caller that somehow supplies
  // real content alongside "INITIAL_GENERATION" (the exact defensive scenario
  // promptAssemblyConsistency.test.ts's Phase L tests guard) still gets it rendered in full, never
  // silently dropped.
  const priorReviewIsEmpty =
    !latestReview &&
    correctionsBlock === "None identified." &&
    complianceBlock === "None — every named compliance check passes." &&
    blockingBlock === "None." &&
    blockingFailuresBlock === "None.";

  const rewriteRule =
    writerMode === "INITIAL_GENERATION"
      ? `**Initial generation must be genuinely tailored — light keyword replacement is a failure mode**:
   - Rewrite the summary, skills ordering, project descriptions, and experience bullets from the authoritative evidence so this first draft is specific to this JD and company.
   - Give each employer its own evidence-backed engineering identity. Do not make every role sound like the same project.
   - Bullet ceilings and summary/project-description requirements are stated in full above (WRITER OUTPUT QUALITY / RESUME PRESENTATION STANDARD) — this item exists only to state the deep-rewrite requirement itself, not to restate their numbers.`
      : isPatchMode
      ? `**Surgical repair, PATCH mode — return ONLY the changed values, never the full document**:
   - You will output PATCH OPERATIONS (see the schema below), not a full resume/cover letter.
   - Every operation's \`path\` must be one of the EXACT editable paths listed in the targeted-repair contract above — nothing else.
   - Do NOT reproduce \`previous_resume_content.json\`${input.coverLetterContextOmitted ? "" : "/`previous_cover_letter_content.json`"} content for a path you are not changing — omitting an editable path means CareerOps leaves it at its current value; you never need to restate it.
   - \`previous_resume_content.json\` in this package may already be a REDUCED view (some employers shown only by name/title/dates, not their bullets) — see the context manifest below. This is not missing data; those employers are frozen and unrelated to this repair.${
       input.coverLetterContextOmitted
         ? "\n   - This repair does not touch the cover letter and no finding concerns it — `previous_cover_letter_content.json` is not included in this package. Do not reference or invent cover-letter content."
         : ""
     }
   - Do not rewrite, improve, reorder, re-tailor, or rephrase any content outside the listed editable paths, even if you prefer different wording.
   - Previously resolved findings must not return: ${input.resolvedFindingKeys?.length ? input.resolvedFindingKeys.join(" | ") : "none recorded"}.
   - Any operation whose path is not in the editable-paths allowlist is rejected and fails the whole repair — when in doubt, omit it rather than guess.`
      : `**Surgical repair is mandatory — full/deep rewriting is forbidden**:
   - Start from \`previous_resume_content.json\` and \`previous_cover_letter_content.json\`.
   - Apply only the explicit repair operations and editable paths in the targeted-repair contract above.
   - Do not rewrite, improve, reorder, re-tailor, or rephrase any frozen content, even if you prefer different wording.
   - Previously resolved findings must not return: ${input.resolvedFindingKeys?.length ? input.resolvedFindingKeys.join(" | ") : "none recorded"}.
   - A substantially different resume is a failed repair. CareerOps deterministically rejects any collateral change before consuming a quality iteration.`;

  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — CRITICAL TAILORING GUARDRAILS list, built as
  // an array so item 4 can be adapted per mode without leaving a numbering gap. Item 4 used to be one
  // fixed two-part item ("resolve corrections" + "ensure JD keywords appear prominently") sent
  // unconditionally to every mode.
  //
  // "Resolve every CRITICAL/HIGH severity issue first" is dropped entirely: it is about
  // requiredCorrections/blockingIssues/blockingFailures, which are structurally always empty for
  // INITIAL_GENERATION (writerMode is only ever "INITIAL_GENERATION" when no prior review exists yet
  // — see orchestrator.ts's `writerMode: repairPlan ? "TARGETED_REPAIR" : "INITIAL_GENERATION"`, and
  // repairPlan is set in the exact same branch that populates those three fields) — dead instruction
  // on iteration 1 — and already fully covered for TARGETED_REPAIR by the REPAIR REVIEW CONTRACT
  // section, which points directly at the repair plan's own findings/operations.
  //
  // "Ensure JD keywords appear prominently in Technical Skills" is genuinely INITIAL_GENERATION-only
  // guidance (a targeted repair is explicitly forbidden from reordering Technical Skills unless
  // resume.skillGroups is itself an editable path — see rewriteRule's own "do not reorder" language —
  // so instructing every repair to reorder skills would contradict that rule), so it is kept only for
  // that mode.
  //
  // IMPORTANT: this item is the ONLY place extracted_job_requirements.json is named by filename
  // anywhere in the prompt — the external Claude Code CLI writer only reads files literally
  // referenced by name (see claudeCliInvoker.ts's DRIVING_PROMPT), so simply DROPPING this item for
  // TARGETED_REPAIR (as an earlier draft of this change did) would have silently made the file
  // unreachable for repair too, a real regression this fix caught before it shipped. TARGETED_REPAIR
  // therefore keeps its own, repair-appropriate reference to the same file below — reachable, but
  // framed as background only, never as license to reorder or add technologies outside its editable
  // paths.
  const guardrailItems = [
    `**Truthfulness & Factual Grounding (Absolute Rule — hard facts are immutable)**:
   - The Master Resume (\`master_resume_reference.json\` / \`master_resume.txt\`) is the **sole authoritative record** for employers, job titles, employment dates, education, certifications, and project attribution. These facts may never be changed, invented, or altered to fit the JD.
   - You must NEVER fabricate an employer, title, degree, certification, or client.
   - The Master Skills Inventory (\`master_skills_inventory.md\`) constrains what you may claim: only technologies genuinely present there (or in the Master Resume's own experience entries) may appear anywhere in the resume or cover letter — never introduce a technology solely because the JD mentions it.`,
    rewriteRule,
    `**Architecture integrity takes priority over raw keyword coverage**:
   - Maintain a coherent, believable technology architecture within each employer/project. Do not combine competing tools (e.g. Azure Data Factory + AWS Glue, or Databricks + EMR) in the same bullet or the same project unless explicitly and legitimately framed as a migration.
   - Prefer one primary technology per responsibility rather than listing every adjacent tool as a laundry list.`,
    writerMode === "INITIAL_GENERATION"
      ? `**JD Keyword Coverage**:
   - Ensure all dominant required job keywords from \`extracted_job_requirements.json\` appear prominently in Technical Skills and are evidenced in relevant experience bullets — but never at the cost of guardrail 1-3 above.`
      : `**JD Keyword Coverage (reference only)**:
   - \`extracted_job_requirements.json\` in this package is the same structured JD requirement data the JD PRIORITY MATRIX above was built from. It is background only: it does not license reordering Technical Skills or adding a technology outside your listed editable paths.`,
    `**Writing Style & Formatting — every bullet must be interview-defensible**:
   - Begin bullets with strong, varied action verbs (e.g. "Architected", "Engineered", "Optimized", "Spearheaded"), past tense for past roles.
   - NEVER use generic openers like "Responsible for" or "Worked on".
   - Avoid AI clichés (e.g., "testament to", "delve", "leverage synergy", "spearheaded revolution").
   - Every major achievement bullet should include quantifiable, realistic impact you could defend and elaborate on if asked about it in an interview — never an invented or exaggerated metric.`,
    `**Self-check before returning**: before writing \`writer_output.json\`, re-read \`resume_tailoring_instructions.md\` end to end and verify your draft against every guardrail in it (hard facts, MSI, architecture integrity, technology grouping, no contradicting technologies, metric inference policy, banned language, duplicate bullets, years/education honesty, bullet caps, verb tense). Report your own findings in the optional \`writerValidation\` field below — but note that this is diagnostic only and does not substitute for CareerOps's own independent review.`,
    `**Lock the resume before writing the cover letter**: finish and finalize the \`resume\` field FIRST, against the JD Priority Matrix below. Only once that resume is finalized, write the \`coverLetter\` field USING that finalized resume as one of its sources — never generate the cover letter from independent JD-only reasoning. Every technology or accomplishment the cover letter attributes to a specific past employer must be traceable to that SAME employer's bullets in the resume you just wrote (CareerOps's cross-document validator enforces this: e.g. a technology used only at Employer A can never be attributed to Employer B in the cover letter, even if it's genuinely evidenced elsewhere in your history).`,
  ];

  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — PRIOR QUALITY REVIEW FEEDBACK is omitted
  // entirely for INITIAL_GENERATION exactly when priorReviewIsEmpty (every block above is genuinely
  // its vacuous default) rather than rendered as five straight "None."/"None identified." subsections.
  // In the real orchestrator path this is ALWAYS the case for INITIAL_GENERATION — see
  // priorReviewIsEmpty's own comment for why — so nothing is lost by omitting it: the prompt already
  // states "Writer mode: INITIAL_GENERATION" and the iteration number at the top, so nothing is lost
  // by not restating "no prior review" a second time. If content SOMEHOW exists anyway (never true via
  // the real orchestrator, but a defensive fallback for a caller that supplies it directly — see
  // promptAssemblyConsistency.test.ts's Phase L tests), it is rendered in full, never silently dropped.
  const priorReviewSection =
    writerMode === "INITIAL_GENERATION"
      ? priorReviewIsEmpty
        ? ""
        : `## PRIOR QUALITY REVIEW FEEDBACK

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

  // PATCH-BASED TARGETED_REPAIR (2026-08-23) — the patch schema replaces the full-document schema
  // ONLY when isPatchMode; every field the writer must state (identity tokens, agentMetadata,
  // writerValidation) stays identical between the two so importer.ts's identity checks (candidateId/
  // applicationId/jobId/tailoringRunId/workflowId/iterationNumber — see importer.ts step 3) apply
  // unchanged to both.
  const outputSchemaSection = isPatchMode
    ? `### Strict JSON Output Schema — PATCH mode (\`writer_output.json\`)
\`\`\`json
{
  "schemaVersion": 2,
  "outputMode": "PATCH",
  "candidateId": ${input.candidateId},
  "applicationId": ${input.applicationId},
  "jobId": ${input.jobId ?? "null"},
  "tailoringRunId": ${input.tailoringRunId},
  "workflowId": ${input.workflowId},
  "iterationNumber": ${iterationNumber},
  "operations": [
    { "document": "resume", "path": "<one of the exact editable paths below>", "replacement": "<the new value for that path>" }
  ],
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

**The ONLY paths you may use** (each \`path\` above must be one of these exactly, relative to its \`document\` — e.g. for \`resume.summary[0]\` write \`"document": "resume", "path": "summary[0]"\`):
${(input.patchEligiblePaths ?? []).map((p) => `- \`${p}\``).join("\n")}

One \`operations\` entry per path you are actually changing — never one for a path you're leaving alone, and never more than one entry for the same path. \`replacement\` is a plain string for every path above except \`resume.skillGroups\`, whose replacement is the COMPLETE new skill-groups array (\`[{ "label": "...", "items": ["...", "..."] }]\`) — CareerOps replaces the whole array atomically, it does not merge it.

\`writerValidation\` is entirely optional and purely diagnostic — CareerOps computes its own independent \`instructionCompliance\` result over every guardrail regardless of what you report here, and a self-reported PASS never overrides a CareerOps-detected FAIL.`
    : `### Strict JSON Output Schema (\`writer_output.json\`)
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

\`writerValidation\` is entirely optional and purely diagnostic — CareerOps computes its own independent \`instructionCompliance\` result over every guardrail regardless of what you report here, and a self-reported PASS never overrides a CareerOps-detected FAIL.`;

  return `# External Resume Writer Agent Task — Iteration ${iterationNumber}

**Writer mode: ${writerMode}.**

## Role & Context
You are acting as an external expert resume tailoring agent for **${candidateName}**.
You are preparing **Iteration ${iterationNumber}** of a tailored, interview-defensible resume for a specific job opportunity.

Target Role Track: **${selectedTrack ?? "General Engineering Track"}**

---

## THE CANONICAL STANDARD IS MANDATORY

\`resume_tailoring_instructions.md\` in this package (instruction version **${INSTRUCTION_VERSION}**, full-standard hash \`${INSTRUCTION_HASH}\`) is drawn verbatim, word-for-word, from the authoritative Resume Tailoring System Instructions — never paraphrased or summarized. ${
    input.instructionsScopeNote ?? "It is the complete document."
  } You must follow every included section in its entirety, not just the highlights below. CareerOps will independently re-review your output against this exact same canonical text; nothing you self-report can substitute for actually satisfying it.

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

${input.repairPlanSection ?? ""}${input.contextManifestSection ?? ""}${input.professionalIdentitySection ?? ""}${input.presentationStandardSection ?? ""}${input.employerEvidenceSection ?? ""}${input.roleProjectEvidenceSection ?? ""}${input.experienceEmphasisSection ?? ""}${input.distributedEvidenceSection ?? ""}## CRITICAL TAILORING GUARDRAILS & OBJECTIVES

${guardrailItems.map((item, i) => `${i + 1}. ${item}`).join("\n\n")}

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

${outputSchemaSection}
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

  // SUMMARY QUALITY + WRITER TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR context reduction.
  //
  // Measured live (workflow 24, candidate 13, job 33017): a repair's writer_prompt.md was LARGER
  // than the initial generation's (55,517 vs 47,823 bytes), because every one of the six sections
  // below was computed and embedded UNCONDITIONALLY, with zero branching on writerMode — a repair
  // touching one bullet at one employer received the exact same full per-employer evidence dump,
  // full experience-emphasis plan, and full distributed-evidence plan as a from-scratch write. This
  // is the single largest safe optimization opportunity the architecture offers, because
  // repairScope.ts's own RepairOperation already carries a per-operation `employer` field — the
  // scoping information already exists, it was simply never used to shrink what gets exported.
  //
  // The reduction below touches ONLY the writer-facing PROJECTION, never the underlying evidence
  // engine: buildEmployerEvidenceMap/collectRoleProjectEvidence are still called against the FULL
  // CandidateProfile exactly as before, and repairPreservation.ts's post-hoc comparator (the actual
  // authority that accepts or rejects the writer's output) still validates against that same full,
  // untouched evidence regardless of what the writer itself was shown — see repairPreservation.ts.
  // Nothing here changes what CareerOps knows or verifies; it only changes what Claude has to read.
  const isTargetedRepair = writerInput.writerMode === "TARGETED_REPAIR";
  // `null` means "no filter — every employer" (the safe default whenever scope can't be determined,
  // e.g. no repairPlan, or an INITIAL_GENERATION pass, which always needs every employer's evidence
  // to write the resume from scratch in the first place). See employerScopeForRepair's own doc
  // comment for why an ambiguous/empty signal also resolves to "no filter" rather than "zero
  // employers".
  const repairEmployerScope: ReadonlySet<string> | null = isTargetedRepair ? employerScopeForRepair(writerInput.repairPlan) : null;

  const exportEmployerMap = writerInput.masterProfile ? buildEmployerEvidenceMap(writerInput.masterProfile) : undefined;
  const scopedEmployerMap = exportEmployerMap ? filterEmployerEvidenceMap(exportEmployerMap, repairEmployerScope) : undefined;

  const exportRoleEvidence = collectRoleProjectEvidence(writerInput.currentResume, writerInput.masterProfile);
  const scopedRoleEvidence = filterRoleProjectEvidence(exportRoleEvidence, repairEmployerScope);

  // PATCH-BASED TARGETED_REPAIR (2026-08-23) — offered only when isPatchEligibleRepairPlan has
  // already confirmed every one of this repair's editablePaths is a shape patchRepair.ts knows how
  // to reconstruct (never for a cover-letter path, a whole-array path other than skillGroups, or any
  // unrecognized shape). Fails toward the legacy full-document contract on any ambiguity — never
  // toward patch mode.
  const exportPatchEligiblePaths =
    isTargetedRepair && isPatchEligibleRepairPlan(writerInput.repairPlan?.editablePaths) ? writerInput.repairPlan!.editablePaths! : undefined;

  // PHASE 2 TOKEN OPTIMIZATION (2026-08-23) — computed once, before the prompt is built, and reused
  // both for the prompt's context-manifest section and for what actually gets written as
  // previous_resume_content.json/previous_cover_letter_content.json below, so the prompt's own
  // description of what it contains can never drift from what was actually written.
  const exportResumeProjection =
    isTargetedRepair && writerInput.currentResume
      ? projectResumeContextForPatchRepair(writerInput.currentResume, writerInput.repairPlan)
      : null;
  const exportOmitCoverLetter = isTargetedRepair && shouldOmitCoverLetterContext(writerInput.repairPlan);
  const exportContextManifestSection = exportResumeProjection
    ? renderContextManifestSection(exportResumeProjection.manifest, exportOmitCoverLetter)
    : "";

  // PHASE 3 TOKEN OPTIMIZATION (2026-08-23) — TARGETED_REPAIR CANONICAL-INSTRUCTION PROJECTION.
  //
  // resume_tailoring_instructions.md was, until now, always the full 28.4KB canonical standard —
  // the single largest fixed writer-read artifact, sent unconditionally regardless of how narrow the
  // repair was. Every section is CLASSIFIED (see canonicalInstructions.ts's own module-level
  // classification map) as either always-required (truthfulness/attribution/style guardrails a
  // writer producing ANY text still needs), conditional on what this repair's editablePaths actually
  // touch, or INITIAL_GENERATION-only framing that a scoped repair does not need and — in the case of
  // DEEP_REWRITE_REQUIREMENT/FINAL_QUALITY_STANDARD — would actively contradict ("rewrite outside
  // scope" vs. "every relevant sentence reconsidered").
  //
  // FAIL TOWARD FULL INSTRUCTIONS. Projection is used ONLY when every one of the following holds;
  // any other case — including every INITIAL_GENERATION — gets the complete, unmodified
  // CANONICAL_TAILORING_INSTRUCTIONS, exactly as before this feature existed:
  //   - this is a TARGETED_REPAIR
  //   - a repairPlan exists with a non-empty editablePaths (no plan / no paths means the repair's
  //     own scope was never narrowed to specific content, so neither can the instructions be)
  //   - classifyRepairInstructionPaths finds every single path a recognized shape (isFullyClassified)
  //     — one unrecognized path fails the WHOLE selection toward full text, never a partial guess
  // Patch-mode-vs-legacy and cover-letter-inclusion are read from the SAME signals already computed
  // above (exportPatchEligiblePaths, exportOmitCoverLetter) rather than re-derived independently, so
  // this can never disagree with what the rest of the handoff package already decided.
  const exportRepairEditablePaths = writerInput.repairPlan?.editablePaths;
  const exportInstructionSelection =
    isTargetedRepair && exportRepairEditablePaths && exportRepairEditablePaths.length > 0
      ? classifyRepairInstructionPaths(exportRepairEditablePaths)
      : null;
  const exportInstructionsProjected = exportInstructionSelection?.isFullyClassified === true;
  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — a genuine INITIAL_GENERATION handoff
  // (never a TARGETED_REPAIR fallback — that path is untouched, still CANONICAL_TAILORING_
  // INSTRUCTIONS in full, exactly as Phase 3 shipped it) gets INITIAL_GENERATION_INSTRUCTIONS: the
  // full canonical standard minus three sections proven obsolete for a writer under the current
  // architecture (OUTPUT_REQUIREMENTS, FILE_REQUIREMENTS, ATS_FORMATTING — see
  // canonicalInstructions.ts's own doc comment on INITIAL_GENERATION_INSTRUCTIONS for why each is
  // safe to omit). Still 100% verbatim canonical text.
  const exportTailoringInstructionsText = exportInstructionsProjected
    ? buildTargetedRepairInstructions(exportInstructionSelection!, {
        isPatchMode: exportPatchEligiblePaths !== undefined,
        includeCoverLetterSections: !exportOmitCoverLetter,
      })
    : isTargetedRepair
    ? CANONICAL_TAILORING_INSTRUCTIONS
    : INITIAL_GENERATION_INSTRUCTIONS;
  // Precise, honest description of what the file above actually contains — undefined only for the
  // true, complete, unmodified 33-section document (a TARGETED_REPAIR whose scope could not be
  // classified, falling back to CANONICAL_TAILORING_INSTRUCTIONS exactly as Phase 3 shipped it).
  const exportInstructionsScopeNote = exportInstructionsProjected
    ? "For this targeted repair it is a deterministic SUBSET: every section that governs what this repair's editable paths actually touch, selected by CareerOps — not by you, and not by relevance judgment at write time. Sections outside this repair's scope (e.g. from-scratch generation guidance) are omitted because they do not apply to a surgical repair, never because they were judged unimportant."
    : !isTargetedRepair
    ? "Three legacy sections are omitted (OUTPUT REQUIREMENTS, FILE REQUIREMENTS, ATS FORMATTING) because they describe deliverables/formatting you do not control under the current architecture — you produce one JSON file, writer_output.json, per the schema below; document generation and layout are handled entirely by CareerOps' own deterministic code. Every other section is included in full."
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
    employerEvidenceSection: scopedEmployerMap ? renderEmployerEvidenceSection(scopedEmployerMap) : undefined,
    repairPlanSection: writerInput.repairPlan ? renderRepairPlanSection(writerInput.repairPlan) : undefined,
    resolvedFindingKeys: writerInput.retryLineage?.resolvedFindingKeys,
    professionalIdentitySection: writerInput.masterProfile
      ? renderProfessionalIdentitySection(
          deriveProfessionalIdentity(writerInput.masterProfile),
          writerInput.masterProfile.totalYearsExperience ?? null
        )
      : undefined,
    // Bullet/skill ORDERING and DISTRIBUTED-EVIDENCE planning are both from-scratch positioning
    // aids — irrelevant to a surgical repair, which is explicitly forbidden from reordering or
    // re-tailoring content it wasn't asked to touch (see the repair rewrite rule below: "Do not
    // rewrite, improve, reorder, re-tailor"). Sending them during a repair contradicts the repair's
    // own instructions, not merely wastes context.
    experienceEmphasisSection: isTargetedRepair ? undefined : exportExperienceEmphasis || undefined,
    distributedEvidenceSection: isTargetedRepair ? undefined : exportDistributedEvidence || undefined,
    presentationStandardSection: renderPresentationStandardSection(writerInput.masterProfile),
    roleProjectEvidenceSection: renderRoleProjectEvidenceSection(scopedRoleEvidence),
    jdPriorityMatrix: exportJdPriorityMatrix,
    positioningRecommendation: exportPositioningRecommendation,
    recommendedSkillOrder: exportSkillOrder,
    atsCoverageReportText: exportAtsCoverageText,
    patchEligiblePaths: exportPatchEligiblePaths,
    coverLetterContextOmitted: exportOmitCoverLetter,
    contextManifestSection: exportContextManifestSection || undefined,
    instructionsScopeNote: exportInstructionsScopeNote,
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

  // 5. resume_tailoring_instructions.md — the copyPackageFile fallback is never used:
  // wsPkg.tailoringInstructionsPath is populated only by a legacy workspace-package path that the
  // resume-quality POST route never writes to in practice, so relying on it silently degraded every
  // real handoff package down to a 1-line placeholder instead of the real guardrails. The canonical
  // module (canonicalInstructions.ts) is the single source of truth CareerOps's own reviewer
  // independently checks against, so the writer must see verbatim text drawn from it.
  //
  // PHASE 3 TOKEN OPTIMIZATION (2026-08-23) — for a TARGETED_REPAIR whose editable paths were fully
  // classified (exportInstructionsProjected, computed above alongside every other repair-scoping
  // decision this package makes), this is the deterministic SECTION-BASED PROJECTION built by
  // buildTargetedRepairInstructions — every word still verbatim canonical text, just not every
  // section. Any TARGETED_REPAIR whose scope isn't cleanly classified still gets
  // CANONICAL_TAILORING_INSTRUCTIONS in full, unconditionally, exactly as before this feature
  // existed.
  //
  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — INITIAL_GENERATION gets
  // INITIAL_GENERATION_INSTRUCTIONS: the full standard minus three sections proven obsolete for any
  // writer under the current architecture (see canonicalInstructions.ts). Still verbatim canonical
  // text throughout.
  //
  // The header states the FULL-STANDARD hash either way (this is what CareerOps's own deterministic
  // review identity check actually compares against — see currentInstructionIdentity() — never the
  // literal byte content of this file), and explicitly says whether what follows is the complete
  // document or a scoped subset, so the writer is never misled about what it's looking at.
  writePackageFile(
    "resume_tailoring_instructions.md",
    `# Resume Tailoring Instructions\n\nInstruction version: ${INSTRUCTION_VERSION}\nFull-standard hash (SHA-256): ${INSTRUCTION_HASH}\n${
      exportInstructionsScopeNote ? `\nThis file is a DETERMINISTIC SUBSET of the full canonical standard. ${exportInstructionsScopeNote}\n` : "\nThis file is the complete canonical standard.\n"
    }\n---\n\n${exportTailoringInstructionsText}`
  );

  // 6. master_resume_reference.json / master_resume.txt
  //
  // TARGETED_REPAIR MASTER-REFERENCE SCOPING (2026-08-23) — the skills array is 79–86% of this file
  // (20–44 KB), and per-employer skill evidence is ALREADY rendered inline into writer_prompt.md by
  // renderEmployerEvidenceSection above. During TARGETED_REPAIR, the writer is forbidden from
  // re-tailoring frozen content, so the global skills dump serves no purpose the existing inline
  // employer evidence does not already cover. The compact projection omits `skills` entirely and
  // reduces untouched employer records to identity stubs, while keeping all hard-fact fields the
  // writer's truthfulness guardrails reference (employers, titles, dates, education, certifications,
  // totalYearsExperience).
  //
  // INITIAL_GENERATION TOKEN OPTIMIZATION (2026-08-23) — the SAME `skills` array is redundant for
  // INITIAL_GENERATION too, and provably more so: employerEvidenceSection is NEVER scoped for
  // INITIAL_GENERATION (repairEmployerScope is always null on this path — see its own computation
  // above), so every employer's complete supported/availableViaMsi/prohibitedHere breakdown is
  // already rendered in full, unconditionally, whenever a master profile exists at all — the exact
  // same condition under which this file gets written. Unlike the repair case, there is no scope
  // ambiguity dimension here, so buildInitialGenerationMasterReference needs no fallback condition of
  // its own (see its doc comment in masterReferenceProjection.ts for the full safety argument).
  //
  // SAFETY: both projections are writer-facing context only. The deterministic reviewer
  // (deterministicReviewer.ts), repairPreservation.ts, and every validation gate continue to receive
  // and validate against the FULL authoritative CandidateProfile — see orchestrator.ts L1268 and
  // deterministicReviewer.ts L95. Nothing here changes what CareerOps knows or verifies.
  //
  // FALLBACK: if the repair touches global sections (summary, tagline, skillGroups, education,
  // certifications), employer scope is ambiguous (null), or no repair plan exists, the full profile
  // is written exactly as before — fail toward MORE context, not less.
  if (writerInput.masterProfile) {
    const useFullForRepair =
      isTargetedRepair && (repairEmployerScope === null || shouldUseFullMasterReferenceForRepair(writerInput.repairPlan));
    const masterReferenceContent = useFullForRepair
      ? writerInput.masterProfile
      : isTargetedRepair
      ? buildRepairScopedMasterReference(writerInput.masterProfile, repairEmployerScope!)
      : buildInitialGenerationMasterReference(writerInput.masterProfile);
    writePackageFile("master_resume_reference.json", JSON.stringify(masterReferenceContent, null, 2));
  } else if (!copyPackageFile(wsPkg.masterResumePath, "master_resume.txt")) {
    writePackageFile("master_resume_reference.json", "{}");
  }

  // 7. master_skills_inventory.md / master_skills.json
  if (!copyPackageFile(wsPkg.masterSkillsInventoryPath, "master_skills_inventory.md")) {
    writePackageFile("master_skills_inventory.md", "# Master Skills Inventory\nNo explicit skills inventory available.");
  }

  // 8. previous_resume_content.json & previous_cover_letter_content.json
  //
  // PHASE 2 TOKEN OPTIMIZATION (2026-08-23) — for a patch-eligible repair, previous_resume_content
  // .json is the writer-facing PROJECTION (touched employers get a bounded bullet window, untouched
  // employers reduce to an identity stub) rather than the full document; previous_cover_letter_
  // content.json is omitted entirely when nothing about this repair concerns the cover letter. Both
  // reductions fail toward the ORIGINAL full content on any ambiguity (see patchContextProjection.ts)
  // and touch ONLY what the writer is shown — repairPreservation.ts and the deterministic reviewer
  // still validate against writerInput.currentResume/currentCoverLetter directly, never this
  // projection. INITIAL_GENERATION (isTargetedRepair false) always gets the original content, exactly
  // as before this feature existed. exportResumeProjection/exportOmitCoverLetter were already
  // computed above (before the prompt was built) so the prompt's own context-manifest description
  // can never drift from what's actually written here.
  if (writerInput.currentResume) {
    writePackageFile(
      "previous_resume_content.json",
      JSON.stringify(exportResumeProjection ? exportResumeProjection.resume : writerInput.currentResume, null, 2)
    );
  }
  if (writerInput.currentCoverLetter && !exportOmitCoverLetter) {
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
