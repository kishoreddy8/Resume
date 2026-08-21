"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  INPUT,
  LoadingRegion,
  PageHeader,
  Panel,
  PanelEmpty,
  Pill,
  SkeletonRows,
  StatTile,
} from "@/components/ui";
import {
  IconArrowUpRight,
  IconCheckCircle,
  IconDocument,
  IconInbox,
  IconStar,
  IconTrend,
} from "@/components/icons";
import { MARKER_TEXT, presentStatus } from "./runStatus";
import { ApplicationList } from "./ApplicationList";
import {
  APPLICATION_GROUPS,
  groupForStatus,
  primaryActionLabel,
  type ApplicationGroupId,
} from "./grouping";

/**
 * The application command centre.
 *
 * SORTED BY WHAT NEEDS A PERSON, NOT BY DATE. A run stopped on a CAPTCHA is the only thing on this
 * page with a pending action attached to it, and burying it under last week's submissions is how an
 * application sits unfinished for a week.
 *
 * EVERY STATE IS THE ENGINE'S OWN. Nothing here infers a status, merges two, or renames one:
 * `presentStatus` supplies the word, `WAITING_PROMPT` (already on the wire as `prompt`) supplies the
 * sentence, and `groupForStatus` reads only those. A paused run is never described as failed — the
 * system is working correctly and simply cannot proceed without a person.
 *
 * BOUNDED. One row per run, capped server-side, and no timeline, review payload, answer vault or
 * browser session is loaded here. Opening a run is a separate fetch on a separate page.
 */

interface RunRow {
  id: number;
  jobId: number;
  title: string;
  company: string | null;
  ats: string | null;
  status: string;
  prompt: string | null;
  question: string | null;
  resumeFile: string | null;
  submittedAt: string | null;
  updatedAt: string;
}

function initials(name: string | null): string {
  if (!name) return "?";
  const w = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (w.length === 0) return "?";
  if (w.length === 1) return w[0]!.slice(0, 2).toUpperCase();
  return (w[0]![0]! + w[1]![0]!).toUpperCase();
}

/** "2h ago" / "3d ago". Wording only — never used for a decision. */
function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const TONE_ICON = {
  "needs-action": <IconStar size={17} />,
  "in-progress": <IconTrend size={17} />,
  submitted: <IconInbox size={17} />,
  closed: <IconCheckCircle size={17} />,
} as const;

export default function ApplicationsPage() {
  const candidateId = useResolvedCandidateId();
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<ApplicationGroupId | "all">("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    if (candidateId === null) return;
    setError(false);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/application-runs?scope=all&limit=100`);
      if (!res.ok) return setError(true);
      const body = await res.json();
      setRuns(body.runs ?? []);
    } catch {
      setError(true);
    }
  }, [candidateId]);

  useEffect(() => {
    // Fetch-on-mount; `load` is stable per candidate.
    load();
  }, [load]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = (runs ?? []).filter(
      (r) => !q || r.title.toLowerCase().includes(q) || (r.company ?? "").toLowerCase().includes(q)
    );
    const byGroup: Record<ApplicationGroupId, RunRow[]> = {
      "needs-action": [],
      "in-progress": [],
      submitted: [],
      closed: [],
    };
    for (const r of all) byGroup[groupForStatus(r.status)].push(r);
    /* Within a group, most recently touched first. Ordering never re-ranks across groups: what
     * needs a person stays above what does not, regardless of age. */
    for (const key of Object.keys(byGroup) as ApplicationGroupId[]) {
      byGroup[key].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    }
    return byGroup;
  }, [runs, search]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const g of APPLICATION_GROUPS) {
      c[g.id] = grouped[g.id].length;
      c.all! += grouped[g.id].length;
    }
    return c;
  }, [grouped]);

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader size="lg" title="Applications" />
        <Panel>
          <PanelEmpty
            action={
              <button type="button" onClick={load} className={BTN_SECONDARY}>
                Retry
              </button>
            }
          >
            We couldn&apos;t load your applications.
          </PanelEmpty>
        </Panel>
      </div>
    );
  }

  if (candidateId === null || runs === null) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader
          size="lg"
          title="Applications"
          description="Track applications, respond to requests, and keep your job search moving."
        />
        <LoadingRegion label="Loading applications" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Panel key={i} compact>
              <SkeletonRows rows={2} />
            </Panel>
          ))}
        </div>
        <Panel>
          <SkeletonRows rows={4} />
        </Panel>
      </div>
    );
  }

  const total = runs.length;
  const visibleGroups = APPLICATION_GROUPS.filter(
    (g) => (filter === "all" || filter === g.id) && grouped[g.id].length > 0
  );

  return (
    <div className="flex flex-col gap-5 pb-10">
      <PageHeader
        size="lg"
        title="Applications"
        description="Track applications, respond to requests, and keep your job search moving."
        actions={
          <Link href="/jobs" className={BTN_PRIMARY}>
            Browse jobs
          </Link>
        }
      />

      {/* ── summary ──────────────────────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {APPLICATION_GROUPS.map((g) => (
          <StatTile
            key={g.id}
            tone={g.tone}
            icon={TONE_ICON[g.id]}
            value={counts[g.id] ?? 0}
            label={g.cardLabel}
            hint={g.cardHint}
          />
        ))}
      </div>

      {total === 0 ? (
        /* The real state of this profile today: the engine has never run an application. */
        <Panel>
          <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
            <span
              aria-hidden="true"
              className="grid h-[56px] w-[56px] place-items-center rounded-[16px] bg-[var(--tile-lav-bg)] text-[var(--tile-lav-fg)]"
            >
              <IconDocument size={26} />
            </span>
            <h2 className="text-[16px] font-bold text-primary">No applications yet</h2>
            <p className="max-w-[48ch] text-[12.5px] leading-relaxed text-tertiary">
              When you&apos;re ready to apply to a matched job, your application progress will appear
              here. JobHunt fills what it can evidence, stops for anything it cannot, and never
              submits without your approval.
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <Link href="/jobs" className={BTN_PRIMARY}>
                Browse jobs
              </Link>
              <Link href="/jobs?bucket=ready_for_tailoring" className={BTN_SECONDARY}>
                View ready-to-tailor jobs
              </Link>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {([{ id: "all" as const, cardLabel: "All" }, ...APPLICATION_GROUPS] as {
                id: ApplicationGroupId | "all";
                cardLabel: string;
              }[]).map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setFilter(g.id)}
                  aria-pressed={filter === g.id}
                  className={`inline-flex h-[38px] items-center gap-2 rounded-[10px] px-3.5 text-[13px] font-medium transition-colors duration-150 ease-out active:scale-[0.98] ${
                    filter === g.id
                      ? "bg-[var(--accent)] text-[var(--accent-fg)]"
                      : "text-secondary hover:bg-[var(--surface-hover)] hover:text-primary"
                  }`}
                >
                  {g.cardLabel}
                  <span className={`tabular-nums ${filter === g.id ? "opacity-80" : "text-tertiary"}`}>
                    {counts[g.id] ?? 0}
                  </span>
                </button>
              ))}
            </div>
            <label className="relative">
              <span className="sr-only">Search applications by company or role</span>
              <input
                type="search"
                className={`${INPUT} w-[260px]`}
                placeholder="Search applications…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>

          {visibleGroups.length === 0 ? (
            <Panel>
              <PanelEmpty>
                {search.trim()
                  ? `No application matches “${search.trim()}”.`
                  : "No application is in this state right now."}
              </PanelEmpty>
            </Panel>
          ) : (
            visibleGroups.map((g) => (
              <section key={g.id} aria-label={g.label} className="flex flex-col gap-3">
                <h2 className="text-[15px] font-bold tracking-[-0.01em] text-primary">
                  {g.label}{" "}
                  <span className="text-[13px] font-semibold tabular-nums text-tertiary">
                    {grouped[g.id].length}
                  </span>
                </h2>
                <div className="flex flex-col gap-3">
                  {grouped[g.id].map((run) => (
                    <RunRowCard key={run.id} run={run} />
                  ))}
                </div>
              </section>
            ))
          )}
        </>
      )}

      {/* Jobs you moved through a stage by hand, with no automated run behind them. They are
       *  applications too, and a list of runs alone would hide them. */}
      <section aria-label="Tracked by you" className="flex flex-col gap-3">
        <h2 className="text-[15px] font-bold tracking-[-0.01em] text-primary">Tracked by you</h2>
        <ApplicationList candidateId={candidateId} />
      </section>
    </div>
  );
}

/**
 * One application.
 *
 * The row shows the engine's word, the engine's sentence, and one action. There is no second
 * button competing with it: everything else a person might want lives one click away on the detail
 * page, which is where the run's full state actually is.
 */
function RunRowCard({ run }: { run: RunRow }) {
  const p = presentStatus(run.status);
  const tone =
    p.marker === "done"
      ? "success"
      : p.marker === "unknown"
        ? "warning"
        : p.needsUser
          ? "warning"
          : p.marker === "stopped"
            ? "neutral"
            : "info";

  return (
    <div className="rounded-[14px] border border-[var(--border)] bg-[var(--z3-bg)] px-4 py-4 shadow-[var(--shadow-card)] transition-shadow duration-150 ease-out hover:shadow-[var(--shadow-hero)]">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span
          aria-hidden="true"
          className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-[13px] bg-[var(--z0-bg)] text-[14px] font-bold text-secondary"
        >
          {initials(run.company)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="truncate text-[15px] font-bold leading-snug text-primary">{run.title}</span>
            <Pill tone={tone}>{p.label}</Pill>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px] text-tertiary">
            <span className="text-secondary">{run.company ?? "Company unknown"}</span>
            {run.ats && <span>· {run.ats}</span>}
            <span>· {run.submittedAt ? `Submitted ${ago(run.submittedAt)}` : ago(run.updatedAt)}</span>
          </div>

          {/* The engine's own prompt, then the employer's own question. Neither is paraphrased. */}
          {p.needsUser && run.prompt && (
            <p className={`mt-2 text-[12.5px] leading-relaxed ${MARKER_TEXT[p.marker]}`}>{run.prompt}</p>
          )}
          {run.question && (
            <p className="mt-1 text-[12.5px] leading-relaxed text-secondary">
              &ldquo;{run.question}&rdquo;
            </p>
          )}
          <p className="mt-1.5 text-[11.5px] text-tertiary">
            {run.resumeFile ? "Resume attached" : "No resume attached"}
          </p>
        </div>

        <Link
          href={`/applications/${run.id}`}
          className={`${p.needsUser ? BTN_PRIMARY : BTN_SECONDARY} shrink-0`}
        >
          {primaryActionLabel(run.status)}
          <IconArrowUpRight size={14} />
        </Link>
      </div>
    </div>
  );
}
