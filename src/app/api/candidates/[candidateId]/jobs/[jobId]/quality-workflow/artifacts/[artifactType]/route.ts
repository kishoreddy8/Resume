import fs from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { requireActiveCandidate, getCandidate } from "@/db/queries/candidates";
import { getJob } from "@/db/queries/jobs";
import { getLatestResumeQualityWorkflowForJob } from "@/db/queries/resumeQualityWorkflows";
import { getGeneratedRoot } from "@/lib/generatedFiles";
import {
  finalCoverLetterFilename,
  finalResumeFilename,
  getFinalDirectory,
  getIterationDirectory,
  type QualityWorkflowLocation,
} from "@/lib/resumeQuality/workspace";

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const ALLOWED_ARTIFACT_TYPES = ["resume", "coverLetter", "feedback", "review"] as const;
type AllowedArtifactType = (typeof ALLOWED_ARTIFACT_TYPES)[number];

const MIME_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ candidateId: string; jobId: string; artifactType: string }> }
): Promise<NextResponse> {
  const { candidateId: candidateIdParam, jobId: jobIdParam, artifactType } = await params;

  const candidateId = parsePositiveInt(candidateIdParam);
  if (candidateId === null) return NextResponse.json({ error: "Invalid candidate id" }, { status: 400 });
  if (!requireActiveCandidate(candidateId)) return NextResponse.json({ error: "Not an active candidate" }, { status: 404 });

  const jobId = parsePositiveInt(jobIdParam);
  if (jobId === null) return NextResponse.json({ error: "Invalid job id" }, { status: 400 });
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (!ALLOWED_ARTIFACT_TYPES.includes(artifactType as AllowedArtifactType)) {
    return NextResponse.json(
      { error: `Invalid artifact type: ${artifactType}. Allowed: ${ALLOWED_ARTIFACT_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  const candidate = getCandidate(candidateId);
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });

  const workflow = getLatestResumeQualityWorkflowForJob(candidateId, job.dedupe_key);
  if (!workflow) {
    return NextResponse.json({ error: "No quality workflow found for this job" }, { status: 404 });
  }

  const location: QualityWorkflowLocation = {
    candidateId,
    dedupeKey: workflow.dedupe_key,
    runId: workflow.tailoring_run_id,
    workflowId: workflow.id,
  };

  const requestedIterationParam = req.nextUrl.searchParams.get("iteration");
  let requestedIteration: number | null = null;
  if (requestedIterationParam !== null) {
    requestedIteration = parsePositiveInt(requestedIterationParam);
    if (requestedIteration === null) {
      return NextResponse.json({ error: "Invalid iteration parameter" }, { status: 400 });
    }
  }

  let filePath: string | null = null;
  let downloadFilename: string = "";

  const firstName = candidate.first_name;

  if (workflow.status === "READY" && !requestedIteration) {
    // Final approved artifacts
    const finalDir = getFinalDirectory(location);
    if (artifactType === "resume") {
      downloadFilename = finalResumeFilename(firstName);
      filePath = path.join(finalDir, downloadFilename);
    } else if (artifactType === "coverLetter") {
      downloadFilename = finalCoverLetterFilename(firstName);
      filePath = path.join(finalDir, downloadFilename);
    } else if (artifactType === "feedback") {
      downloadFilename = "resume_review_feedback.md";
      filePath = path.join(finalDir, downloadFilename);
    } else if (artifactType === "review") {
      downloadFilename = "review.json";
      const iterDir = getIterationDirectory(location, workflow.final_approved_iteration ?? workflow.current_iteration);
      filePath = path.join(iterDir, downloadFilename);
    }
  } else {
    // Iteration artifacts
    const iterNum = requestedIteration ?? workflow.current_iteration;
    if (iterNum <= 0) {
      return NextResponse.json({ error: "No completed iterations found for this workflow" }, { status: 404 });
    }
    const iterDir = getIterationDirectory(location, iterNum);
    if (artifactType === "resume") {
      downloadFilename = `${firstName}_Resume_Iteration_${iterNum}.docx`;
      filePath = path.join(iterDir, "Resume.docx");
    } else if (artifactType === "coverLetter") {
      downloadFilename = `${firstName}_CoverLetter_Iteration_${iterNum}.docx`;
      filePath = path.join(iterDir, "CoverLetter.docx");
    } else if (artifactType === "feedback") {
      downloadFilename = `review_feedback_iteration_${iterNum}.md`;
      filePath = path.join(iterDir, "review_feedback.md");
    } else if (artifactType === "review") {
      downloadFilename = `review_iteration_${iterNum}.json`;
      filePath = path.join(iterDir, "review.json");
    }
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json(
      { error: `Requested artifact '${artifactType}' was not found for this workflow.` },
      { status: 404 }
    );
  }

  // Security guard: Ensure path stays strictly within generated root
  const resolvedRoot = path.resolve(getGeneratedRoot()) + path.sep;
  const resolvedPath = path.resolve(filePath);
  if (!resolvedPath.startsWith(resolvedRoot)) {
    return NextResponse.json({ error: "Access denied: path outside generated root" }, { status: 403 });
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const fileBuffer = fs.readFileSync(resolvedPath);

  return new NextResponse(fileBuffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${downloadFilename}"`,
      "Content-Length": String(fileBuffer.length),
    },
  });
}
