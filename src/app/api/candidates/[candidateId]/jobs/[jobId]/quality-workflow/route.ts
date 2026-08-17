import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getCandidateJobState } from "@/db/queries/candidateJobState";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestJobMatchResult } from "@/db/queries/jobMatches";
import {
  createResumeQualityWorkflow,
  getLatestResumeQualityWorkflowForJob,
  getResumeQualityWorkflow,
  listResumeQualityIterations,
} from "@/db/queries/resumeQualityWorkflows";
import { listTailoringRuns } from "@/db/queries/tailoringRuns";
import { loadCandidateProfile } from "@/lib/match/candidateProfile";
import { matchesCurrentInstructions } from "@/lib/resumeQuality/canonicalInstructions";
import { evaluateQualityGate } from "@/lib/resumeQuality/qualityGate";
import { startTailoringRun, type TailoringRunAuthorizationError } from "@/lib/tailoringExecution";
import { executeResumeQualityIteration } from "@/lib/resumeQuality/orchestrator";
import { DeterministicResumeReviewer } from "@/lib/resumeQuality/reviewers/deterministicReviewer";
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
import type { ResumeContent, StructuredResumeReview } from "@/lib/resumeQuality/types";

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
  const matchResult = getLatestJobMatchResult(candidateId, job.dedupe_key);
  const runs = listTailoringRuns(candidateId, job.dedupe_key);
  const latestRun = runs[0] ?? null;

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key) ?? null;

  // Authorization check
  let isAuthorized = false;
  let authorizationBlockingReason: string | null = null;
  if (!state || !state.marked_for_tailoring) {
    authorizationBlockingReason = "Job is not marked for tailoring.";
  } else if (!state.tailoring_approval_type || !state.tailoring_approved_decision) {
    authorizationBlockingReason = "Tailoring approval required: no approval context recorded.";
  } else if (!matchResult) {
    authorizationBlockingReason = "Tailoring approval required: job has not been evaluated against candidate profile.";
  } else if (state.tailoring_approved_decision !== matchResult.decision) {
    authorizationBlockingReason = `Tailoring approval stale: approved for ${state.tailoring_approved_decision}, but current match decision is ${matchResult.decision}.`;
  } else {
    isAuthorized = true;
  }

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
    };
    instructionCompliance: {
      instructionVersion: string;
      instructionHash: string;
      isCurrent: boolean;
      failingChecks: string[];
    } | null;
  } | null = null;

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
        qualityGate = {
          passed: outcome === "READY",
          outcome,
          criteria: {
            overallScorePass: latestReview.overallScore >= 95,
            truthfulnessPass: latestReview.truthfulnessScore === 100,
            architecturePass: latestReview.architectureConsistencyScore === 100,
            blockingIssuesPass: latestReview.blockingIssues.length === 0,
            instructionCompliancePass: compliance !== undefined && isCurrent && failingChecks.length === 0,
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

    if (workflow.status === "IMPROVEMENT_RUNNING") {
      const targetIter = workflow.current_iteration + 1;
      const handoffDir = getHandoffDirectory(location, targetIter);
      availableArtifacts.hasHandoffPackage = fs.existsSync(path.join(handoffDir, "writer_input.json"));
    }
  }

  const waitingFor =
    workflow?.status === "IMPROVEMENT_RUNNING"
      ? "EXTERNAL_WRITER"
      : workflow?.status === "FAILED"
      ? "HUMAN_REVIEW"
      : workflow?.status === "READY"
      ? "COMPLETED"
      : "NOT_WAITING";

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
    authorization: {
      isMarked: Boolean(state?.marked_for_tailoring),
      markedAt: state?.tailoring_marked_at ?? null,
      approvalType: state?.tailoring_approval_type ?? null,
      approvedDecision: state?.tailoring_approved_decision ?? null,
      isAuthorized,
      blockingReason: authorizationBlockingReason,
      matchDecision: matchResult?.decision ?? "NO_MATCH",
      // Stage 24A — surfaced separately from matchDecision (never a new Decision enum value, which
      // would touch ~21 existing call sites) so the UI can distinguish "genuinely reviewed
      // borderline case" from "evaluated with too little structured JD data to mean anything" —
      // both currently collapse into the same NEEDS_REVIEW decision.
      insufficientJdSignal: Boolean(matchResult?.insufficient_jd_signal),
    },
    iterations,
    latestReview,
    qualityGate,
    bestAttempt,
    availableArtifacts,
    waitingFor,
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

  // Check if a workflow already exists
  let workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);

  if (!workflow || workflow.status === "CREATED") {
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

    // 2. Build baseline initial resume from master profile
    const profile = profileResult.profile;
    const initialResume: ResumeContent = {
      name: `${candidate.first_name} ${candidate.last_name}`.trim(),
      tagline: "Software Professional",
      location: "Remote, US",
      email: "candidate@example.com",
      phone: "555-0100",
      summary: [
        `Experienced software and data professional with a proven track record of architecting and deploying scalable solutions.`,
      ],
      skillGroups: [
        {
          label: "Core Technologies",
          items: profile.skills.slice(0, 8).map((s) => s.rawSkillName),
        },
      ],
      experience: profile.experience.map((e) => ({
        title: e.title,
        company: e.employer,
        dates: `${e.startDate ?? "2020"} - ${e.endDate ?? "Present"}`,
        bullets: [`Engineered data platforms and core workflows at ${e.employer}.`],
      })),
      education: profile.education.map(
        (ed) => `${ed.level} in ${ed.field ?? "Computer Science"}, ${ed.institution ?? "University"}`
      ),
      certifications: profile.certifications.map((c) => c.name),
    };

    // 3. Start & execute iteration 1 review
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

      const execResult = await executeResumeQualityIteration({
        candidateId,
        workflowId: createdWorkflow.id,
        resume: initialResume,
        jobRequirements: allReqs,
        reviewer: new DeterministicResumeReviewer(),
      });

      workflow = getResumeQualityWorkflow(candidateId, execResult.workflow.id);
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
      return NextResponse.json({ ok: true, workflow: safeWf, result: execResult });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : "Failed to execute quality iteration";
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

  return NextResponse.json({ ok: true, workflow: safeWf });
}
