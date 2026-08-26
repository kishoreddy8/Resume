import { presentStatus } from "@/app/applications/runStatus";

/**
 * UI-ACT — pure presentation logic for the candidate Activity feed.
 *
 * ONE SOURCE, NO SECOND EVENT MODEL. Every notification row already carries everything real: a
 * `type` the generator itself assigns (see src/lib/notifications/{generateNotifications,
 * resumePipelineNotifications,../../lib/apply/applicationNotifications}.ts — none of those files are
 * touched by this phase), a candidate-authored `title`/`body`, and a `dedupeKey` whose *format* is
 * itself part of the generator's own documented contract. Nothing here re-derives meaning from
 * prose; every classification below traces to one of those two real, structured facts.
 *
 * WHY APPLICATION-RUN ROUTING IS A STRING PARSE, NOT A GUESS. applicationNotifications.ts's own
 * comment states the dedupe key is built as `` `application-run:${run.id}:${run.status}` `` — a
 * literal, documented template, not an inferred convention. Parsing it is reading that contract,
 * the same way the existing /api/candidates/[id]/notifications route already reads a job's own
 * dedupe_key to resolve `jobId` (see that route's toResponseEntry). Once parsed, the real run status
 * is handed to `presentStatus` — the EXACT SAME function Applications' own run list and detail pages
 * use — so "does this need the candidate" and "what tone/marker" are never re-decided here; they are
 * read from the one place that already decides them.
 */

export type ActivityTone = "opportunity" | "success" | "attention" | "neutral";
export type ActivityDomain = "job" | "resume" | "application";

export interface ApplicationRunRef {
  runId: number;
  status: string;
}

/** Parses `application-run:<id>:<status>` — returns null for every other dedupe_key shape (a job's
 *  own dedupe_key never matches this pattern, so this is safe to attempt unconditionally). */
export function parseApplicationRunKey(dedupeKey: string): ApplicationRunRef | null {
  const match = /^application-run:(\d+):(.+)$/.exec(dedupeKey);
  if (!match) return null;
  const runId = Number(match[1]);
  if (!Number.isInteger(runId) || runId <= 0) return null;
  return { runId, status: match[2] };
}

/** The non-application notification types this codebase actually generates today (confirmed by
 *  reading every real createNotificationIfAbsent call site) — job-match and resume-pipeline events,
 *  all keyed on a real job dedupe_key, so the existing /notifications route's jobId resolution
 *  already works for every one of them. */
const JOB_KEYED_TYPE_PRESENTATION: Record<string, { domain: ActivityDomain; tone: ActivityTone; needsUser: boolean }> = {
  HIGH_VALUE_JOB_MATCH: { domain: "job", tone: "opportunity", needsUser: false },
  RESUME_READY: { domain: "resume", tone: "success", needsUser: false },
  WRITER_FAILURE: { domain: "resume", tone: "attention", needsUser: false },
  QUALITY_FAILURE: { domain: "resume", tone: "attention", needsUser: false },
  HUMAN_REVIEW_REQUIRED: { domain: "resume", tone: "attention", needsUser: true },
};

const MARKER_TONE: Record<string, ActivityTone> = {
  done: "success",
  unknown: "attention",
  waiting: "attention",
  running: "neutral",
  stopped: "neutral",
};

export interface ActivityPresentation {
  domain: ActivityDomain;
  tone: ActivityTone;
  /** True only when a real, existing authority (presentStatus, or the fixed job-keyed table above)
   *  says a person has something to do — never inferred from title/body wording. */
  needsUser: boolean;
  /** Only set for application-run notifications — presentStatus's own candidate-facing label
   *  ("Needs input", "Final review", "Submission unconfirmed", …), shown as a small status tag. */
  statusLabel: string | null;
  /** Real destination or null. Never derived from title text — only from a resolved jobId
   *  (existing /notifications route field) or a parsed application run id. */
  href: string | null;
  ctaLabel: string | null;
}

/**
 * Classifies one notification row for display. `jobId` is the field the existing /notifications
 * route already resolves; `dedupeKey` is the same field already on the wire. No new request, no new
 * column, no schema change.
 */
export function presentActivityItem(
  type: string,
  dedupeKey: string,
  jobId: number | null
): ActivityPresentation {
  const runRef = parseApplicationRunKey(dedupeKey);
  if (runRef) {
    const status = presentStatus(runRef.status);
    return {
      domain: "application",
      tone: MARKER_TONE[status.marker] ?? "neutral",
      needsUser: status.needsUser,
      statusLabel: status.label,
      href: `/applications/${runRef.runId}`,
      ctaLabel: "View application",
    };
  }

  // An unrecognized future type is never hidden or misfiled — it fails safe into "job" (the only
  // domain that makes sense for a type this table doesn't yet know, since a real jobId is present)
  // with a neutral tone, exactly the "show it, name it plainly" philosophy notificationTitle() (the
  // shared candidate-facing label helper) already uses for an unknown type.
  const known = JOB_KEYED_TYPE_PRESENTATION[type];
  return {
    domain: known?.domain ?? "job",
    tone: known?.tone ?? "neutral",
    needsUser: known?.needsUser ?? false,
    statusLabel: null,
    href: jobId !== null ? `/jobs/${jobId}` : null,
    ctaLabel: jobId !== null ? "View job" : null,
  };
}

export type ActivityFilter = "all" | "needsYou" | "job" | "resume" | "application";

export function matchesFilter(presentation: ActivityPresentation, filter: ActivityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "needsYou") return presentation.needsUser;
  return presentation.domain === filter;
}

export type ActivityGroup = "today" | "yesterday" | "earlier";

/** Calendar-day grouping from the real `createdAt` timestamp, in the viewer's own local time zone —
 *  display-only; nothing is written or reordered. Returns "earlier" for anything unparsable so a
 *  malformed timestamp never crashes the page. */
export function groupForTimestamp(iso: string, now: Date = new Date()): ActivityGroup {
  const then = new Date(iso);
  if (!Number.isFinite(then.getTime())) return "earlier";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(then)) / 86_400_000);
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "yesterday";
  return "earlier";
}

export const ACTIVITY_GROUP_LABEL: Record<ActivityGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  earlier: "Earlier",
};
