import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";
import { jobWorkspaceUrl } from "@/app/jobs/[id]/workspaceRoute";
import {
  presentResumeStatus,
  type ResumeStatusPresentation,
} from "@/lib/resumeQuality/resumeStatus";

export const RESUME_STUDIO_TABS = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready to use" },
  { id: "tailoring", label: "Tailoring" },
  { id: "needs-review", label: "Needs review" },
  { id: "blocked", label: "Blocked" },
] as const;

export type ResumeStudioTab = (typeof RESUME_STUDIO_TABS)[number]["id"];
export type ResumeStudioBucket = Exclude<ResumeStudioTab, "all">;
export type ResumeStudioAction =
  | { kind: "open"; label: "Open resume"; href: null }
  | { kind: "progress"; label: "View progress"; href: string }
  | { kind: "revalidate"; label: "Re-run validation"; href: null }
  | { kind: "issues"; label: "Review issues"; href: string }
  | { kind: "retry"; label: "Re-tailor"; href: string }
  | { kind: "details"; label: "View details"; href: null };

export interface ResumeStudioPresentation {
  bucket: ResumeStudioBucket | null;
  status: ResumeStatusPresentation;
  label: "Ready to use" | "Tailoring" | "Needs review" | "Blocked" | "Not validated";
  action: ResumeStudioAction;
  needsAttention: boolean;
}

function authoritativeStatus(entry: ResumeLibraryEntry): ResumeStatusPresentation {
  return presentResumeStatus({
    workflowStatus: entry.workflowStatus,
    readiness: entry.readiness,
    humanMaySend: entry.humanMaySend,
    blockingReason: entry.blockingReason,
    isLegacyMissingAnalysis: entry.isLegacyMissingAnalysis,
    canRevalidate: entry.canRevalidate,
  });
}

/**
 * Candidate-facing grouping and action selection only. Every semantic input is projected by the
 * existing server authorities; this function cannot make a resume sendable, retryable, or
 * revalidation-eligible.
 */
export function presentResumeStudioEntry(entry: ResumeLibraryEntry): ResumeStudioPresentation {
  const status = authoritativeStatus(entry);
  const hasPreview = entry.jobId !== null && (entry.documents.resume || entry.documents.coverLetter);

  if (status.key === "ready") {
    return {
      bucket: "ready",
      status,
      label: "Ready to use",
      action: hasPreview
        ? { kind: "open", label: "Open resume", href: null }
        : { kind: "details", label: "View details", href: null },
      needsAttention: false,
    };
  }

  if (status.key === "generating") {
    return {
      bucket: "tailoring",
      status,
      label: "Tailoring",
      action:
        entry.jobId !== null
          ? {
              kind: "progress",
              label: "View progress",
              href: jobWorkspaceUrl(entry.jobId, { step: "results", focus: "progress" }),
            }
          : { kind: "details", label: "View details", href: null },
      needsAttention: false,
    };
  }

  if (status.key === "needs-refresh" && entry.canRevalidate && entry.jobId !== null) {
    return {
      bucket: "needs-review",
      status,
      label: "Needs review",
      action: { kind: "revalidate", label: "Re-run validation", href: null },
      needsAttention: true,
    };
  }

  if (status.key === "blocked") {
    return {
      bucket: "blocked",
      status,
      label: "Blocked",
      action:
        entry.jobId !== null
          ? {
              kind: "issues",
              label: "Review issues",
              href: jobWorkspaceUrl(entry.jobId, { step: "validation", focus: "issues" }),
            }
          : { kind: "details", label: "View details", href: null },
      needsAttention: entry.jobId !== null,
    };
  }

  if (entry.canRetry && entry.jobId !== null) {
    return {
      bucket: "needs-review",
      status,
      label: "Needs review",
      action: {
        kind: "retry",
        label: "Re-tailor",
        href: jobWorkspaceUrl(entry.jobId, { step: "results", focus: "retailor" }),
      },
      needsAttention: true,
    };
  }

  if (status.key === "needs-review") {
    return {
      bucket: "needs-review",
      status,
      label: "Needs review",
      action:
        entry.jobId !== null
          ? {
              kind: "issues",
              label: "Review issues",
              href: jobWorkspaceUrl(entry.jobId, { step: "validation", focus: "issues" }),
            }
          : { kind: "details", label: "View details", href: null },
      needsAttention: entry.jobId !== null,
    };
  }

  return {
    bucket: null,
    status,
    label: "Not validated",
    action: { kind: "details", label: "View details", href: null },
    needsAttention: false,
  };
}

export const RESUME_STUDIO_EMPTY_COPY: Record<ResumeStudioTab, string> = {
  all: "No tailored resumes yet.",
  ready: "No resumes are ready to use yet.",
  tailoring: "No resumes are tailoring right now.",
  "needs-review": "Nothing needs your review.",
  blocked: "No blocked resumes.",
};
