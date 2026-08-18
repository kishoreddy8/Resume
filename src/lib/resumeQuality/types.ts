import { z } from "zod";
import type { CoverLetterContent, ResumeContent } from "../../../tools/tailoring-engine/types";
export type { CoverLetterContent, ResumeContent };
// Stage 21 (Evidence-Grounded Resume Quality V2) — type-only imports, erased at compile time, so
// this creates no runtime circularity even though jdPriorityMatrix.ts/recruiterQualityGate.ts/
// atsCoverageReport.ts themselves import types FROM this file (e.g. ComplianceStatus).
import { JD_PRIORITY_TIERS, EVIDENCE_STRENGTHS, type JdPriorityMatrix } from "./jdPriorityMatrix";
import type { RecruiterQualityAssessment } from "./recruiterQualityGate";
import { ATS_COVERAGE_STATUSES, type AtsCoverageEntry } from "./atsCoverageReport";
// Type-only reuse of Phase 2's own JD-requirement and candidate-profile models — read-only import,
// zero Phase 2 logic touched. This is exactly "reuse existing types, don't invent a duplicate
// schema": RequirementUnit already IS the structured JD-side requirement model (criticality,
// requirementLevel, canonical memberSkillNames) and CandidateProfile already IS the structured
// Master Resume/Skills Inventory model Stage 8's deterministic reviewer needs to compare against.
import type { CandidateProfile, RequirementUnit } from "@/lib/match/types";

/**
 * Phase 3 Stage 7 — data contracts for the future multi-stage AI resume quality pipeline
 * (Application → Tailoring Run → AI Writer → AI Reviewer → Improvement → Reviewer → Final Approved
 * Resume). FOUNDATION ONLY: nothing in this module calls an AI provider, and nothing in this module
 * is wired into src/lib/tailoringExecution.ts or the execution bridge — see resume_quality_workflows'
 * own schema.sql comment for the full identity/lifecycle design record.
 *
 * The existing Resume Tailoring System Instructions (SKILL.md) remain the sole authority on tailoring
 * methodology. This pipeline evaluates and iterates on OUTPUT quality against those instructions —
 * it never redefines or replaces them.
 */

// --- Workflow status ------------------------------------------------------------------------------

/** Mirrors resume_quality_workflows.status exactly — see stateMachine.ts for the legal transition
 *  graph between these. No "execute the AI" step exists yet; this is the state shape only. */
export type WorkflowStatus =
  | "CREATED"
  | "WRITER_RUNNING"
  | "WRITER_COMPLETED"
  | "REVIEW_RUNNING"
  | "REVIEW_COMPLETED"
  | "IMPROVEMENT_RUNNING"
  | "READY"
  | "FAILED";

export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  "CREATED",
  "WRITER_RUNNING",
  "WRITER_COMPLETED",
  "REVIEW_RUNNING",
  "REVIEW_COMPLETED",
  "IMPROVEMENT_RUNNING",
  "READY",
  "FAILED",
] as const;

/** A workflow that hasn't met the quality gate after DEFAULT_MAX_ITERATIONS lands in FAILED with a
 *  failure_reason explaining it needs human review — there is no separate terminal status for that
 *  case; the 8 statuses above are the complete, deliberately-fixed set (see the Stage 7 spec). */
export const DEFAULT_MAX_ITERATIONS = 3;

// --- Structured review contract (Section 6) --------------------------------------------------------

export const CORRECTION_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;
export type CorrectionPriority = (typeof CORRECTION_PRIORITIES)[number];

export interface RequiredCorrection {
  priority: CorrectionPriority;
  description: string;
}

/** The authoritative machine-readable review format a future ResumeReviewerAgent produces. A
 *  human-readable resume_review_feedback.md is rendered FROM this, never the other way around — this
 *  is deliberately the source of truth, matching "Prefer structured JSON as the authoritative
 *  machine-readable review format" from the Stage 7 spec. A numeric score alone can never imply
 *  READY — see qualityGate.ts, which also requires zero blockingIssues and perfect
 *  truthfulness/architecture scores regardless of overallScore. */
export interface StructuredResumeReview {
  overallScore: number; // 0-100
  atsScore: number;
  keywordAlignmentScore: number;
  truthfulnessScore: number;
  architectureConsistencyScore: number;
  recruiterReadabilityScore: number;
  formattingScore: number;

  missingRequiredSkills: string[];
  incorrectTechnologyUsage: string[];
  genericBullets: string[];
  missingImpactEvidence: string[];
  summaryIssues: string[];
  skillsOrderingIssues: string[];
  truthfulnessIssues: string[];
  blockingIssues: string[];
  requiredCorrections: RequiredCorrection[];

  /** Additive (Resume Quality Hardening) — optional so pre-hardening review objects/legacy DB rows
   *  still satisfy this interface structurally; see the module doc comment above
   *  structuredResumeReviewSchema and qualityGate.ts's own "absent = never READY" handling. The
   *  CURRENT DeterministicResumeReviewer always populates both for every fresh review. */
  instructionCompliance?: InstructionComplianceResult;
  metricProvenance?: MetricProvenanceResult;

  /** Additive (Stage 21 — Evidence-Grounded Resume Quality V2). Optional for the exact same
   *  backward-compatibility reason as instructionCompliance above; qualityGate.ts treats absence as
   *  failure, never a free pass. The CURRENT DeterministicResumeReviewer always populates this. */
  blockingFailures?: BlockingFailure[];

  /** Additive (Stage 21 NEXT 1-9). Optional for the same backward-compatibility reason as every other
   *  Stage 21 field. The JD Priority Matrix this review was computed against — kept on the review so
   *  final artifacts (instruction_snapshot-style provenance) and the ATS coverage report renderer can
   *  reference the exact ranking without recomputing it. */
  jdPriorityMatrix?: JdPriorityMatrix;
  /** qualityGate.ts requires this present with status !== "FAIL" for READY — see recruiterQualityGate.ts. */
  recruiterQualityAssessment?: RecruiterQualityAssessment;
  /** Reporting only (Phase 15/NEXT 9) — never a gate condition on its own; see atsCoverageReport.ts's
   *  own "UNSUPPORTED must never become an inserted keyword" invariant. */
  atsCoverageReport?: AtsCoverageEntry[];
}

// --- Typed blocking failures (additive — Stage 21 Evidence-Grounded Resume Quality V2) --------------
//
// A separate, named taxonomy from instructionCompliance's 22 canonical-guardrail checks (which stay
// fixed to the canonical instruction text's own enumerated names/hash). This layer exists so a
// specific class of defect — unsupported claim, unsupported metric, placeholder contact, date/
// employer/certification contradiction, cross-artifact contradiction — can be reported with WHY it
// failed (evidence searched, a supported alternative, a recommended correction) rather than only a
// PASS/FAIL verdict. evaluateQualityGate() requires this array to be present and empty for READY,
// exactly mirroring instructionCompliance's "absence is failure, never a free pass" rule.

export const BLOCKING_FAILURE_TYPES = [
  "UNSUPPORTED_CLAIM",
  "UNSUPPORTED_METRIC",
  "PLACEHOLDER_CONTACT",
  "DATE_CONTRADICTION",
  "EMPLOYER_CONTRADICTION",
  "CERTIFICATION_CONTRADICTION",
  "CROSS_ARTIFACT_CONTRADICTION",
] as const;
export type BlockingFailureType = (typeof BLOCKING_FAILURE_TYPES)[number];

export interface BlockingFailure {
  type: BlockingFailureType;
  description: string;
  /** Where CareerOps looked for supporting evidence before concluding this is unsupported — e.g.
   *  ["Comerica bullets", "Master Skills Inventory", "Master Resume"]. Optional: not every failure
   *  type has a meaningful evidence search (e.g. PLACEHOLDER_CONTACT doesn't search for evidence). */
  evidenceSearched?: string[];
  /** A weaker claim that IS supported, when one exists — e.g. "improved pipeline reliability"
   *  instead of the unsupported "reduced pipeline failures by 30%". */
  supportedAlternative?: string;
  recommendedCorrection?: string;
}

const scoreSchema = z.number().min(0).max(100);

// --- Canonical instruction compliance (additive — Resume Quality Hardening) ------------------------
//
// One PASS/FAIL/REVIEW verdict per named guardrail from the canonical Resume Tailoring System
// Instructions (see canonicalInstructions.ts) — CareerOps's own independent evaluation, never the
// external writer's self-reported writerValidation (see ExternalWriterOutput.writerValidation
// below, which is provenance-only and never gates anything). Field names are the exact canonical
// guardrail names, matching the hardening spec's own "instructionCompliance.checks.*" naming.

export const COMPLIANCE_STATUSES = ["PASS", "FAIL", "REVIEW"] as const;
export type ComplianceStatus = (typeof COMPLIANCE_STATUSES)[number];

/** Every canonical guardrail CareerOps independently evaluates. See instructionCompliance.ts for
 *  which of these are hard gates (block READY on FAIL) vs. soft/quality signals (feed score/
 *  corrections, block READY only on material violation) — HARD_GATE_CHECKS there is the single
 *  authoritative list; this interface only defines the shape. */
export interface InstructionComplianceChecks {
  hardCareerFacts: ComplianceStatus;
  masterSkillsInventoryCompliance: ComplianceStatus;
  deepRewrite: ComplianceStatus;
  architectureIntegrity: ComplianceStatus;
  technologyGrouping: ComplianceStatus;
  onePrimaryTechnologyPerResponsibility: ComplianceStatus;
  metricInferencePolicy: ComplianceStatus;
  keywordOptimization: ComplianceStatus;
  technologyAdaptation: ComplianceStatus;
  migrationIntegrity: ComplianceStatus;
  noContradictingTechnologies: ComplianceStatus;
  bulletWriting: ComplianceStatus;
  everySentenceAtsChecklist: ComplianceStatus;
  crossDocumentConsistency: ComplianceStatus;
  bannedLanguage: ComplianceStatus;
  noDuplicateBulletPhrasing: ComplianceStatus;
  yearsExperienceEducationHonesty: ComplianceStatus;
  employmentTypeHandling: ComplianceStatus;
  resumeLengthBulletCaps: ComplianceStatus;
  verbTenseConsistency: ComplianceStatus;
  atsFormatting: ComplianceStatus;
  finalValidation: ComplianceStatus;
}

export const INSTRUCTION_COMPLIANCE_CHECK_NAMES: readonly (keyof InstructionComplianceChecks)[] = [
  "hardCareerFacts",
  "masterSkillsInventoryCompliance",
  "deepRewrite",
  "architectureIntegrity",
  "technologyGrouping",
  "onePrimaryTechnologyPerResponsibility",
  "metricInferencePolicy",
  "keywordOptimization",
  "technologyAdaptation",
  "migrationIntegrity",
  "noContradictingTechnologies",
  "bulletWriting",
  "everySentenceAtsChecklist",
  "crossDocumentConsistency",
  "bannedLanguage",
  "noDuplicateBulletPhrasing",
  "yearsExperienceEducationHonesty",
  "employmentTypeHandling",
  "resumeLengthBulletCaps",
  "verbTenseConsistency",
  "atsFormatting",
  "finalValidation",
];

export interface InstructionComplianceResult {
  instructionVersion: string;
  instructionHash: string;
  checks: InstructionComplianceChecks;
  /** Human-readable detail per failed/review-flagged check — parallel diagnostic detail, not a
   *  replacement for requiredCorrections (which stays the single actionable-corrections list). */
  notes: string[];
  /** Stage 26B — the SAME note strings as `notes`, additionally attributed to the check that produced
   *  them. `notes` remains the flat, order-preserving list it always was; this only records which
   *  check each line came from, so a correction can carry its own concrete reason instead of a bare
   *  "<check>: REVIEW". A check with no recorded note simply has no entry — nothing is invented to
   *  fill the gap. Optional so a legacy persisted review without it still parses. */
  checkNotes?: Partial<Record<keyof InstructionComplianceChecks, string[]>>;
}

const complianceStatusSchema = z.enum(COMPLIANCE_STATUSES);

const instructionComplianceChecksSchema = z
  .object(
    Object.fromEntries(INSTRUCTION_COMPLIANCE_CHECK_NAMES.map((name) => [name, complianceStatusSchema])) as Record<
      keyof InstructionComplianceChecks,
      typeof complianceStatusSchema
    >
  )
  .strict();

const instructionComplianceResultSchema = z
  .object({
    instructionVersion: z.string().min(1),
    instructionHash: z.string().min(1),
    checks: instructionComplianceChecksSchema,
    notes: z.array(z.string()),
    checkNotes: z.record(z.string(), z.array(z.string())).optional(),
  })
  .strict();

// --- Metric provenance diagnostics (additive — Section 8 of the hardening spec) ---------------------
//
// Reviewer-level only, per the spec's explicit "if modifying ResumeContent to carry per-bullet
// provenance would create broad churn, do NOT force it" — ResumeContent itself is untouched; this is
// purely a review-time diagnostic bucket, never rendered into the resume/cover letter documents.

export const METRIC_PROVENANCE_CATEGORIES = ["SOURCE_SUPPORTED", "INFERRED_CONSERVATIVE", "UNSUPPORTED"] as const;
export type MetricProvenanceCategory = (typeof METRIC_PROVENANCE_CATEGORIES)[number];

export interface MetricProvenanceEntry {
  category: MetricProvenanceCategory;
  bullet: string;
  reason: string;
}

export interface MetricProvenanceResult {
  entries: MetricProvenanceEntry[];
  unsupportedCount: number;
}

export const structuredResumeReviewSchema = z
  .object({
    overallScore: scoreSchema,
    atsScore: scoreSchema,
    keywordAlignmentScore: scoreSchema,
    truthfulnessScore: scoreSchema,
    architectureConsistencyScore: scoreSchema,
    recruiterReadabilityScore: scoreSchema,
    formattingScore: scoreSchema,
    missingRequiredSkills: z.array(z.string()),
    incorrectTechnologyUsage: z.array(z.string()),
    genericBullets: z.array(z.string()),
    missingImpactEvidence: z.array(z.string()),
    summaryIssues: z.array(z.string()),
    skillsOrderingIssues: z.array(z.string()),
    truthfulnessIssues: z.array(z.string()),
    blockingIssues: z.array(z.string()),
    requiredCorrections: z.array(
      z.object({
        priority: z.enum(CORRECTION_PRIORITIES),
        description: z.string().min(1),
      })
    ),
    // Additive — optional so any pre-hardening in-memory review object (and, per the zod .strict()
    // parse in orchestrator.ts, any caller not yet passing it) still validates. The DETERMINISTIC
    // reviewer always populates both going forward; see deterministicReviewer.ts.
    instructionCompliance: instructionComplianceResultSchema.optional(),
    metricProvenance: z
      .object({
        entries: z.array(
          z.object({
            category: z.enum(METRIC_PROVENANCE_CATEGORIES),
            bullet: z.string(),
            reason: z.string(),
          })
        ),
        unsupportedCount: z.number().int().min(0),
      })
      .optional(),
    // Additive — Stage 21. Same optional-for-backward-compat treatment as instructionCompliance
    // above; the DETERMINISTIC reviewer always populates it going forward.
    blockingFailures: z
      .array(
        z.object({
          type: z.enum(BLOCKING_FAILURE_TYPES),
          description: z.string().min(1),
          evidenceSearched: z.array(z.string()).optional(),
          supportedAlternative: z.string().optional(),
          recommendedCorrection: z.string().optional(),
        })
      )
      .optional(),
    // Stage 21 (Evidence-Grounded Resume Quality V2) — NEXT 1-9. All optional for the same
    // backward-compatibility reason as every field above.
    jdPriorityMatrix: z
      .object({
        targetRoleTitle: z.string().nullable(),
        requirements: z.array(
          z.object({
            requirement: z.string(),
            priority: z.enum(JD_PRIORITY_TIERS),
            memberSkillNames: z.array(z.string()),
            requiredOrPreferred: z.enum(["REQUIRED", "PREFERRED", "UNSPECIFIED"]),
            evidenceAvailable: z.boolean(),
            evidenceStrength: z.enum(EVIDENCE_STRENGTHS),
            evidenceReferences: z.array(z.string()),
          })
        ),
      })
      .optional(),
    recruiterQualityAssessment: z
      .object({
        status: complianceStatusSchema,
        score: z.number().min(0).max(100),
        issues: z.array(
          z.object({
            dimension: z.enum([
              "targetRoleClarity",
              "firstTenSecondFit",
              "topSkillRelevance",
              "topBulletRelevance",
              "excessiveSecondaryTechEmphasis",
              "genericOrRepetitiveLanguage",
              "underselling",
              "readability",
            ]),
            severity: z.enum(["BLOCKING", "ADVISORY"]),
            description: z.string().min(1),
          })
        ),
      })
      .optional(),
    atsCoverageReport: z
      .array(
        z.object({
          requirement: z.string(),
          priority: z.enum(JD_PRIORITY_TIERS),
          status: z.enum(ATS_COVERAGE_STATUSES),
        })
      )
      .optional(),
  })
  .strict();

// --- Provider-independent agent contracts (Section 8) -----------------------------------------------
//
// No Anthropic/OpenAI/Codex SDK import anywhere in this file. Future implementations
// (ClaudeResumeWriter, OpenAIResumeWriter, LocalResumeWriter, ...) live elsewhere and import a real
// provider SDK there — this file only defines the shape every implementation must satisfy.

export interface ResumeWriterInput {
  applicationId: number;
  candidateId: number;
  tailoringRunId: number;
  workflowId: number;
  /** Filesystem references, not duplicated content — see ResumeTailoringWorkspacePackage below. */
  jobDescriptionPath: string;
  extractedJobRequirementsPath: string | null;
  masterResumePath: string;
  masterSkillsInventoryPath: string;
  tailoringInstructionsPath: string;
  selectedTrack: string | null;
  /** Present only on an improvement cycle (iteration > 1) — the prior iteration's output and the
   *  reviewer's feedback on it, so the writer can address specific required corrections. */
  priorIteration: { iterationNumber: number; resumePath: string; reviewFeedbackPath: string } | null;

  /** Phase 3 Stage 10 additive in-memory context fields — assembled from authoritative state */
  currentResume?: ResumeContent;
  currentCoverLetter?: CoverLetterContent;
  latestReview?: StructuredResumeReview;
  requiredCorrections?: RequiredCorrection[];
  blockingIssues?: string[];
  /** Stage 26 — the reviewer's hard blocking failures, which are what actually withhold READY
   *  (qualityGate.ts condition 7). Carried separately from `blockingIssues`, which can legitimately be
   *  empty while these are not; without them a writer can be rejected for a reason it never saw. */
  blockingFailures?: BlockingFailure[];
  /** Stage 26B — every non-PASS canonical compliance check (gate condition 6 requires all 22 to PASS,
   *  soft-gate ones included), each with the reviewer's own reason. Derived from the prior review's
   *  own instructionCompliance; never a second judgement. */
  complianceCorrections?: RequiredCorrection[];
  /** Stage 26B — the candidate's verified real contact details. HARD FACTS: the writer may format
   *  them but must never alter, substitute, or invent them, exactly like employer names and dates.
   *  Always present by the time a writer runs — a workflow with no valid contact configuration is
   *  stopped before any writer attempt (CANDIDATE_CONTACT_REQUIRED), so the writer is never asked to
   *  produce a resume it cannot legitimately fill a header for. */
  candidateContact?: { name: string; email: string; phone: string; location: string; linkedin?: string };
  dedupeKey?: string;
  iterationNumber?: number;
  masterProfile?: CandidateProfile;
  jobRequirements?: RequirementUnit[];
  jobDescriptionMarkdown?: string;
}

export interface ResumeWriterOutput {
  resume: ResumeContent;
  coverLetter?: CoverLetterContent;
  /** Threaded through from ExternalWriterOutput.writerValidation when the writer supplied one.
   *  Additive, optional, never authoritative — see WriterValidation's own doc comment. */
  writerValidation?: WriterValidation;
}

export interface ResumeWriterAgent {
  generate(input: ResumeWriterInput): Promise<ResumeWriterOutput>;
}

// --- External subscription-agent handoff contracts (Stage 11) -----------------------

export interface ExternalWriterAgentMetadata {
  provider?: string;
  model?: string;
  agentVersion?: string;
  completedAt?: string;
}

/** The writer's own self-reported guardrail self-check (Resume Quality Hardening §3) —
 *  PROVENANCE/DIAGNOSTIC DATA ONLY. CareerOps never trusts this as authoritative and never lets a
 *  writer-reported PASS override its own independently-computed instructionCompliance; see
 *  instructionCompliance.ts and qualityGate.ts, neither of which read this field. Stored verbatim as
 *  writer_validation.json for audit trail only when the writer supplies it — entirely optional. */
export interface WriterValidationChecks {
  hardCareerFacts?: ComplianceStatus;
  masterSkillsInventoryCompliance?: ComplianceStatus;
  deepRewrite?: ComplianceStatus;
  architectureIntegrity?: ComplianceStatus;
  technologyGrouping?: ComplianceStatus;
  onePrimaryTechnologyPerResponsibility?: ComplianceStatus;
  metricInferencePolicy?: ComplianceStatus;
  keywordOptimization?: ComplianceStatus;
  technologyAdaptation?: ComplianceStatus;
  migrationIntegrity?: ComplianceStatus;
  noContradictingTechnologies?: ComplianceStatus;
  bulletWriting?: ComplianceStatus;
  everySentenceAtsChecklist?: ComplianceStatus;
  crossDocumentConsistency?: ComplianceStatus;
  bannedLanguage?: ComplianceStatus;
  noDuplicateBulletPhrasing?: ComplianceStatus;
  yearsExperienceEducationHonesty?: ComplianceStatus;
  employmentTypeHandling?: ComplianceStatus;
  resumeLengthBulletCaps?: ComplianceStatus;
  verbTenseConsistency?: ComplianceStatus;
  atsFormatting?: ComplianceStatus;
  finalValidation?: ComplianceStatus;
}

export interface WriterValidation {
  instructionVersion?: string;
  instructionHash?: string;
  checks?: WriterValidationChecks;
  notes?: string[];
}

/** The strict JSON contract produced by external subscription agents (Claude Code, Codex, Antigravity, local agents) */
export interface ExternalWriterOutput {
  schemaVersion: 1;
  candidateId: number;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  iterationNumber: number;
  resume: ResumeContent;
  coverLetter?: CoverLetterContent;
  agentMetadata?: ExternalWriterAgentMetadata;
  /** Additive, optional — see WriterValidation's own doc comment: never authoritative. */
  writerValidation?: WriterValidation;
}

/** Informational snapshot written to handoffs/iteration-<n>/workflow_status.json */
export interface WorkflowStatusFile {
  candidateId: number;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  currentIteration: number;
  targetIteration: number;
  maxIterations: number;
  workflowStatus: WorkflowStatus;
  latestOverallScore: number | null;
  qualityGateResult: string | null;
  waitingFor: "EXTERNAL_WRITER" | "HUMAN_REVIEW" | "COMPLETED" | "NOT_WAITING";
  createdAt: string;
  updatedAt: string;
}

export interface ExternalHandoffExportResult {
  candidateId: number;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  targetIterationNumber: number;
  handoffDirectory: string;
  packageFiles: string[];
  waitingStatus: "WAITING_FOR_EXTERNAL_WRITER";
}

export interface ExternalHandoffImportResult {
  candidateId: number;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  iterationNumber: number;
  writerOutput: ResumeWriterOutput;
  agentMetadata?: ExternalWriterAgentMetadata;
  validated: true;
}

/** Complete result of driving the multi-iteration resume quality improvement loop (Stage 10) */
export interface ResumeQualityLoopResult {
  candidateId: number;
  applicationId: number;
  jobId: number | null;
  tailoringRunId: number;
  workflowId: number;
  finalIteration: number;
  workflowStatus: WorkflowStatus;
  qualityGateOutcome: import("./qualityGate").QualityGateOutcome;
  overallScore: number;
  iterationsCompleted: number;
  requiredCorrections: RequiredCorrection[];
  finalOutputFiles?: string[];
  finalDirectory?: string;
  finalArtifacts?: {
    resumePath?: string;
    coverLetterPath?: string;
    reviewFeedbackPath: string;
  };
  failureReason?: string | null;
  latestReview: StructuredResumeReview;
  history: Array<{
    iterationNumber: number;
    overallScore: number;
    status: WorkflowStatus;
    qualityGateOutcome: import("./qualityGate").QualityGateOutcome;
    outputFiles: string[];
  }>;
}

export interface ResumeReviewerInput {
  applicationId: number;
  candidateId: number;
  workflowId: number;
  iterationNumber: number;
  resumePath: string;
  jobDescriptionPath: string;
  resume: ResumeContent;
  /**
   * Phase 3 Stage 8 additions — Stage 7 defined the identity/output shape only ("foundation only");
   * a real reviewer implementation needs structured data to compare against, not just a resume and a
   * file path. Both are OPTIONAL and reuse Phase 2's own types directly rather than a duplicate
   * schema: jobRequirements is the same RequirementUnit[] Phase 2's own scoring.ts consumes,
   * masterResumeProfile is the same CandidateProfile loadCandidateProfile() already returns. A
   * reviewer must never silently invent either when absent — see DeterministicResumeReviewer's own
   * handling (src/lib/resumeQuality/reviewers/deterministicReviewer.ts) for how it surfaces the
   * limitation instead of fabricating a score.
   */
  jobRequirements?: RequirementUnit[];
  masterResumeProfile?: CandidateProfile;

  /** Additive (Resume Quality Hardening) — all optional, all checked "REVIEW when absent" rather
   *  than silently skipped, matching this module's existing "never invent, never silently trust"
   *  discipline for masterResumeProfile/jobRequirements above. */

  /** The cover letter accompanying this iteration, when one exists — enables crossDocumentConsistency
   *  (resume vs. cover letter fact/technology agreement). */
  coverLetter?: CoverLetterContent;
  /** The immediately-prior iteration's resume, when this isn't iteration 1 — the deep-rewrite check's
   *  primary evidence source (does this iteration materially differ from the last one the writer was
   *  told to revise, or did it come back functionally unchanged). */
  priorResume?: ResumeContent;
  /** Result of running tools/tailoring-engine/validate-docx.ts against the iteration's actual
   *  rendered .docx files, when they already exist on disk at review time — lets atsFormatting judge
   *  the REAL rendered output (one column, no tables/headers/footers, standard font) rather than only
   *  the structured JSON shape. Absent (not failed — literally not yet rendered) is common for
   *  callers that review before generating the .docx; treated as REVIEW, never as a pass or a fail. */
  docxValidation?: { resume?: { valid: boolean; violations: string[] }; coverLetter?: { valid: boolean; violations: string[] } };

  /** Additive (Stage 21 — Evidence-Grounded Resume Quality V2). The job posting's OWN title — P0
   *  role identity for the JD Priority Matrix/Positioning Engine. Deliberately a plain string, not
   *  derived from jobRequirements (RequirementUnit has no "this is the role itself" concept) or from
   *  the resume (the resume is what's being validated, not the source of truth for the target role).
   *  Absent -> positioning/recruiter-quality checks return REVIEW, never a guessed role. */
  targetRoleTitle?: string;
}

export interface ResumeReviewerOutput {
  review: StructuredResumeReview;
}

export interface ResumeReviewerAgent {
  review(input: ResumeReviewerInput): Promise<ResumeReviewerOutput>;
}

// --- Workspace package contract (Section 9) ---------------------------------------------------------

/** Everything a future ResumeWriterAgent/ResumeReviewerAgent implementation needs to do its job,
 *  assembled from EXISTING sources of truth (candidate manifest, tailoring_runs, Phase 2 match
 *  result) — never a copy of large source documents. See workspace.ts's buildWorkspacePackage() for
 *  how this gets constructed from real identity. */
export interface ResumeTailoringWorkspacePackage {
  candidateId: number;
  applicationId: number;
  dedupeKey: string;
  tailoringRunId: number;
  workflowId: number;
  selectedTrack: string | null;
  phase2Context: {
    decision: string;
    recommendedTrack: string | null;
    overallScore: number;
  } | null;
  jobDescriptionPath: string;
  extractedJobRequirementsPath: string;
  masterResumePath: string;
  masterSkillsInventoryPath: string;
  tailoringInstructionsPath: string;
}
