import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getGeneratedRoot } from "@/lib/generatedFiles";
import type { WorkflowStatus } from "./types";
import { finalCoverLetterFilename, finalResumeFilename } from "./workspace";

/**
 * Phase 9A — durable, human-readable publication of ALREADY-APPROVED application artifacts.
 *
 * This module publishes; it never generates, reviews, scores, or approves anything. The authoritative
 * artifact store remains the Stage 4/Stage 7 candidate/job/run hierarchy:
 *
 *   data/generated/candidates/<candidateId>/jobs/<jobIdentityHash>/runs/<runId>/quality/<workflowId>/
 *     iterations/<n>/   (immutable per-iteration snapshots — the version history)
 *     final/            (populated by orchestrator.ts ONLY on READY; what the artifacts API serves)
 *
 * That layout is correct but unreadable to a human: a candidate id, a 16-hex job hash, and three
 * numeric ids give no hint which company or role the documents belong to. Phase 9A mirrors the
 * approved documents from final/ into a second, purely derivative tree under the SAME generated root:
 *
 *   data/generated/applications/<company-slug>/<position-slug>-<jobId>/
 *     <CandidateName>_Resume.docx
 *     <CandidateName>_CoverLetter.docx
 *     resume_review_feedback.md
 *     manifest.json
 *
 * Invariants this module is responsible for:
 *  - Publication is only ever reachable from a workflow whose authoritative status is already READY.
 *    A non-READY status is rejected here as well as at the call site, so no future caller can publish
 *    a NEEDS_IMPROVEMENT/FAILED/in-flight workflow by mistake.
 *  - Nothing is generated: every published byte is copied verbatim from the workflow's own final/
 *    directory, i.e. from the exact files the artifacts route already serves as approved.
 *  - Candidate master files (data/candidates/<id>/master/) are never read or written here.
 *  - Publication is all-or-nothing: the complete folder is staged beside the destination and swapped
 *    in, so a publication that fails part-way leaves the previous known-good folder untouched.
 */

/** Root of the derivative, human-readable publication tree. Always a subdirectory of the one
 *  generated-artifact root (see generatedFiles.ts) — never a competing second root. */
export function getPublishedApplicationsRoot(): string {
  return path.join(getGeneratedRoot(), "applications");
}

export type FinalPublicationErrorCode =
  | "WORKFLOW_NOT_READY"
  | "INVALID_IDENTIFIER"
  | "MISSING_RESUME"
  | "MISSING_COVER_LETTER"
  | "MISSING_REVIEW_FEEDBACK"
  | "PATH_ESCAPE";

export class FinalPublicationError extends Error {
  constructor(
    public readonly code: FinalPublicationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FinalPublicationError";
  }
}

/**
 * Filesystem-safe single path segment. Unicode is decomposed first so accented characters degrade to
 * their base letters rather than vanishing ("Nestlé" -> "nestle", not "nestl"); everything that is
 * not [a-z0-9] after that — whitespace runs, control characters, path separators, and the "." and
 * ".." traversal tokens — collapses to a single hyphen, which is then trimmed from both ends. A name
 * made only of punctuation therefore yields "" and the caller applies its own explicit fallback;
 * this function never invents one, because a shared generic fallback is exactly how two different
 * companies (or two different jobs) would silently land in the same directory.
 */
export function toPathSlug(raw: string | null | undefined, maxLength = 80): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFKD")
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new FinalPublicationError("INVALID_IDENTIFIER", `Invalid ${name} for final publication: ${value}`);
  }
}

/** The company directory segment. Falls back to the company's own id — never to a shared generic
 *  word — so two companies whose names both sanitize to nothing stay in separate directories. */
export function publishedCompanySlug(companyName: string | null | undefined, companyId: number): string {
  assertPositiveInt("companyId", companyId);
  return toPathSlug(companyName) || `company-${companyId}`;
}

/** The job directory segment: "<position-slug>-<jobId>". The job id suffix is unconditional — it is
 *  what makes two different roles at the same company (and two postings of the same role) provably
 *  distinct directories, regardless of how similar their titles are. An empty/unusable title falls
 *  back to "position-<jobId>", never to slugify()'s generic "company" default. */
export function publishedJobSlug(jobTitle: string | null | undefined, jobId: number): string {
  assertPositiveInt("jobId", jobId);
  const titleSlug = toPathSlug(jobTitle);
  return titleSlug ? `${titleSlug}-${jobId}` : `position-${jobId}`;
}

/** Defense in depth: both segments are slugs restricted to [a-z0-9-] plus a validated integer, so a
 *  path escaping the applications root should be structurally impossible — this makes that guarantee
 *  explicit and loud rather than silently trusted (mirroring tailoringArtifacts.ts's own guard). */
function assertInsidePublishedRoot(target: string): void {
  const resolvedRoot = path.resolve(getPublishedApplicationsRoot());
  const resolved = path.resolve(target);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new FinalPublicationError(
      "PATH_ESCAPE",
      `Refusing to publish outside the generated applications root: ${resolved}`
    );
  }
}

export interface PublishedApplicationTarget {
  root: string;
  companySlug: string;
  jobSlug: string;
  directory: string;
}

/** Where a candidate/job's approved artifacts belong. Pure path computation — creates nothing. */
export function resolvePublishedApplicationTarget(input: {
  companyId: number;
  companyName: string | null | undefined;
  jobId: number;
  jobTitle: string | null | undefined;
}): PublishedApplicationTarget {
  const root = getPublishedApplicationsRoot();
  const companySlug = publishedCompanySlug(input.companyName, input.companyId);
  const jobSlug = publishedJobSlug(input.jobTitle, input.jobId);
  const directory = path.join(root, companySlug, jobSlug);
  assertInsidePublishedRoot(directory);
  return { root, companySlug, jobSlug, directory };
}

export interface PublishFinalApplicationInput {
  candidateId: number;
  /** The candidate's own first name, straight from the candidates row. The published filename prefix
   *  is derived from this at call time — never hardcoded, so every candidate gets their own name. */
  candidateFirstName: string;
  candidateDisplayName?: string | null;
  companyId: number;
  companyName: string | null | undefined;
  jobId: number;
  jobTitle: string | null | undefined;
  dedupeKey: string;
  applicationId: number;
  tailoringRunId: number;
  workflowId: number;
  /** The workflow's authoritative status. Anything other than READY is refused. */
  workflowStatus: WorkflowStatus;
  /** The approved iteration these artifacts came from. */
  iterationNumber: number;
  qualityGateOutcome?: string;
  overallScore?: number | null;
  instructionVersion?: string;
  instructionHash?: string;
  /** The workflow's own final/ directory — the single approved-artifact source. */
  sourceFinalDirectory: string;
  sourceResumePath: string;
  sourceCoverLetterPath?: string;
  sourceReviewFeedbackPath?: string;
  publishedAt: string;
}

export interface PublishedApplicationManifest {
  schemaVersion: 1;
  publishedAt: string;
  candidateId: number;
  candidateName: string;
  candidateFilePrefix: string;
  companyId: number;
  companyName: string | null;
  companySlug: string;
  jobId: number;
  jobTitle: string | null;
  jobSlug: string;
  dedupeKey: string;
  applicationId: number;
  tailoringRunId: number;
  workflowId: number;
  iterationId: number;
  workflowStatus: "READY";
  qualityGateOutcome: string | null;
  overallScore: number | null;
  instructionVersion: string | null;
  instructionHash: string | null;
  files: {
    resume: string;
    coverLetter: string | null;
    reviewFeedback: string | null;
    manifest: string;
  };
  /** SHA-256 of each published document, so a byte-match against the artifact the API serves can be
   *  verified later without re-reading both files. */
  checksums: {
    resume: string;
    coverLetter: string | null;
  };
  /** Provenance, stored relative to the generated-artifact root so a manifest stays portable across
   *  machines and checkouts — the same discipline tailoring_runs.output_files already follows. */
  source: {
    finalDirectory: string;
    resume: string;
    coverLetter: string | null;
    reviewFeedback: string | null;
  };
}

export interface PublishedApplication extends PublishedApplicationTarget {
  resumePath: string;
  coverLetterPath: string | null;
  reviewFeedbackPath: string | null;
  manifestPath: string;
  manifest: PublishedApplicationManifest;
}

const MANIFEST_FILENAME = "manifest.json";
const REVIEW_FEEDBACK_FILENAME = "resume_review_feedback.md";

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** Relative to the generated root when it is inside it; the absolute path otherwise (never throws —
 *  provenance metadata must not be able to fail a publication that is otherwise valid). */
function relativeToGeneratedRoot(target: string): string {
  const root = path.resolve(getGeneratedRoot());
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved;
}

/**
 * Publish one workflow's already-approved artifacts. Refuses anything but READY, refuses to start
 * unless every declared source file is present, stages the complete folder, and only then swaps it
 * into place — so the previously published folder survives intact if any step fails.
 */
export function publishFinalApplicationArtifacts(input: PublishFinalApplicationInput): PublishedApplication {
  // Gate first, before any path is computed or any byte is read. Publication is a consequence of the
  // quality gate having already passed; it is never itself a way to reach an approved state.
  if (input.workflowStatus !== "READY") {
    throw new FinalPublicationError(
      "WORKFLOW_NOT_READY",
      `Refusing to publish final application artifacts for workflow ${input.workflowId}: status is ${input.workflowStatus}, not READY`
    );
  }

  assertPositiveInt("candidateId", input.candidateId);
  assertPositiveInt("applicationId", input.applicationId);
  assertPositiveInt("tailoringRunId", input.tailoringRunId);
  assertPositiveInt("workflowId", input.workflowId);
  assertPositiveInt("iterationNumber", input.iterationNumber);

  // Every declared source must exist up front — a folder is never opened and half-filled.
  if (!input.sourceResumePath || !fs.existsSync(input.sourceResumePath)) {
    throw new FinalPublicationError(
      "MISSING_RESUME",
      `Refusing to publish workflow ${input.workflowId}: approved resume not found at ${input.sourceResumePath}`
    );
  }
  if (input.sourceCoverLetterPath && !fs.existsSync(input.sourceCoverLetterPath)) {
    throw new FinalPublicationError(
      "MISSING_COVER_LETTER",
      `Refusing to publish workflow ${input.workflowId}: approved cover letter not found at ${input.sourceCoverLetterPath}`
    );
  }
  if (input.sourceReviewFeedbackPath && !fs.existsSync(input.sourceReviewFeedbackPath)) {
    throw new FinalPublicationError(
      "MISSING_REVIEW_FEEDBACK",
      `Refusing to publish workflow ${input.workflowId}: review feedback not found at ${input.sourceReviewFeedbackPath}`
    );
  }

  const target = resolvePublishedApplicationTarget({
    companyId: input.companyId,
    companyName: input.companyName,
    jobId: input.jobId,
    jobTitle: input.jobTitle,
  });

  // Identical derivation to the artifacts API route, so the published filename is always exactly the
  // filename CareerOps serves for the same candidate.
  const resumeFilename = finalResumeFilename(input.candidateFirstName);
  const coverLetterFilename = finalCoverLetterFilename(input.candidateFirstName);
  const candidateFilePrefix = resumeFilename.replace(/_Resume\.docx$/, "");

  const manifest: PublishedApplicationManifest = {
    schemaVersion: 1,
    publishedAt: input.publishedAt,
    candidateId: input.candidateId,
    candidateName: input.candidateDisplayName?.trim() || input.candidateFirstName,
    candidateFilePrefix,
    companyId: input.companyId,
    companyName: input.companyName ?? null,
    companySlug: target.companySlug,
    jobId: input.jobId,
    jobTitle: input.jobTitle ?? null,
    jobSlug: target.jobSlug,
    dedupeKey: input.dedupeKey,
    applicationId: input.applicationId,
    tailoringRunId: input.tailoringRunId,
    workflowId: input.workflowId,
    iterationId: input.iterationNumber,
    workflowStatus: "READY",
    qualityGateOutcome: input.qualityGateOutcome ?? null,
    overallScore: input.overallScore ?? null,
    instructionVersion: input.instructionVersion ?? null,
    instructionHash: input.instructionHash ?? null,
    files: {
      resume: resumeFilename,
      coverLetter: input.sourceCoverLetterPath ? coverLetterFilename : null,
      reviewFeedback: input.sourceReviewFeedbackPath ? REVIEW_FEEDBACK_FILENAME : null,
      manifest: MANIFEST_FILENAME,
    },
    checksums: {
      resume: sha256File(input.sourceResumePath),
      coverLetter: input.sourceCoverLetterPath ? sha256File(input.sourceCoverLetterPath) : null,
    },
    source: {
      finalDirectory: relativeToGeneratedRoot(input.sourceFinalDirectory),
      resume: relativeToGeneratedRoot(input.sourceResumePath),
      coverLetter: input.sourceCoverLetterPath ? relativeToGeneratedRoot(input.sourceCoverLetterPath) : null,
      reviewFeedback: input.sourceReviewFeedbackPath
        ? relativeToGeneratedRoot(input.sourceReviewFeedbackPath)
        : null,
    },
  };

  const companyDir = path.dirname(target.directory);
  fs.mkdirSync(companyDir, { recursive: true });

  // Staging and backup are siblings of the destination — same directory, therefore same filesystem,
  // therefore rename() is a genuine atomic swap rather than a copy that can tear.
  const token = crypto.randomBytes(6).toString("hex");
  const stagingDir = path.join(companyDir, `.publish-staging-${token}`);
  const backupDir = path.join(companyDir, `.publish-previous-${token}`);
  assertInsidePublishedRoot(stagingDir);
  assertInsidePublishedRoot(backupDir);

  let backedUp = false;
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.copyFileSync(input.sourceResumePath, path.join(stagingDir, resumeFilename));
    if (input.sourceCoverLetterPath) {
      fs.copyFileSync(input.sourceCoverLetterPath, path.join(stagingDir, coverLetterFilename));
    }
    if (input.sourceReviewFeedbackPath) {
      fs.copyFileSync(input.sourceReviewFeedbackPath, path.join(stagingDir, REVIEW_FEEDBACK_FILENAME));
    }
    fs.writeFileSync(path.join(stagingDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

    // Swap: move any previous publication aside, move the fully-staged folder in, then discard the
    // old one. If the second rename fails, the previous folder is put back before rethrowing, so a
    // failed republication can never leave the job with no published artifacts at all.
    if (fs.existsSync(target.directory)) {
      fs.renameSync(target.directory, backupDir);
      backedUp = true;
    }
    try {
      fs.renameSync(stagingDir, target.directory);
    } catch (error) {
      if (backedUp) {
        fs.renameSync(backupDir, target.directory);
        backedUp = false;
      }
      throw error;
    }
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    if (backedUp) fs.rmSync(backupDir, { recursive: true, force: true });
  }

  return {
    ...target,
    resumePath: path.join(target.directory, resumeFilename),
    coverLetterPath: input.sourceCoverLetterPath ? path.join(target.directory, coverLetterFilename) : null,
    reviewFeedbackPath: input.sourceReviewFeedbackPath ? path.join(target.directory, REVIEW_FEEDBACK_FILENAME) : null,
    manifestPath: path.join(target.directory, MANIFEST_FILENAME),
    manifest,
  };
}
