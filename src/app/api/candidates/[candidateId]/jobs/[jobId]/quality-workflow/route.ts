import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import {
  createResumeQualityWorkflow,
  getLatestResumeQualityWorkflowForJob,
  getResumeQualityWorkflow,
  listResumeQualityIterations,
} from "@/db/queries/resumeQualityWorkflows";
import { listTailoringRuns } from "@/db/queries/tailoringRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { matchesCurrentInstructions } from "@/lib/resumeQuality/canonicalInstructions";
import { evaluateTailoringAuthorization } from "@/lib/resumeQuality/tailoringAuthorization";
import { getResumeWriterHealth, type ResumeWriterHealth } from "@/lib/resumeQuality/writers/writerHealth";
import { evaluateQualityGate } from "@/lib/resumeQuality/qualityGate";
import { evaluateApplicationReadiness, type ApplicationReadinessResult } from "@/lib/resumeQuality/applicationReadiness";
import { startTailoringRun, type TailoringRunAuthorizationError } from "@/lib/tailoringExecution";
import { selectBestResumeQualityAttempt, type ResumeQualityAttemptSummary } from "@/lib/resumeQuality/bestAttemptSelection";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  getHandoffDirectory,
  getHumanReviewDirectory,
  getIterationDirectory,
  getWorkspaceDirectory,
  type QualityWorkflowLocation,
} from "@/lib/resumeQuality/workspace";
import { getJobCertifications, getJobSkills } from "@/db/queries/jobIntel";
import {
  buildCertificationUnits,
  buildEducationUnit,
  collapseSkillUnits,
} from "@/lib/match/requirementUnits";
import { detectUnclaimedRequirements } from "@/lib/match/unclaimedRequirementDetector";
import type { StructuredResumeReview } from "@/lib/resumeQuality/types";

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;
  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const candidate = getCandidate(candidateId);
  const state = getCandidateJobState(candidateId, job.dedupe_key);
  const runs = listTailoringRuns(candidateId, job.dedupe_key);
  const latestRun = runs[0] ?? null;

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key) ?? null;

  // Authorization check — the SAME evaluation the autonomous writer re-asserts immediately before it
  // spends a Claude invocation (see tailoringAuthorization.ts), so what the user is shown here and
  // what actually gates automatic tailoring can never drift apart.
  const authorization = evaluateTailoringAuthorization(candidateId, job.dedupe_key);

  // Iterations & Review data
  let iterations: ReturnType<typeof listResumeQualityIterations> = [];
  let latestReview: StructuredResumeReview | null = null;
  let qualityGate: {
    passed: boolean;
    outcome: string;
    criteria: {
      overallScorePass: boolean;
      truthfulnessPass: boolean;
      architecturePass: boolean;
      blockingIssuesPass: boolean;
      instructionCompliancePass: boolean;
      // Stage 25: the gate enforces these two as well (qualityGate.ts conditions 7 and 8), but the
      // route reported only five of the eight, so a human could see "gate failed" with no way to tell
      // a truthfulness failure apart from a positioning weakness.
      blockingFailuresPass: boolean;
      recruiterQualityPass: boolean;
    };
    instructionCompliance: {
      instructionVersion: string;
      instructionHash: string;
      isCurrent: boolean;
      failingChecks: string[];
    } | null;
  } | null = null;

  /** Stage 25 — the single canonical "can a human send this?" verdict (applicationReadiness.ts). */
  let applicationReadiness: ApplicationReadinessResult | null = null;

  let bestAttempt: {
    iterationNumber: number;
    selectionReason: string;
    overallScore: number;
    atsScore: number;
    truthfulnessScore: number;
    architectureConsistencyScore: number;
    instructionCompliancePassCount: number;
    instructionComplianceTotal: number;
    failingChecks: string[];
    blockingIssues: string[];
  } | null = null;

  /**
   * Stage 26 — the truthful Phase 9A outcome, read from the record the orchestrator writes beside the
   * approved artifacts (final/publication_status.json). Deliberately NOT re-derived by probing the
   * applications tree: an existing directory could be a previous publication, and a missing one
   * cannot distinguish "never attempted" from "attempted and failed". `status: "UNKNOWN"` is the
   * honest answer for a READY workflow approved before Stage 26 existed — never "published".
   */
  let publication:
    | {
        status: "PUBLISHED" | "FAILED" | "UNKNOWN";
        directory: string | null;
        recordedAt: string | null;
        error: string | null;
      }
    | null = null;

  const availableArtifacts = {
    hasFinalResume: false,
    hasFinalCoverLetter: false,
    hasFinalFeedback: false,
    hasIterationResume: false,
    hasIterationCoverLetter: false,
    hasIterationFeedback: false,
    hasHandoffPackage: false,
    hasHumanReviewResume: false,
    hasHumanReviewCoverLetter: false,
  };

  if (workflow) {
    iterations = listResumeQualityIterations(candidateId, workflow.id);
    const latestIter = iterations[iterations.length - 1];
    if (latestIter?.review_json) {
      try {
        latestReview = JSON.parse(latestIter.review_json) as StructuredResumeReview;
        const outcome = evaluateQualityGate(latestReview, latestIter.iteration_number, workflow.max_iterations);
        const compliance = latestReview.instructionCompliance;
        const isCurrent = compliance !== undefined && matchesCurrentInstructions(compliance);
        const failingChecks = compliance
          ? Object.entries(compliance.checks)
              .filter(([, status]) => status !== "PASS")
              .map(([name]) => name)
          : [];
        applicationReadiness = evaluateApplicationReadiness(
          latestReview,
          latestIter.iteration_number,
          workflow.max_iterations
        );
        qualityGate = {
          passed: outcome === "READY",
          outcome,
          criteria: {
            overallScorePass: latestReview.overallScore >= 95,
            truthfulnessPass: latestReview.truthfulnessScore === 100,
            architecturePass: latestReview.architectureConsistencyScore === 100,
            blockingIssuesPass: latestReview.blockingIssues.length === 0,
            instructionCompliancePass: compliance !== undefined && isCurrent && failingChecks.length === 0,
            blockingFailuresPass: latestReview.blockingFailures !== undefined && latestReview.blockingFailures.length === 0,
            recruiterQualityPass:
              latestReview.recruiterQualityAssessment !== undefined &&
              latestReview.recruiterQualityAssessment.status === "PASS",
          },
          instructionCompliance: compliance
            ? {
                instructionVersion: compliance.instructionVersion,
                instructionHash: compliance.instructionHash,
                isCurrent,
                failingChecks,
              }
            : null,
        };
      } catch {
        // Fallback
      }
    }

    const location: QualityWorkflowLocation = {
      candidateId,
      dedupeKey: workflow.dedupe_key,
      runId: workflow.tailoring_run_id,
      workflowId: workflow.id,
    };

    if (workflow.status === "READY" && candidate) {
      const finalDir = getFinalDirectory(location);
      const resFile = path.join(finalDir, finalResumeFilename(candidate.first_name));
      const covFile = path.join(finalDir, finalCoverLetterFilename(candidate.first_name));
      const fbFile = path.join(finalDir, "resume_review_feedback.md");
      availableArtifacts.hasFinalResume = fs.existsSync(resFile);
      availableArtifacts.hasFinalCoverLetter = fs.existsSync(covFile);
      availableArtifacts.hasFinalFeedback = fs.existsSync(fbFile);

      const pubStatusFile = path.join(finalDir, "publication_status.json");
      if (fs.existsSync(pubStatusFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(pubStatusFile, "utf-8")) as {
            status?: string;
            directory?: string | null;
            recordedAt?: string | null;
            error?: string | null;
          };
          publication = {
            status: parsed.status === "PUBLISHED" ? "PUBLISHED" : parsed.status === "FAILED" ? "FAILED" : "UNKNOWN",
            directory: parsed.directory ?? null,
            recordedAt: parsed.recordedAt ?? null,
            error: parsed.error ?? null,
          };
        } catch {
          publication = { status: "UNKNOWN", directory: null, recordedAt: null, error: "Publication record could not be read." };
        }
      } else {
        publication = { status: "UNKNOWN", directory: null, recordedAt: null, error: null };
      }
    }

    // Terminal FAILED (HUMAN_REVIEW_REQUIRED): compute the best-attempt summary via the SAME single
    // ranking authority (selectBestResumeQualityAttempt) the orchestrator's human-review package
    // generator already used — never a second, independently-derived notion of "which iteration is
    // best". Never computed for READY (final/ stays the sole approved-artifact source) or for any
    // non-terminal status.
    if (workflow.status === "FAILED") {
      const attempts: ResumeQualityAttemptSummary[] = [];
      for (const it of iterations) {
        if (!it.review_json) continue;
        try {
          attempts.push({ iterationNumber: it.iteration_number, review: JSON.parse(it.review_json) as StructuredResumeReview });
        } catch {
          // Skip an unparseable legacy row.
        }
      }
      const selection = selectBestResumeQualityAttempt(attempts);
      if (selection) {
        const winner = attempts.find((a) => a.iterationNumber === selection.iterationNumber)!.review;
        const compliance = winner.instructionCompliance;
        bestAttempt = {
          iterationNumber: selection.iterationNumber,
          selectionReason: selection.selectionReason,
          overallScore: winner.overallScore,
          atsScore: winner.atsScore,
          truthfulnessScore: winner.truthfulnessScore,
          architectureConsistencyScore: winner.architectureConsistencyScore,
          instructionCompliancePassCount: compliance ? Object.values(compliance.checks).filter((s) => s === "PASS").length : 0,
          instructionComplianceTotal: compliance ? Object.keys(compliance.checks).length : 22,
          failingChecks: compliance ? Object.entries(compliance.checks).filter(([, s]) => s !== "PASS").map(([name]) => name) : [],
          blockingIssues: winner.blockingIssues,
        };
      }

      const humanReviewDir = getHumanReviewDirectory(location);
      if (candidate) {
        availableArtifacts.hasHumanReviewResume = fs.existsSync(path.join(humanReviewDir, `${candidate.first_name}_Resume_HumanReview.docx`));
        availableArtifacts.hasHumanReviewCoverLetter = fs.existsSync(
          path.join(humanReviewDir, `${candidate.first_name}_CoverLetter_HumanReview.docx`)
        );
      }
    }

    if (workflow.current_iteration > 0) {
      const iterDir = getIterationDirectory(location, workflow.current_iteration);
      availableArtifacts.hasIterationResume = fs.existsSync(path.join(iterDir, "Resume.docx"));
      availableArtifacts.hasIterationCoverLetter = fs.existsSync(path.join(iterDir, "CoverLetter.docx"));
      availableArtifacts.hasIterationFeedback = fs.existsSync(path.join(iterDir, "review_feedback.md"));
    }

    // Stage 26 — CREATED is now also an awaiting-writer state (its target is iteration 1), so the
    // handoff probe covers it too rather than reporting "no package" for the very first iteration.
    if (workflow.status === "IMPROVEMENT_RUNNING" || workflow.status === "CREATED") {
      const targetIter = workflow.current_iteration + 1;
      const handoffDir = getHandoffDirectory(location, targetIter);
      availableArtifacts.hasHandoffPackage = fs.existsSync(path.join(handoffDir, "writer_input.json"));
    }
  }

  const waitingFor =
    // Stage 26 — CREATED joins IMPROVEMENT_RUNNING as "the writer owns the next step". Before Stage 26
    // a CREATED workflow could not exist for longer than one POST (the route immediately reviewed a
    // synthesized resume), so this branch had nothing to report; now it is the state an approved job
    // sits in until the scheduled writer produces iteration 1.
    workflow?.status === "IMPROVEMENT_RUNNING" || workflow?.status === "CREATED"
      ? "EXTERNAL_WRITER"
      : workflow?.status === "FAILED"
      ? "HUMAN_REVIEW"
      : workflow?.status === "READY"
      ? "COMPLETED"
      : "NOT_WAITING";

  /**
   * Writer/scheduler health. Computed only while the writer actually owns the next step, so a READY
   * or FAILED workflow's page never implies anything is still running for it. Scoped to this workflow
   * so the UI can also show this workflow's own last recorded pass outcome (including
   * SKIPPED_UNAUTHORIZED, which is not a failure).
   */
  const writer: ResumeWriterHealth | null = waitingFor === "EXTERNAL_WRITER" && workflow ? getResumeWriterHealth(new Date(), workflow.id) : null;

  /** Genuine writer attempts: since Stage 26 every iteration is written by the writer, so the budget
   *  is simply max_iterations, and `used` is how many have been reviewed so far. */
  const iterationBudget = workflow
    ? {
        current: workflow.current_iteration,
        max: workflow.max_iterations,
        writerAttemptsUsed: workflow.current_iteration,
        writerAttemptsRemaining: Math.max(0, workflow.max_iterations - workflow.current_iteration),
        targetIteration:
          workflow.status === "READY" || workflow.status === "FAILED" ? null : workflow.current_iteration + 1,
      }
    : null;

  const safeWorkflow = workflow
    ? {
        id: workflow.id,
        status: workflow.status,
        current_iteration: workflow.current_iteration,
        max_iterations: workflow.max_iterations,
        latest_overall_score: workflow.latest_overall_score,
        final_approved_iteration: workflow.final_approved_iteration,
        failure_reason: workflow.failure_reason,
        created_at: workflow.created_at,
      }
    : null;

  return NextResponse.json({
    candidateId,
    jobId,
    jobTitle: job.title,
    companyName: job.company_name,
    applicationId: state?.id ?? null,
    tailoringRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          created_at: latestRun.created_at,
        }
      : null,
    workflow: safeWorkflow,
    // Stage 24A's insufficientJdSignal is carried on this object (never a new Decision enum value,
    // which would touch ~21 existing call sites) so the UI can distinguish "genuinely reviewed
    // borderline case" from "evaluated with too little structured JD data to mean anything" — both
    // collapse into the same NEEDS_REVIEW decision.
    authorization,
    iterations,
    latestReview,
    qualityGate,
    applicationReadiness,
    bestAttempt,
    availableArtifacts,
    waitingFor,
    writer,
    iterationBudget,
    publication,
  });
}

/**
 * Starts or advances the resume quality pipeline for this candidate and job.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam } = await params;
  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const candidate = getCandidate(candidateId);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const state = getCandidateJobState(candidateId, job.dedupe_key);
  if (!state || !state.marked_for_tailoring) {
    return NextResponse.json(
      { error: "Tailoring approval required: job must be marked for tailoring.", code: "NOT_MARKED_FOR_TAILORING" },
      { status: 400 }
    );
  }

  // Load candidate profile
  const profileResult = loadCandidateProfile(candidateId);
  if (profileResult.status !== "ok") {
    const errorMsg = "error" in profileResult ? profileResult.error : `Candidate profile is ${profileResult.status}`;
    return NextResponse.json(
      { error: errorMsg, code: "PROFILE_UNAVAILABLE" },
      { status: 400 }
    );
  }

  // Check if a workflow already exists. A non-terminal workflow — including a CREATED one that is
  // already queued for its first writer pass — is returned as-is: pressing the button twice must
  // never create a second workflow for the same approval, and must never re-run anything.
  let workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);

  if (!workflow) {
    // 1. Ensure tailoring run exists
    let runId: number;
    const runs = listTailoringRuns(candidateId, job.dedupe_key);
    if (runs.length > 0 && runs[0].status === "started") {
      runId = runs[0].id;
    } else {
      try {
        const { run } = startTailoringRun({ candidateId, jobId });
        runId = run.id;
      } catch (err: unknown) {
        const authErr = err as TailoringRunAuthorizationError;
        return NextResponse.json(
          { error: authErr.message, code: authErr.code ?? "AUTHORIZATION_FAILED" },
          { status: 400 }
        );
      }
    }

    try {
      const createdWorkflow = createResumeQualityWorkflow({
        candidateId,
        applicationId: state.id,
        tailoringRunId: runId,
        dedupeKey: job.dedupe_key,
      });

      // Initialize workspace with authoritative job context
      const wsDir = getWorkspaceDirectory({
        candidateId,
        dedupeKey: job.dedupe_key,
        runId,
        workflowId: createdWorkflow.id,
      });
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, "job_description.md"), `# ${job.title}\n\n${job.description_text ?? ""}`);

      const skills = getJobSkills(job.id);
      const certs = getJobCertifications(job.id);
      const edu = {
        level: job.education_level,
        field: job.education_field,
        requirement: job.education_requirement,
        equivalentExperienceAllowed: job.education_equivalent_experience_allowed === 1,
        evidence: job.education_evidence,
      };
      const skillUnits = collapseSkillUnits(skills, job.title);
      const certUnits = buildCertificationUnits(certs, job.title);
      const eduUnit = buildEducationUnit(edu);
      let reqQualText: string | null = null;
      let prefQualText: string | null = null;
      if (job.description_sections) {
        try {
          const parsedSections = JSON.parse(job.description_sections);
          reqQualText = parsedSections.requiredQualifications ?? null;
          prefQualText = parsedSections.preferredQualifications ?? null;
        } catch {
          // Ignore parse errors
        }
      }

      const unclaimed = detectUnclaimedRequirements({
        jobTitle: job.title,
        requiredQualificationsText: reqQualText,
        preferredQualificationsText: prefQualText,
        alreadyClaimedEvidence: [
          ...skillUnits.flatMap((u) => u.evidenceSnippets),
          ...certUnits.flatMap((u) => u.evidenceSnippets),
          ...(eduUnit ? eduUnit.evidenceSnippets : []),
        ],
      });
      const allReqs = [...skillUnits, ...certUnits, ...(eduUnit ? [eduUnit] : []), ...unclaimed];
      fs.writeFileSync(path.join(wsDir, "extracted_job_requirements.json"), JSON.stringify(allReqs, null, 2));

      // Stage 26 — the workflow stops here, in CREATED, and the autonomous writer produces
      // iteration 1 from the real Master Resume / Skills Inventory / candidate profile evidence
      // this workspace points at.
      //
      // What used to happen instead: this route synthesized a "baseline" ResumeContent to feed
      // iteration 1 — with email "candidate@example.com", phone "555-0100", tagline "Software
      // Professional", an invented summary sentence, and one fabricated bullet per employer
      // ("Engineered data platforms and core workflows at <employer>"), plus "2020" and "Computer
      // Science"/"University" fallbacks. Nobody wrote that document and none of it was true; it
      // existed only so an iteration-1 review could run, and it failed that review by construction
      // (observed on the real corpus: iteration 1 scored 74-81 on every workflow, never passing),
      // permanently spending one of the three quality iterations. Removing it is what takes the
      // genuine writer-attempt budget from 2 of 3 to the full 3 of 3.
      workflow = getResumeQualityWorkflow(candidateId, createdWorkflow.id);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Failed to create quality workflow";
      return NextResponse.json({ error: errorMsg }, { status: 500 });
    }
  }

  const safeWf = workflow
    ? {
        id: workflow.id,
        status: workflow.status,
        current_iteration: workflow.current_iteration,
        max_iterations: workflow.max_iterations,
        latest_overall_score: workflow.latest_overall_score,
        final_approved_iteration: workflow.final_approved_iteration,
        failure_reason: workflow.failure_reason,
        created_at: workflow.created_at,
      }
    : null;

  // awaitingWriter tells the UI that the human's part is done and the scheduled writer owns the
  // next step — no manual export/import, and no npm script to start by hand.
  const awaitingWriter = workflow ? workflow.status === "CREATED" || workflow.status === "IMPROVEMENT_RUNNING" : false;

  return NextResponse.json({ ok: true, workflow: safeWf, awaitingWriter });
}
