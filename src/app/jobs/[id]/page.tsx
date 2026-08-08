"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { use } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { getJobAgeBand, getJobAgeDays } from "@/lib/jobLifecycle";
import { sanitizeJobHtml } from "@/lib/sanitizeHtml";
import type { DescriptionSections, JobStatusHistoryEntry, JobWithCompany } from "@/types";

interface JobDetailResponse {
  job: JobWithCompany;
  generatedFiles: string[];
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const AGE_BAND_LABELS = {
  fresh: "Fresh",
  active: "Active",
  aging: "Aging",
  stale: "Stale",
} as const;

const AGE_BAND_STYLES = {
  fresh: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  active: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  aging: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  stale: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
} as const;

/** Fresh (0-3 days old) is the policy's "highlight as high priority" band — computed live from
 *  posted_at/first_seen_at, never persisted. See src/lib/jobLifecycle.ts. */
function AgeBadge({ job }: { job: JobWithCompany }) {
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const band = getJobAgeBand(ageDays);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AGE_BAND_STYLES[band]}`}
      title={`${ageDays} day${ageDays === 1 ? "" : "s"} old`}
    >
      {AGE_BAND_LABELS[band]} · {ageDays}d
    </span>
  );
}

const SECTION_LABELS: Record<keyof DescriptionSections, string> = {
  responsibilities: "Responsibilities",
  qualifications: "Qualifications",
  niceToHave: "Nice to have",
  skills: "Skills",
  benefits: "Benefits",
};

function parseSections(json: string | null): DescriptionSections | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as DescriptionSections;
  } catch {
    return null;
  }
}

function TailoringToggle({ jobId, initial }: { jobId: number; initial: boolean }) {
  const [checked, setChecked] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !checked;
    setChecked(next);
    setSaving(true);
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markedForTailoring: next }),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={saving} onChange={toggle} className="h-4 w-4" />
      Marked for resume tailoring
    </label>
  );
}

function CopyPromptButton({ job }: { job: JobWithCompany }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const prompt = `/tailor-resume job=${job.id}`;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      {copied ? "Copied!" : "Copy Claude Code prompt"}
    </button>
  );
}

/**
 * Archive/restore/pin + a plain-language summary of where the job stands in the lifecycle (live,
 * closed-but-not-archived, or archived), plus the age band driving the automatic policy. The
 * server (archiveJob/canArchive in src/db/queries/jobs.ts + src/lib/jobLifecycle.ts) is the source
 * of truth for the protected-status/pinned guardrail — this just surfaces its rejection message
 * rather than re-deriving the rule client-side, so the two can never disagree.
 */
function LifecycleCard({ job, onChanged }: { job: JobWithCompany; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(typeof data.error === "string" ? data.error : "Failed to archive job");
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to archive job");
    } finally {
      setBusy(false);
    }
  }

  async function restore() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/restore`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to restore job");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore job");
    } finally {
      setBusy(false);
    }
  }

  async function togglePinned() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: job.pinned !== 1 }),
      });
      if (!res.ok) throw new Error("Failed to update pin");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update pin");
    } finally {
      setBusy(false);
    }
  }

  const state = job.is_archived === 1 ? "Archived" : job.is_active === 1 ? "Active" : "Closed";
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const ageBand = getJobAgeBand(ageDays);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-semibold">Lifecycle</h2>
      <div className="mb-2 flex flex-wrap items-center gap-1.5 text-sm">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            state === "Active"
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
              : state === "Closed"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
          }`}
        >
          {state}
        </span>
        <AgeBadge job={job} />
        {job.pinned === 1 && (
          <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-300">
            Pinned
          </span>
        )}
      </div>
      <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        {job.closed_at && <li>Closed: {formatDateTime(job.closed_at)}</li>}
        {job.is_archived === 1 && (
          <>
            <li>Archived: {formatDateTime(job.archived_at)}</li>
            {job.archived_reason && <li>Reason: {job.archived_reason}</li>}
          </>
        )}
        {job.pinned === 1 && <li>Pinned — never auto-archived or auto-deleted, regardless of age.</li>}
        {ageBand === "aging" && job.pinned !== 1 && job.is_archived === 0 && (
          <li className="text-amber-700 dark:text-amber-500">
            8–10 days old and unapplied — will archive automatically unless pinned or moved past New/Interested.
          </li>
        )}
        {ageBand === "stale" && job.pinned !== 1 && (
          <li className="text-orange-700 dark:text-orange-500">
            Over 10 days old and unapplied — will be permanently deleted on the next scan unless pinned or applied to.
          </li>
        )}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {job.is_archived === 1 ? (
          <button
            disabled={busy}
            onClick={restore}
            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {busy ? "Restoring…" : "Restore job"}
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={archive}
            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {busy ? "Archiving…" : "Archive job"}
          </button>
        )}
        <button
          disabled={busy}
          onClick={togglePinned}
          className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          {job.pinned === 1 ? "Unpin" : "Pin (never auto-archive/delete)"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/** Irreversible — deletes the job record, its generated files, and leaves a suppression
 *  fingerprint so the exact same requisition never reappears (src/db/queries/jobs.ts's
 *  markNotInterested). Unlike Archive, there is no Restore. */
function NotInterestedButton({ job }: { job: JobWithCompany }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markNotInterested() {
    if (
      !confirm(
        `Mark "${job.title}" as Not Interested? This permanently deletes the job record and any generated resume files — this can't be undone.`
      )
    ) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/not-interested`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark as Not Interested");
      router.push("/jobs");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark as Not Interested");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20">
      <h2 className="mb-1 text-sm font-semibold text-red-800 dark:text-red-300">Not interested</h2>
      <p className="mb-3 text-xs text-red-700/80 dark:text-red-400/80">
        Permanently deletes this job and its generated files, and prevents this exact posting from
        reappearing on future scans.
      </p>
      <button
        disabled={busy}
        onClick={markNotInterested}
        className="rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
      >
        {busy ? "Deleting…" : "Not interested — delete"}
      </button>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function NotesTagsCard({ job, onChanged }: { job: JobWithCompany; onChanged: () => void }) {
  const [notes, setNotes] = useState(job.notes ?? "");
  const [tagsInput, setTagsInput] = useState(parseTags(job.tags).join(", "));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const tags = tagsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes.trim() === "" ? null : notes, tags }),
      });
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-semibold">Notes &amp; tags</h2>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder="Private notes about this job…"
        className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      <input
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
        placeholder="Tags, comma-separated (e.g. remote, referral)"
        className="mt-2 w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={saving}
          onClick={save}
          className="rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && <span className="text-xs text-emerald-700 dark:text-emerald-400">Saved</span>}
      </div>
    </div>
  );
}

function describeHistoryEntry(entry: JobStatusHistoryEntry): string {
  if (entry.change_type === "pipeline_status") {
    return `Pipeline: ${entry.old_value ?? "—"} → ${entry.new_value ?? "—"}`;
  }
  if (entry.change_type === "lifecycle") {
    return `${entry.old_value ?? "—"} → ${entry.new_value ?? "—"}${entry.reason ? ` (${entry.reason})` : ""}`;
  }
  return `${entry.old_value ?? "—"} → ${entry.new_value ?? "—"}`;
}

function HistoryCard({ jobId, refreshKey }: { jobId: number; refreshKey: number }) {
  const [history, setHistory] = useState<JobStatusHistoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/history`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setHistory(d.history ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [jobId, refreshKey]);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-semibold">History</h2>
      {history === null ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : history.length === 0 ? (
        <p className="text-xs text-zinc-500">No status changes recorded yet.</p>
      ) : (
        <ul className="space-y-2 text-xs">
          {history.map((entry) => (
            <li key={entry.id} className="border-l-2 border-zinc-200 pl-2 dark:border-zinc-800">
              <div className="text-zinc-700 dark:text-zinc-300">{describeHistoryEntry(entry)}</div>
              <div className="text-zinc-400">{formatDateTime(entry.changed_at)}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * H1B Sponsor Intelligence — Job Detail Page requirements: Confidence, Evidence, Historical
 * Sponsor, JD Override, Reason. job.h1b_combined_confidence is the value actually stored (computed
 * once at scan time); combineH1bConfidence is recomputed here purely to recover the "overridden"
 * flag and human-readable reason, which aren't themselves persisted columns — it's a pure function
 * of company_h1b_confidence + sponsorship_polarity, so it always reproduces the same result.
 */
function H1bIntelligenceCard({ job }: { job: JobWithCompany }) {
  const { overridden, reason } = combineH1bConfidence(job.company_h1b_confidence, job.sponsorship_polarity);

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-2 text-sm font-semibold">H1B sponsor intelligence</h2>

      <div className="mb-3">
        <div className="mb-1 text-xs font-medium text-zinc-500">Confidence</div>
        <H1bBadge confidence={job.h1b_combined_confidence} />
      </div>

      {job.sponsorship_snippet && (
        <div className="mb-3">
          <div className="mb-1 text-xs font-medium text-zinc-500">Evidence (from this posting)</div>
          <blockquote className="rounded border-l-2 border-zinc-300 bg-zinc-50 px-2 py-1.5 text-xs italic text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
            &ldquo;{job.sponsorship_snippet}&rdquo;
          </blockquote>
        </div>
      )}

      <div className="mb-3">
        <div className="mb-1 text-xs font-medium text-zinc-500">Historical sponsor (company)</div>
        <div className="mb-1 flex items-center gap-2">
          <H1bBadge confidence={job.company_h1b_confidence} />
          {job.company_h1b_match_tier && (
            <span className="text-xs text-zinc-500">{job.company_h1b_match_tier} match</span>
          )}
        </div>
        {job.company_h1b_confidence_evidence ? (
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{job.company_h1b_confidence_evidence}</p>
        ) : (
          <p className="text-xs text-zinc-500">
            No DOL H1B/LCA history imported or matched for this company yet.
          </p>
        )}
      </div>

      <div className="mb-1">
        <div className="mb-1 text-xs font-medium text-zinc-500">JD override</div>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          {overridden ? (
            <span className="font-medium text-amber-700 dark:text-amber-500">
              Yes — this posting&apos;s language changed the outcome from the company&apos;s historical confidence.
            </span>
          ) : (
            "No — showing the company's historical confidence as-is."
          )}
        </p>
      </div>

      <div>
        <div className="mb-1 text-xs font-medium text-zinc-500">Reason</div>
        <p className="text-xs text-zinc-600 dark:text-zinc-400">{reason}</p>
      </div>
    </div>
  );
}

export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${id}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const json = (await res.json()) as JobDetailResponse;
      setData(json);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount/id-change with a loading flag, not a render loop.
    // `load` is intentionally omitted below — it's redefined every render and doesn't depend on
    // anything but `id`, which is already the effect's dependency.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (loading) return <p className="text-sm text-zinc-500">Loading…</p>;
  if (notFound || !data) return <p className="text-sm text-zinc-500">Job not found.</p>;

  const { job, generatedFiles } = data;
  const sections = parseSections(job.description_sections);
  const facts = [
    job.location,
    job.employment_type,
    job.workplace_type,
    job.salary_text,
  ].filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/jobs" className="text-xs text-zinc-500 hover:underline">
          ← Back to jobs
        </Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{job.title}</h1>
              {job.is_archived === 0 && <AgeBadge job={job} />}
            </div>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {job.company_name} · {job.source_type}
              {job.is_archived === 1 ? " · archived" : !job.is_active && " · closed"}
            </p>
            {facts.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {facts.map((fact, i) => (
                  <span
                    key={i}
                    className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    {fact}
                  </span>
                ))}
              </div>
            )}
          </div>
          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            View posting ↗
          </a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          {sections && (
            <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold">At a glance</h2>
              <p className="mb-3 text-xs text-zinc-500">
                Best-effort extraction from the full description below — always verify against it.
              </p>
              <div className="space-y-3">
                {(Object.keys(SECTION_LABELS) as (keyof DescriptionSections)[])
                  .filter((key) => sections[key])
                  .map((key) => (
                    <div key={key}>
                      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        {SECTION_LABELS[key]}
                      </h3>
                      <p className="whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">
                        {sections[key]}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-semibold">Full description</h2>
            {job.description_html ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: sanitizeJobHtml(job.description_html) }}
              />
            ) : job.description_text ? (
              <p className="whitespace-pre-line text-sm text-zinc-700 dark:text-zinc-300">
                {job.description_text}
              </p>
            ) : (
              <p className="text-sm text-zinc-500">
                No description text captured for this posting (common for career-link scrapes, since
                that scraper only extracts links/titles). View the original posting for details, or
                add this company as a proper Greenhouse/Ashby/Lever entry on the Companies page if
                available — see the note there if one was auto-detected.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold">Pipeline</h2>
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-zinc-500">Status</div>
                <PipelineStatusSelect
                  jobId={job.id}
                  value={job.pipeline_status}
                  onChanged={() => {
                    load();
                    setHistoryKey((k) => k + 1);
                  }}
                />
              </div>
              <TailoringToggle jobId={job.id} initial={job.marked_for_tailoring === 1} />
            </div>
          </div>

          <LifecycleCard
            job={job}
            onChanged={() => {
              load();
              setHistoryKey((k) => k + 1);
            }}
          />

          <NotesTagsCard job={job} onChanged={load} />

          <H1bIntelligenceCard job={job} />

          <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-2 text-sm font-semibold">Resume tailoring</h2>
            <p className="mb-3 text-xs text-zinc-500">
              Tailoring runs in Claude Code, not this app. Mark this job for tailoring, then in a
              Claude Code session in this project run the skill below.
            </p>
            <CopyPromptButton job={job} />
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                Generated files ({generatedFiles.length})
              </div>
              {generatedFiles.length === 0 ? (
                <p className="text-xs text-zinc-500">None yet.</p>
              ) : (
                <ul className="space-y-0.5 text-xs">
                  {generatedFiles.map((f) => (
                    <li key={f} className="font-mono text-zinc-600 dark:text-zinc-400">
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <HistoryCard jobId={job.id} refreshKey={historyKey} />

          <NotInterestedButton job={job} />
        </div>
      </div>
    </div>
  );
}
