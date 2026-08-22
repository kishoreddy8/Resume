import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";
import type { ForYouResponseEntry } from "@/app/api/candidates/[candidateId]/for-you/route";
import { applicationContext, primaryActionLabel } from "@/app/applications/grouping";
import { presentStatus } from "@/app/applications/runStatus";
import { jobWorkspaceUrl } from "@/app/jobs/[id]/workspaceRoute";
import {
  presentResumeStudioEntry,
  type ResumeStudioPresentation,
} from "@/app/resume/resumeStudioPresentation";

export interface WaitingApplication {
  id: number;
  status: string;
  title: string | null;
  company: string | null;
  question?: string | null;
}

export interface HomePresentationInput {
  profileStatus: string;
  applications: WaitingApplication[];
  resumes: ResumeLibraryEntry[];
  recommendations: ForYouResponseEntry[];
}

export interface HomeResumeRow {
  entry: ResumeLibraryEntry;
  presentation: ResumeStudioPresentation;
  href: string | null;
}

export interface HomeAction {
  kind: "application" | "profile" | "issues" | "revalidate" | "retry" | "progress" | "ready" | "match" | "browse";
  eyebrow: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
  secondaryHref?: string;
}

function resumeHref(row: HomeResumeRow): string | null {
  const { entry, presentation } = row;
  if (entry.jobId === null) return null;
  if (presentation.action.href) return presentation.action.href;
  if (presentation.action.kind === "revalidate") {
    return jobWorkspaceUrl(entry.jobId, { step: "validation", focus: "revalidate" });
  }
  if (presentation.bucket === "ready") {
    return jobWorkspaceUrl(entry.jobId, { step: "results", focus: "progress" });
  }
  return jobWorkspaceUrl(entry.jobId, { step: "validation" });
}

export function presentHomeResumes(entries: ResumeLibraryEntry[]): HomeResumeRow[] {
  return entries.map((entry) => {
    const presentation = presentResumeStudioEntry(entry);
    const row: HomeResumeRow = { entry, presentation, href: null };
    row.href = resumeHref(row);
    return row;
  });
}

export function boundedRecommendations(entries: ForYouResponseEntry[]): ForYouResponseEntry[] {
  return entries.slice(0, 5);
}

export function homeCounts(input: HomePresentationInput): {
  tailoring: number;
  needsAttention: number;
  ready: number;
} {
  const rows = presentHomeResumes(input.resumes);
  return {
    tailoring: rows.filter((row) => row.presentation.bucket === "tailoring").length,
    needsAttention:
      input.applications.length + rows.filter((row) => row.presentation.needsAttention).length,
    ready: rows.filter((row) => row.presentation.bucket === "ready").length,
  };
}

/** One deterministic queue: human-blocked work first, then useful forward motion. */
export function chooseHomeAction(input: HomePresentationInput): HomeAction {
  const application = input.applications[0];
  if (application) {
    return {
      kind: "application",
      eyebrow: "Waiting on you",
      title: application.title ?? "Application needs your input",
      detail: [application.company, applicationContext(application.status, application.question ?? null)]
        .filter(Boolean)
        .join(" · "),
      href: `/applications/${application.id}`,
      cta: primaryActionLabel(application.status),
      secondaryHref: "/applications",
    };
  }

  if (input.profileStatus !== "ok") {
    return {
      kind: "profile",
      eyebrow: "Start here",
      title: "Complete your candidate profile",
      detail: "Your resume and skills inventory are required before matching can begin.",
      href: "/onboarding",
      cta: "Complete setup",
    };
  }

  const rows = presentHomeResumes(input.resumes);
  const orderedKinds = ["issues", "revalidate", "retry", "progress"] as const;
  for (const kind of orderedKinds) {
    const row = rows.find((candidate) => candidate.presentation.action.kind === kind && candidate.href);
    if (row?.href) {
      return {
        kind,
        eyebrow: kind === "progress" ? "Tailoring in progress" : "Resume needs attention",
        title: row.entry.title ?? "Tailored resume",
        detail: [row.entry.company, row.presentation.status.hint].filter(Boolean).join(" · "),
        href: row.href,
        cta: row.presentation.action.label,
        secondaryHref: "/resume",
      };
    }
  }

  const ready = rows.find((row) => row.presentation.bucket === "ready" && row.href);
  if (ready?.href) {
    return {
      kind: "ready",
      eyebrow: "Ready to use",
      title: ready.entry.title ?? "Your tailored resume is ready",
      detail: [ready.entry.company, "Approved for candidate use"].filter(Boolean).join(" · "),
      href: ready.href,
      cta: "Open resume",
      secondaryHref: "/resume",
    };
  }

  const recommendation = boundedRecommendations(input.recommendations)[0];
  if (recommendation) {
    return {
      kind: "match",
      eyebrow: "Strongest match",
      title: recommendation.job.title,
      detail: [recommendation.job.company_name, recommendation.job.location].filter(Boolean).join(" · "),
      href: jobWorkspaceUrl(recommendation.job.id, { step: "match" }),
      cta: "Review match",
      secondaryHref: "/jobs",
    };
  }

  return {
    kind: "browse",
    eyebrow: "Next step",
    title: "Find your next opportunity",
    detail: "Your strongest evaluated matches will appear here as they are found.",
    href: "/jobs",
    cta: "Browse jobs",
  };
}

export interface AttentionItem {
  key: string;
  title: string;
  detail: string;
  label: string;
  href: string;
  tone: "warning" | "danger";
}

export function homeAttention(input: HomePresentationInput): AttentionItem[] {
  const applications: AttentionItem[] = input.applications.map((application) => ({
    key: `application-${application.id}`,
    title: application.title ?? "Application",
    detail: [application.company, applicationContext(application.status, application.question ?? null)]
      .filter(Boolean)
      .join(" · "),
    label: presentStatus(application.status).label,
    href: `/applications/${application.id}`,
    tone: "warning",
  }));
  const resumes: AttentionItem[] = presentHomeResumes(input.resumes)
    .filter((row) => row.presentation.needsAttention && row.href)
    .map((row) => ({
      key: `resume-${row.entry.workflowId}`,
      title: row.entry.title ?? "Tailored resume",
      detail: [row.entry.company, row.presentation.status.hint].filter(Boolean).join(" · "),
      label: row.presentation.action.label,
      href: row.href!,
      tone: "danger",
    }));
  return [...applications, ...resumes].slice(0, 5);
}
