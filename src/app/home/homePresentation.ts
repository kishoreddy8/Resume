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

/** Home shows a small taste of the Jobs feed, not a second feed — see UI-H Part 6. */
const HOME_RECOMMENDATION_LIMIT = 3;

export function boundedRecommendations(entries: ForYouResponseEntry[]): ForYouResponseEntry[] {
  return entries.slice(0, HOME_RECOMMENDATION_LIMIT);
}

/**
 * Honest, per-reason copy for a candidate profile that is not "ok" — never one generic sentence for
 * three different real conditions. Mirrors the wording candidate-intelligence/page.tsx already
 * established for the same three states, so a candidate does not learn three different vocabularies
 * for the same fact depending which screen tells them.
 */
const PROFILE_ACTION_COPY: Record<"missing" | "stale" | "invalid", { title: string; detail: string }> = {
  missing: {
    title: "Build your candidate profile",
    detail: "No candidate profile has been built yet — your resume and skills inventory are required before matching can begin.",
  },
  stale: {
    title: "Refresh your candidate profile",
    detail: "Your master resume or skills inventory changed since this profile was built, so matching is paused until it's refreshed.",
  },
  invalid: {
    title: "Your candidate profile needs attention",
    detail: "The saved candidate profile could not be read. Rebuilding it will restore matching.",
  },
};

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
    const copy =
      (PROFILE_ACTION_COPY as Record<string, { title: string; detail: string }>)[input.profileStatus] ??
      PROFILE_ACTION_COPY.missing;
    return {
      kind: "profile",
      eyebrow: "Start here",
      title: copy.title,
      detail: copy.detail,
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

/** Kinds `chooseHomeAction` can pick that are drawn from the SAME blocking pool `homeAttention`
 *  aggregates (applications waiting + resumes needing attention) — i.e. the dominant card, when one
 *  of these, is already one of the items `attention` counts. "profile" is deliberately excluded: an
 *  incomplete profile is real and blocking, but it is not a resume or application row, so it is
 *  never counted inside `attention` and can never be "the one already shown." */
const ATTENTION_POOL_KINDS: ReadonlySet<HomeAction["kind"]> = new Set(["application", "issues", "revalidate", "retry"]);

/**
 * How many MORE blocking items exist beyond whichever one the dominant card already shows — for the
 * primary card's compact secondary line (UI-H Part 3: "one dominant item + a compact secondary
 * queue/count", never a second full list). Zero whenever nothing else needs the candidate, which is
 * exactly when Part 4's calm state applies.
 */
export function attentionOverflowCount(action: HomeAction, attention: AttentionItem[]): number {
  const dominantAlreadyCounted = ATTENTION_POOL_KINDS.has(action.kind);
  return Math.max(0, attention.length - (dominantAlreadyCounted ? 1 : 0));
}
