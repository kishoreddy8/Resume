"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { use } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { AiInsightsCard } from "./AiInsightsCard";
import { Disclosure } from "./Disclosure";
import { JobDecisionHeader } from "./JobDecisionHeader";
import { MatchCard } from "./MatchCard";
import { ResumeQualityPipeline } from "./ResumeQualityPipeline";
import { useJobMatch } from "./useJobMatch";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import { sanitizeJobHtml } from "@/lib/sanitizeHtml";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import type { DescriptionSections, JobCertification, JobSkill, JobStatusHistoryEntry, JobWithCompany } from "@/types";
import { useLifecycleThresholds } from "../useLifecycleThresholds";

interface JobDetailResponse {
  job: JobWithCompany;
  generatedFiles: string[];
  skills: JobSkill[];
  certifications: JobCertification[];
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

/** Fresh is the policy's "highlight as high priority" band — computed live from posted_at/
 *  first_seen_at, never persisted. `thresholds` comes from Settings > Lifecycle (see
 *  useLifecycleThresholds) so this always agrees with what the automated sweep will actually do. */
function AgeBadge({ job, thresholds }: { job: JobWithCompany; thresholds: LifecycleThresholds }) {
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const band = getJobAgeBand(ageDays, thresholds);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${AGE_BAND_STYLES[band]}`}
      title={`${ageDays} day${ageDays === 1 ? "" : "s"} old`}
    >
      {AGE_BAND_LABELS[band]} · {ageDays}d
    </span>
  );
}

// Relabeled to the Structured Job Intelligence terminology — qualifications -> Required
// Qualifications, niceToHave -> Preferred Qualifications (see src/lib/jobIntel/sections.ts, which
// does the same mapping for the extraction pipeline). "skills" is omitted here since its content is
// now covered by the structured Required/Preferred Skills lists below, not shown as raw text twice.
const SECTION_LABELS: Partial<Record<keyof DescriptionSections, string>> = {
  responsibilities: "Responsibilities",
  qualifications: "Required Qualifications",
  niceToHave: "Preferred Qualifications",
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

function TailoringToggle({ jobId, initial, candidateId }: { jobId: number; initial: boolean; candidateId: number }) {
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
        body: JSON.stringify({ candidateId, markedForTailoring: next }),
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

function CopyPromptButton({ job, candidateId }: { job: JobWithCompany; candidateId: number }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    const prompt = `/tailor-resume candidate=${candidateId} job=${job.id}`;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={copy}
      className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
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
function LifecycleCard({
  job,
  thresholds,
  candidateId,
  onChanged,
}: {
  job: JobWithCompany;
  thresholds: LifecycleThresholds;
  candidateId: number;
  onChanged: () => void;
}) {
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
        body: JSON.stringify({ candidateId, pinned: job.pinned !== 1 }),
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
  const ageBand = getJobAgeBand(ageDays, thresholds);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-4">
      <h2 className="mb-2 text-[13px] font-semibold text-primary">Lifecycle</h2>
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
        <AgeBadge job={job} thresholds={thresholds} />
        {job.pinned === 1 && (
          <span className="inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-300">
            Pinned
          </span>
        )}
      </div>
      <ul className="space-y-1 text-xs text-secondary">
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
            {thresholds.activeMaxDays + 1}–{thresholds.archiveMaxDays} days old and unapplied — will archive
            automatically unless pinned or moved past New/Interested.
          </li>
        )}
        {ageBand === "stale" && job.pinned !== 1 && (
          <li className="text-orange-700 dark:text-orange-500">
            Over {thresholds.archiveMaxDays} days old and unapplied — will be permanently deleted on the next
            scan unless pinned or applied to.
          </li>
        )}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {job.is_archived === 1 ? (
          <button
            disabled={busy}
            onClick={restore}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)] disabled:opacity-50"
          >
            {busy ? "Restoring…" : "Restore job"}
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={archive}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)] disabled:opacity-50"
          >
            {busy ? "Archiving…" : "Archive job"}
          </button>
        )}
        <button
          disabled={busy}
          onClick={togglePinned}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)] disabled:opacity-50"
        >
          {job.pinned === 1 ? "Unpin" : "Pin (never auto-archive/delete)"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

/**
 * Phase 2.5: candidate-personal, NOT global. Marking Not Interested no longer deletes the job or
 * touches the shared `jobs`/`suppressed_jobs` tables at all — it only records this ONE candidate's
 * disinterest in candidate_job_state, so the job stays fully intact and visible to every other
 * candidate (see CAREER_OPS_HANDOFF.md's Phase 2.5 design record §2/13). Reversible: toggling it
 * off clears the flag, unlike the old delete-based behavior.
 */
function NotInterestedButton({ job, candidateId }: { job: JobWithCompany; candidateId: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function markNotInterested() {
    if (!confirm(`Mark "${job.title}" as Not Interested? It will no longer appear in your Jobs list, but stays intact and visible to any other candidate profile.`)) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/not-interested`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      if (!res.ok) throw new Error("Failed to mark as Not Interested");
      router.push("/jobs");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark as Not Interested");
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900/40 dark:bg-red-950/20">
      <h2 className="mb-1 text-[13px] font-semibold text-[var(--error)]">Not interested</h2>
      <p className="mb-3 text-xs text-red-700/80 dark:text-red-400/80">
        Hides this job from your own Jobs list. The job itself is untouched and stays visible to
        any other candidate profile — this never deletes anything.
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

function NotesTagsCard({ job, candidateId, onChanged }: { job: JobWithCompany; candidateId: number; onChanged: () => void }) {
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
        body: JSON.stringify({ candidateId, notes: notes.trim() === "" ? null : notes, tags }),
      });
      setSaved(true);
      onChanged();
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-4">
      <h2 className="mb-2 text-[13px] font-semibold text-primary">Notes &amp; tags</h2>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder="Private notes about this job…"
        className="w-full rounded-md border border-[var(--border)] bg-surface px-2 py-1.5 text-[13px] text-primary"
      />
      <input
        value={tagsInput}
        onChange={(e) => setTagsInput(e.target.value)}
        placeholder="Tags, comma-separated (e.g. remote, referral)"
        className="mt-2 w-full rounded-md border border-[var(--border)] bg-surface px-2 py-1.5 text-[13px] text-primary"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          disabled={saving}
          onClick={save}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)] disabled:opacity-50"
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
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-4">
      {/* Audit trail — read occasionally, never a blocker, so it folds away by default. */}
      <Disclosure
        title="History"
        hint={history === null ? undefined : history.length === 0 ? "none" : `${history.length}`}
      >
        {history === null ? (
          <p className="text-xs text-tertiary">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-xs text-tertiary">No status changes recorded yet.</p>
        ) : (
          <ul className="space-y-2 text-xs">
            {history.map((entry) => (
              <li key={entry.id} className="border-l-2 border-[var(--separator)] pl-2">
                <div className="text-secondary">{describeHistoryEntry(entry)}</div>
                <div className="text-tertiary">{formatDateTime(entry.changed_at)}</div>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
    </section>
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
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-4">
      <h2 className="mb-2 text-[13px] font-semibold text-primary">H1B sponsor intelligence</h2>

      {/* The outcome and this posting's own words stay visible. Only the provenance behind them —
       *  company history, whether the JD overrode it, and the combining reason — folds away. */}
      <div className="mb-3">
        <div className="mb-1 text-[11px] font-medium text-tertiary">Confidence</div>
        <H1bBadge confidence={job.h1b_combined_confidence} />
      </div>

      {job.sponsorship_snippet && (
        <div className="mb-3">
          <div className="mb-1 text-[11px] font-medium text-tertiary">Evidence (from this posting)</div>
          <blockquote className="rounded-md border-l-2 border-[var(--border)] bg-app-bg px-2 py-1.5 text-xs italic text-secondary">
            &ldquo;{job.sponsorship_snippet}&rdquo;
          </blockquote>
        </div>
      )}

      <Disclosure title="How this was determined">
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[11px] font-medium text-tertiary">Historical sponsor (company)</div>
            <div className="mb-1 flex items-center gap-2">
              <H1bBadge confidence={job.company_h1b_confidence} />
              {job.company_h1b_match_tier && (
                <span className="text-xs text-tertiary">{job.company_h1b_match_tier} match</span>
              )}
            </div>
            {job.company_h1b_confidence_evidence ? (
              <p className="text-xs text-secondary">{job.company_h1b_confidence_evidence}</p>
            ) : (
              <p className="text-xs text-tertiary">
                No DOL H1B/LCA history imported or matched for this company yet.
              </p>
            )}
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium text-tertiary">JD override</div>
            <p className="text-xs text-secondary">
              {overridden ? (
                <span className="font-medium text-[var(--warning)]">
                  Yes — this posting&apos;s language changed the outcome from the company&apos;s historical confidence.
                </span>
              ) : (
                "No — showing the company's historical confidence as-is."
              )}
            </p>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium text-tertiary">Reason</div>
            <p className="text-xs text-secondary">{reason}</p>
          </div>
        </div>
      </Disclosure>
    </section>
  );
}

// --- Structured Job Intelligence (see src/lib/jobIntel/) ------------------------------------
// Deterministic, rule-based extraction of structured metadata from job.description_html/text.
// Every field below is "Unknown"/omitted when extraction found no reliable evidence — never
// fabricated. See src/db/index.ts's JOBS_STRUCTURED_INTEL_ADDITIVE_COLUMNS for the source columns.

function formatLocation(job: JobWithCompany): string | null {
  const parts = [job.location_city, job.location_state, job.location_country].filter(Boolean);
  if (parts.length > 0) return parts.join(", ");
  return job.location ?? null;
}

function parseLocationList(json: string | null): { city: string | null; state: string | null; country: string | null }[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function formatSalary(job: JobWithCompany): string | null {
  if (job.salary_min !== null || job.salary_max !== null) {
    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const range =
      job.salary_min !== null && job.salary_max !== null
        ? `${fmt(job.salary_min)} - ${fmt(job.salary_max)}`
        : fmt((job.salary_min ?? job.salary_max)!);
    const currency = job.salary_currency ?? "";
    const period = job.salary_period === "hourly" ? "/hr" : job.salary_period === "annual" ? "/yr" : "";
    return `${currency} ${range}${period}`.trim();
  }
  // Structured parsing found nothing — fall back to the raw extracted text rather than showing
  // nothing, since it's still real evidence, just not broken into min/max.
  return job.salary_text;
}

function formatExperience(job: JobWithCompany): string | null {
  if (job.experience_min_years === null && job.experience_preferred_years === null) return null;
  if (job.experience_min_years !== null && job.experience_preferred_years !== null && job.experience_preferred_years !== job.experience_min_years) {
    return `${job.experience_min_years}-${job.experience_preferred_years} years`;
  }
  const years = job.experience_min_years ?? job.experience_preferred_years;
  return `${years}+ years`;
}

function formatEducation(job: JobWithCompany): string | null {
  if (!job.education_level) return null;
  const field = job.education_field ? ` in ${job.education_field}` : "";
  const equivalent = job.education_equivalent_experience_allowed === 1 ? " (or equivalent experience)" : "";
  return `${job.education_level}${field}${equivalent}`;
}

function formatClearance(job: JobWithCompany): string | null {
  if (job.clearance_required === "Required") {
    return job.clearance_level ? `Required — ${job.clearance_level}` : "Required";
  }
  if (job.citizenship_required === "Required") return "U.S. citizenship required";
  return null;
}

function Fact({ label, value, title }: { label: string; value: string | null; title?: string }) {
  return (
    <div>
      <div className="text-[11px] font-medium text-tertiary">{label}</div>
      <div className="text-[13px] text-primary" title={title}>
        {value ?? "Unknown"}
      </div>
    </div>
  );
}

interface SkillGroup {
  label: string;
  category: string;
  evidence: string | null;
}

/** Groups skills sharing an alternative_group_id ("AWS or Azure") into one displayed pill instead
 *  of two independent required-skill rows — see src/lib/jobIntel/skills.ts's alternation grouping. */
function groupSkillsForDisplay(skills: JobSkill[], level: "Required" | "Preferred"): SkillGroup[] {
  const filtered = skills.filter((s) => s.requirement_level === level);
  const groups = new Map<string, JobSkill[]>();
  const ungrouped: JobSkill[] = [];
  for (const skill of filtered) {
    if (skill.alternative_group_id) {
      const existing = groups.get(skill.alternative_group_id) ?? [];
      existing.push(skill);
      groups.set(skill.alternative_group_id, existing);
    } else {
      ungrouped.push(skill);
    }
  }
  const result: SkillGroup[] = [];
  for (const group of groups.values()) {
    result.push({
      label: group.map((s) => s.skill_name).join(" or "),
      category: group[0].category,
      evidence: group[0].evidence_snippet,
    });
  }
  for (const skill of ungrouped) {
    result.push({ label: skill.skill_name, category: skill.category, evidence: skill.evidence_snippet });
  }
  return result;
}

function SkillPillList({ groups }: { groups: SkillGroup[] }) {
  if (groups.length === 0) return <p className="text-xs text-tertiary">None extracted.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {groups.map((g, i) => (
        <span
          key={i}
          title={`${g.category}${g.evidence ? ` — "${g.evidence}"` : ""}`}
          className="rounded-md bg-app-bg px-2 py-0.5 text-xs text-secondary"
        >
          {g.label}
        </span>
      ))}
    </div>
  );
}

function CertificationList({ certifications, level }: { certifications: JobCertification[]; level: "Required" | "Preferred" }) {
  const filtered = certifications.filter((c) => c.requirement_level === level);
  if (filtered.length === 0) return null;
  return (
    <div>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary">
        {level} Certifications
      </h3>
      <SkillPillList groups={filtered.map((c) => ({ label: c.name, category: "Certification", evidence: c.evidence_snippet }))} />
    </div>
  );
}

function AtAGlanceCard({
  job,
  sections,
  skills,
  certifications,
}: {
  job: JobWithCompany;
  sections: DescriptionSections | null;
  skills: JobSkill[];
  certifications: JobCertification[];
}) {
  const locationList = parseLocationList(job.location_list_json);
  const locationValue =
    locationList.length > 1
      ? `${formatLocation(job) ?? "Multiple locations"} (+${locationList.length - 1} more)`
      : formatLocation(job);

  const requiredSkills = groupSkillsForDisplay(skills, "Required");
  const preferredSkills = groupSkillsForDisplay(skills, "Preferred");
  const hasCerts = certifications.length > 0;

  const sectionKeys = (Object.keys(SECTION_LABELS) as (keyof DescriptionSections)[]).filter(
    (key) => sections?.[key]
  );

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-5">
      <h2 className="section-title">At a Glance</h2>
      <p className="mb-3 text-xs text-tertiary">
        Deterministic, rule-based extraction from the full description below — always verify
        against it. Fields left as &ldquo;Unknown&rdquo; had no reliable evidence in this posting.
      </p>

      <div className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Fact label="Seniority" value={job.seniority} title={job.seniority_evidence ?? undefined} />
        <Fact label="Employment Type" value={job.employment_type_normalized} />
        <Fact
          label="Work Arrangement"
          value={job.workplace_type_normalized}
          title={job.workplace_office_days ?? undefined}
        />
        <Fact label="Location" value={locationValue} />
        <Fact label="Salary" value={formatSalary(job)} title={job.salary_bonus ?? job.salary_equity ?? undefined} />
        <Fact label="Experience" value={formatExperience(job)} title={job.experience_evidence ?? undefined} />
        <Fact label="Education" value={formatEducation(job)} title={job.education_evidence ?? undefined} />
        <div>
          <div className="text-[11px] font-medium text-tertiary">Sponsorship</div>
          <div className="mt-0.5">
            <H1bBadge confidence={job.h1b_combined_confidence} />
          </div>
        </div>
        <Fact label="Clearance" value={formatClearance(job)} title={job.clearance_evidence ?? undefined} />
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary">Required Skills</h3>
          <SkillPillList groups={requiredSkills} />
        </div>
        <div>
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary">Preferred Skills</h3>
          <SkillPillList groups={preferredSkills} />
        </div>
      </div>

      {hasCerts && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <CertificationList certifications={certifications} level="Required" />
          <CertificationList certifications={certifications} level="Preferred" />
        </div>
      )}

      {sectionKeys.length > 0 && (
        <div className="space-y-3 border-t border-[var(--separator)] pt-3">
          {sectionKeys.map((key) => (
            <div key={key}>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary">
                {SECTION_LABELS[key]}
              </h3>
              <p className="whitespace-pre-line text-[13px] text-secondary">{sections?.[key]}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * STAGE 2 — the job detail page, reordered around the decision.
 *
 * The page previously opened with a title and a link and put the verdict third down a narrow rail,
 * below Pipeline and the resume pipeline, while the wide column carried only static text. The order
 * now follows what the reader needs: verdict and its reasons, the evidence behind them, the job's
 * own facts, the posting itself, and finally the resume workflow — with operational controls moved
 * to a secondary rail beside them.
 *
 * Structural only. No section was deleted, no action was removed, every reason string is the
 * engine's own, and the single match request is the one MatchCard already made (see useJobMatch).
 */
export default function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const { thresholds, loaded: thresholdsLoaded } = useLifecycleThresholds();
  // Called unconditionally, above the early returns, so hook order is stable across renders. This
  // is the same single GET MatchCard used to issue on mount — lifted, not added.
  const match = useJobMatch(Number(id), candidateId);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${id}?candidateId=${candidateId}`);
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
    // Intentional: fetch-on-mount/id-or-candidate-change with a loading flag, not a render loop.
    // `load` is intentionally omitted below — it's redefined every render and doesn't depend on
    // anything but `id`/`candidateId`, which are already the effect's dependencies.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, candidateId]);

  if (loading || !thresholdsLoaded) return <p className="text-[13px] text-tertiary">Loading…</p>;
  if (notFound || !data) return <p className="text-[13px] text-tertiary">Job not found.</p>;

  const { job, generatedFiles, skills, certifications } = data;
  const sections = parseSections(job.description_sections);

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      {/* ---- Primary column: decision, evidence, the job, the posting, the resume workflow ---- */}
      <div className="min-w-0 space-y-5">
        <JobDecisionHeader
          job={job}
          match={match}
          thresholds={thresholds}
          actions={
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <TailoringToggle
                  jobId={job.id}
                  initial={job.marked_for_tailoring === 1}
                  candidateId={candidateId}
                />
                <CopyPromptButton job={job} candidateId={candidateId} />
              </div>
              <p className="text-[12px] text-tertiary">
                Tailoring runs in Claude Code, not this app. Mark this job, then run the copied skill
                prompt in a Claude Code session in this project — nothing is written or submitted from
                here.
              </p>
            </div>
          }
        />

        <MatchCard match={match} />

        <AtAGlanceCard job={job} sections={sections} skills={skills} certifications={certifications} />

        <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-5">
          {/* Open by default: the posting is primary content, and the disclosure exists only so a
           *  very long description can be folded away once read — never to truncate it. */}
          <Disclosure title="Full description" defaultOpen>
            {job.description_html ? (
              <div
                className="prose prose-sm dark:prose-invert mt-1 max-w-none text-[13px]"
                dangerouslySetInnerHTML={{ __html: sanitizeJobHtml(job.description_html) }}
              />
            ) : job.description_text ? (
              <p className="mt-1 whitespace-pre-line text-[13px] text-secondary">{job.description_text}</p>
            ) : (
              <p className="mt-1 text-[13px] text-tertiary">
                No description text captured for this posting (common for career-link scrapes, since
                that scraper only extracts links/titles). View the original posting for details, or
                add this company as a proper Greenhouse/Ashby/Lever entry on the Companies page if
                available — see the note there if one was auto-detected.
              </p>
            )}
          </Disclosure>
        </section>

        {/* Moved out of the 1fr rail: this component lays itself out in up to five columns and was
         *  being compressed into a third of the page. Its behaviour is untouched. */}
        <ResumeQualityPipeline jobId={job.id} jobTitle={job.title} companyName={job.company_name} />
      </div>

      {/* ---- Secondary rail: operational state. Nothing here gates a review decision. ---- */}
      <div className="min-w-0 space-y-5">
        <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-4">
          <h2 className="mb-2 text-[13px] font-semibold text-primary">Pipeline</h2>
          <div className="mb-1 text-[11px] text-tertiary">Status</div>
          <PipelineStatusSelect
            jobId={job.id}
            value={job.pipeline_status}
            candidateId={candidateId}
            onChanged={() => {
              load();
              setHistoryKey((k) => k + 1);
            }}
          />
        </section>

        <H1bIntelligenceCard job={job} />

        <LifecycleCard
          job={job}
          thresholds={thresholds}
          candidateId={candidateId}
          onChanged={() => {
            load();
            setHistoryKey((k) => k + 1);
          }}
        />

        <NotesTagsCard job={job} candidateId={candidateId} onChanged={load} />

        <AiInsightsCard jobId={job.id} />

        <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-4">
          <h2 className="mb-2 text-[13px] font-semibold text-primary">
            Generated files ({generatedFiles.length})
          </h2>
          {generatedFiles.length === 0 ? (
            <p className="text-xs text-tertiary">None yet.</p>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {generatedFiles.map((f) => (
                <li key={f} className="font-mono text-secondary">
                  {f}
                </li>
              ))}
            </ul>
          )}
        </section>

        <HistoryCard jobId={job.id} refreshKey={historyKey} />

        <NotInterestedButton job={job} candidateId={candidateId} />
      </div>
    </div>
  );
}
