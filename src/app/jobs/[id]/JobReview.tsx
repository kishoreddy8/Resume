"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { H1bBadge } from "@/components/H1bBadge";
import { PipelineStatusSelect } from "@/components/PipelineStatusSelect";
import { AiInsightsCard } from "./AiInsightsCard";
import { Disclosure } from "./Disclosure";
import { JobDecisionHeader } from "./JobDecisionHeader";
import { JobActionDock, DockMenuItem, resolveDockState } from "./JobActionDock";
import { JobReviewSkeleton, LoadingRegion } from "../Skeletons";
import { AnimatePresence, motion } from "motion/react";
import { MatchCard } from "./MatchCard";
import { ResumeQualityPipeline } from "./ResumeQualityPipeline";
import { RequirementsPanel } from "./RequirementsPanel";
import { RequirementsSummary } from "./RequirementsSummary";
import { SkillAlignment } from "./SkillAlignment";
import { TailoringStudio } from "./TailoringStudio";
import { ApplicationReadiness } from "./ApplicationReadiness";
import type { ResumeStageSummary } from "./resumeStage";
import { SectionNav, type SectionDef } from "./SectionNav";
import type { QueueNeighbours } from "../queue";
import { TailoringImpact } from "./TailoringImpact";
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
    <div className="border-t border-[var(--separator)] px-5 py-4">
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
      {error && <p className="mt-2 text-xs text-[var(--error)]">{error}</p>}
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
        className="rounded-md border border-[var(--error)]/35 px-3 py-1.5 text-xs font-medium text-[var(--error)] transition-[background-color,transform] duration-150 ease-out hover:bg-[color-mix(in_oklab,var(--error)_10%,transparent)] active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
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
    <div className="border-t border-[var(--separator)] px-5 py-4">
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
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
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
    <section className="border-t border-[var(--separator)] px-5 py-4">
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
    <section className="border-t border-[var(--separator)] px-5 py-4">
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
    <section className="border-t border-[var(--separator)] px-5 py-4">
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
 * WORKBENCH PHASE 1 — the job review body, extracted from the /jobs/[id] route so the same
 * component can render in two places: the full route page, and the Workbench's persistent detail
 * pane beside the jobs list.
 *
 * This is a move, not a rewrite. Every section, every action, every mutation path and the Stage 2
 * decision-first ordering are unchanged; only the outer container differs. `layout="page"` keeps the
 * route's two-column arrangement, `layout="pane"` stacks everything in one column because the pane
 * is narrow. Extracting it is what lets the Workbench reuse Stage 2 wholesale instead of growing a
 * second, drifting copy of the same review UI.
 *
 * The data it needs is exactly what the route already fetched: one GET per selected job, plus the
 * match/history/quality-workflow requests those child components already made. Nothing new.
 */
export function JobReview({
  jobId,
  layout = "page",
  onClose,
  nav,
  onSelectJob,
  scrollRoot,
}: {
  jobId: number;
  layout?: "page" | "pane";
  /** Rendered as a close affordance when the review is presented as a pane/sheet. */
  onClose?: () => void;
  /** Position in the visible queue. Absent on the standalone route, which has no queue beside it. */
  nav?: QueueNeighbours;
  onSelectJob?: (id: number) => void;
  /** The scrolling ancestor, so the section observer watches the right root. */
  scrollRoot?: HTMLElement | null;
}) {
  const candidateId = useActiveCandidateId();
  const [data, setData] = useState<JobDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  /* The resume workflow stage, reported up by ResumeQualityPipeline. This is a lift, not a second
   * fetch — that component still owns the only GET of /quality-workflow. */
  const [resumeStage, setResumeStage] = useState<ResumeStageSummary | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const { thresholds, loaded: thresholdsLoaded } = useLifecycleThresholds();
  // Called unconditionally, above the early returns, so hook order is stable across renders. This
  // is the same single GET MatchCard used to issue on mount — lifted, not added.
  const match = useJobMatch(jobId, candidateId);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}?candidateId=${candidateId}`);
      if (res.status === 404) {
        setNotFound(true);
        return;
      }
      const json = (await res.json()) as JobDetailResponse;
      setData(json);
      setNotFound(false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount/id-or-candidate-change with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, candidateId]);

  if (loading || !thresholdsLoaded) {
    return (
      <AnimatePresence mode="wait">
        {/* One grouped fade, not one per skeleton line: the placeholder leaves as a single
         *  object so the real content resolves into the same space without a blank frame. */}
        <motion.div key="skeleton" exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
          <LoadingRegion label="Loading job review" />
          <JobReviewSkeleton />
        </motion.div>
      </AnimatePresence>
    );
  }
  if (notFound || !data) return <p className="p-5 text-[13px] text-tertiary">Job not found.</p>;

  const { job, generatedFiles, skills, certifications } = data;
  const sections = parseSections(job.description_sections);
  const pane = layout === "pane";

  // Presentation only: reads the decision, the tailoring mark and whether files exist. No request.
  const dockState = resolveDockState(match, job, generatedFiles.length);

  async function toggleTailoringMark() {
    const next = job.marked_for_tailoring !== 1;
    await fetch(`/api/jobs/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId, markedForTailoring: next }),
    });
    load();
  }

  async function copyPrompt() {
    await navigator.clipboard.writeText(`/tailor-resume candidate=${candidateId} job=${job.id}`);
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  }

  /** Each branch runs an action that already existed; none of them is new behaviour. */
  function onDockPrimary() {
    switch (dockState.phase) {
      case "unevaluated":
        match.evaluate();
        return;
      case "ready-to-approve":
        toggleTailoringMark();
        return;
      case "needs-review":
      case "resume-ready":
        // Both are "go read the section that explains this" — scroll rather than mutate.
        document
          .getElementById(dockState.phase === "needs-review" ? "job-evidence" : "job-resume")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      default:
        return;
    }
  }

  const decisionHeader = (
    <JobDecisionHeader
      job={job}
      match={match}
      thresholds={thresholds}
      showBackLink={!pane}
      onClose={onClose}
      headingLevel={pane ? "h2" : "h1"}
      generatedFileCount={generatedFiles.length}
      nav={nav}
      onSelectJob={onSelectJob}
      resumeStage={resumeStage}
      requirementsSummary={
        <RequirementsSummary
          job={job}
          result={match.result}
          certifications={certifications}
          onJump={() => document.getElementById("job-requirements")?.scrollIntoView({ block: "start" })}
        />
      }
      intelligenceBand={
        /* Splits only once there is genuinely room for two columns. At lg the readiness column
         * measured 146px and its rows wrapped; stacking beats two cramped columns. */
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <TailoringStudio
            job={job}
            match={match}
            generatedFileCount={generatedFiles.length}
            resume={resumeStage}
            onJumpToPipeline={() => document.getElementById("job-resume")?.scrollIntoView({ block: "start" })}
          />
          <ApplicationReadiness
            job={job}
            result={match.result}
            certifications={certifications}
            onJump={() => document.getElementById("job-skills")?.scrollIntoView({ block: "start" })}
          />
        </div>
      }
      actions={
        <JobActionDock
          state={dockState}
          postingUrl={job.url}
          onPrimary={onDockPrimary}
          overflow={
            <>
              <DockMenuItem onSelect={copyPrompt}>
                {promptCopied ? "Prompt copied" : "Copy Claude Code prompt"}
              </DockMenuItem>
              <DockMenuItem onSelect={toggleTailoringMark}>
                {job.marked_for_tailoring === 1 ? "Unmark for tailoring" : "Mark for tailoring"}
              </DockMenuItem>
              {match.state === "ok" && (
                <DockMenuItem onSelect={match.evaluate}>Re-evaluate match</DockMenuItem>
              )}
            </>
          }
        />
      }
    />
  );

  /* Requirements and tailoring sit immediately under the hero — both read state the page already
   * has (the job row, the match result, the certifications from the detail payload, and the
   * generated-file list). Neither adds a request. */
  /* Section ids double as scroll targets for SectionNav. `scroll-mt` keeps each heading clear of
   * the sticky bar so a tabbed-to heading is never hidden underneath it. */
  const navSections: SectionDef[] = [
    { id: "job-overview", label: "Overview" },
    { id: "job-skills", label: "Skills" },
    { id: "job-requirements", label: "Requirements" },
    { id: "job-tailoring", label: "Tailoring" },
    { id: "job-resume", label: "Resume" },
    { id: "job-posting", label: "Job" },
    { id: "job-evidence", label: "Evidence" },
  ];

  /* The full alignment matrix. The hero carries the summary and the first four rows; everything
   * else lives here so the command center stays readable in one screen. */
  const skillsCard = match.result ? (
    <section id="job-skills" className="scroll-mt-14 border-t border-[var(--separator)] px-5 py-4">
      <h2 className="mb-2 text-[13px] font-semibold text-primary">Skill intelligence</h2>
      <SkillAlignment result={match.result} />
    </section>
  ) : null;

  /* The detailed resume pipeline. Moved out of the page's very bottom to sit directly after
   * Tailoring — the two are the same subject, and burying it under job facts, H1B, the full posting
   * and history meant the only place to see resume progress was six screens down. Its high-level
   * stage now also appears in the studio at the top, from this same component's own fetch. */
  const resumePipelineCard = (
    <section id="job-resume" className="scroll-mt-14 border-t border-[var(--separator)] px-5 py-4">
      <ResumeQualityPipeline
        jobId={job.id}
        jobTitle={job.title}
        companyName={job.company_name}
        onStageChange={setResumeStage}
      />
    </section>
  );

  const requirementsCard = (
    <section id="job-requirements" className="scroll-mt-14 border-t border-[var(--separator)] px-5 py-4">
      <h2 className="mb-2 text-[13px] font-semibold text-primary">Requirements</h2>
      <RequirementsPanel job={job} result={match.result} certifications={certifications} />
    </section>
  );

  const tailoringCard = (
    <section id="job-tailoring" className="scroll-mt-14 border-t border-[var(--separator)] px-5 py-4">
      <h2 className="mb-2 text-[13px] font-semibold text-primary">Tailoring</h2>
      <TailoringImpact
        result={match.result}
        approved={job.marked_for_tailoring === 1}
        generatedFileCount={generatedFiles.length}
      />
    </section>
  );

  const pipelineCard = (
    <section className="border-t border-[var(--separator)] px-5 py-4">
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
  );

  const generatedFilesCard = (
    <section className="border-t border-[var(--separator)] px-5 py-4">
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
  );

  const descriptionCard = (
    <section id="job-posting" className="scroll-mt-14 border-t border-[var(--separator)] px-5 py-4">
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
  );

  const lifecycleCard = (
    <LifecycleCard
      job={job}
      thresholds={thresholds}
      candidateId={candidateId}
      onChanged={() => {
        load();
        setHistoryKey((k) => k + 1);
      }}
    />
  );

  // Stage 2's decision-first order is preserved in both layouts. The pane simply stacks what the
  // page puts in a secondary rail, so nothing is dropped and nothing is reordered ahead of the
  // verdict and its reasons.
  if (pane) {
    return (
      /* One surface, sections separated by hairlines. The header keeps its own weight because it
         is the only part that must be read; everything after it is depth, ordered
         decision -> evidence -> facts -> posting -> provenance -> operational -> resume. */
      <div className="bg-surface">
        <div id="job-overview" className="scroll-mt-14" />
        {decisionHeader}
        {pane && <SectionNav sections={navSections} scrollRoot={scrollRoot} />}
        {skillsCard}
        {requirementsCard}
        {tailoringCard}
        {resumePipelineCard}
        <div id="job-evidence" className="scroll-mt-14" />
        <MatchCard match={match} />
        <AtAGlanceCard job={job} sections={sections} skills={skills} certifications={certifications} />
        {descriptionCard}
        <H1bIntelligenceCard job={job} />
        {pipelineCard}
        {lifecycleCard}
        <NotesTagsCard job={job} candidateId={candidateId} onChanged={load} />
        <AiInsightsCard jobId={job.id} />
        {generatedFilesCard}
        <HistoryCard jobId={job.id} refreshKey={historyKey} />
        <NotInterestedButton job={job} candidateId={candidateId} />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
      <div className="min-w-0 space-y-5">
        <div id="job-overview" className="scroll-mt-14" />
        {decisionHeader}
        {skillsCard}
        {requirementsCard}
        {tailoringCard}
        {resumePipelineCard}
        <div id="job-evidence" className="scroll-mt-14" />
        <MatchCard match={match} />
        <AtAGlanceCard job={job} sections={sections} skills={skills} certifications={certifications} />
        {descriptionCard}
      </div>

      <div className="min-w-0 space-y-5">
        {pipelineCard}
        <H1bIntelligenceCard job={job} />
        {lifecycleCard}
        <NotesTagsCard job={job} candidateId={candidateId} onChanged={load} />
        <AiInsightsCard jobId={job.id} />
        {generatedFilesCard}
        <HistoryCard jobId={job.id} refreshKey={historyKey} />
        <NotInterestedButton job={job} candidateId={candidateId} />
      </div>
    </div>
  );
}
