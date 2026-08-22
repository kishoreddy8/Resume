"use client";

import { useEffect, useState } from "react";
import { LoadingRegion, PageHeader, SkeletonRows, Surface } from "@/components/ui";
import type { AppSettings } from "@/lib/settings";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";
import { adminApiUrl } from "@/lib/admin/client";

interface FieldSpec {
  key: string;
  label: string;
  hint: string;
  min?: number;
  max?: number;
}

const LIFECYCLE_FIELDS: FieldSpec[] = [
  { key: "freshDays", label: "Fresh days", hint: "Jobs at or under this age are highlighted as high priority.", min: 0 },
  { key: "archiveAfterDays", label: "Archive after days", hint: "Jobs older than this (and unapplied/unpinned) become archive-eligible.", min: 0 },
  { key: "deleteAfterDays", label: "Delete after days", hint: "Jobs older than this (and unapplied/unpinned) are permanently deleted.", min: 0 },
];

const SUPPRESSION_FIELDS: FieldSpec[] = [
  {
    key: "expiredJobSuppressionDays",
    label: "Expired job suppression (days)",
    hint: "How long a system-deleted, aged-out job is kept from reappearing if the same posting resurfaces in a scan. Does not apply to jobs you mark Not Interested — those are suppressed permanently and cannot reappear.",
    min: 1,
    max: 3650,
  },
];

const SCANNER_FIELDS: FieldSpec[] = [
  { key: "timeoutMs", label: "Timeout (ms)", hint: "Per-attempt fetch timeout for ATS connectors.", min: 1000, max: 120_000 },
  { key: "maxAttempts", label: "Max attempts", hint: "Total attempts (1 initial + retries) before a fetch fails.", min: 1, max: 10 },
  { key: "baseDelayMs", label: "Base retry delay (ms)", hint: "Starting backoff delay between retries.", min: 0, max: 10_000 },
  { key: "maxDelayMs", label: "Max retry delay (ms)", hint: "Backoff delay ceiling; must be ≥ base retry delay.", min: 100, max: 60_000 },
  { key: "concurrency", label: "Concurrency", hint: "How many ATS companies scan in parallel.", min: 1, max: 20 },
];

type GroupKey = keyof AppSettings;

interface ApiError {
  path: string;
  message: string;
}

const CLEARANCE_LEVELS = ["None", "Public Trust", "Secret", "Top Secret", "TS/SCI"] as const;

/**
 * Candidate Eligibility (Phase 2) — booleans + one enum, so it doesn't fit SettingsGroup's
 * numeric-only <input type="number"> rendering; kept as its own small component instead of
 * contorting SettingsGroup to handle multiple field shapes.
 *
 * LEGACY, AND LABELLED AS SUCH BELOW. Matching does not read these. `getMatchAffectingSettings()`
 * reads the PER-CANDIDATE candidate_settings row, and that is what autoEvaluate, incrementalMatch
 * and rematchCandidate all use; this global group is the older single-profile version of the same
 * four facts and nothing in the match pipeline consults it. It is left reachable rather than
 * deleted — removing a persisted group is a data decision, not a presentation one — but it is no
 * longer shown anywhere a person could mistake it for the setting that filters their jobs. The
 * authoritative version is on each profile.
 */
function CandidateSettingsGroup({
  values,
  onChange,
  errors,
}: {
  values: AppSettings["candidate"];
  onChange: (key: keyof AppSettings["candidate"], value: boolean | string) => void;
  errors: ApiError[];
}) {
  const fieldError = (key: string) => errors.find((e) => e.path === `candidate.${key}`);
  return (
    <section className="plane plane-3 space-y-3 rounded-[var(--radius-xl)] px-5 py-4">
      <div>
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
          Candidate Eligibility (legacy)
        </h2>
        <p className="text-xs text-zinc-500">
          Matching does not read these. Each profile&apos;s own work authorization, on its Profile
          page, is what filters that profile&apos;s jobs. Kept here because the values are still
          stored.
        </p>
        <p className="text-xs text-zinc-500">
          Used only by Phase 2&apos;s job-match eligibility check (sponsorship/clearance/work-authorization
          hard blockers). Never inferred from your resume — set these directly and accurately.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.requiresSponsorship}
            onChange={(e) => onChange("requiresSponsorship", e.target.checked)}
          />
          <span>Requires visa sponsorship</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={values.usCitizen} onChange={(e) => onChange("usCitizen", e.target.checked)} />
          <span>U.S. citizen</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={values.workAuthorizedUS}
            onChange={(e) => onChange("workAuthorizedUS", e.target.checked)}
          />
          <span>Currently work-authorized in the U.S.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Security clearance held</span>
          <select
            value={values.clearanceLevel}
            onChange={(e) => onChange("clearanceLevel", e.target.value)}
            className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            {CLEARANCE_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      {fieldError("clearanceLevel") && <p className="text-xs text-red-600">{fieldError("clearanceLevel")?.message}</p>}
    </section>
  );
}

function SettingsGroup({
  title,
  description,
  group,
  fields,
  values,
  onChange,
  errors,
}: {
  title: string;
  description: string;
  group: GroupKey;
  fields: FieldSpec[];
  values: AppSettings[GroupKey];
  onChange: (group: GroupKey, key: string, value: number) => void;
  errors: ApiError[];
}) {
  return (
    <section className="plane plane-3 space-y-3 rounded-[var(--radius-xl)] px-5 py-4">
      <div>
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">{title}</h2>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          const fieldErrors = errors.filter((e) => e.path === `${group}.${field.key}`);
          return (
            <label key={field.key} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{field.label}</span>
              <input
                type="number"
                min={field.min}
                max={field.max}
                value={(values as unknown as Record<string, number>)[field.key]}
                onChange={(e) => onChange(group, field.key, Number(e.target.value))}
                className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              />
              <span className="text-xs text-zinc-500">{field.hint}</span>
              {fieldErrors.map((e, i) => (
                <span key={i} className="text-xs text-red-600">
                  {e.message}
                </span>
              ))}
            </label>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Stage 30.2 — the operator control for the resume writer.
 *
 * CareerOps has always stored and honoured `scheduler.writerEnabled`, and Operations has always
 * displayed it, but there was no way to change it from the UI at all — the only route was a direct
 * settings API call. This is that control, and nothing more.
 *
 * Two deliberate differences from the rest of this page:
 *   - It writes IMMEDIATELY rather than joining the batch Save, and sends ONLY
 *     `{ scheduler: { writerEnabled } }`. The settings layer merges a partial patch, so the master
 *     switch and the scan/ingestion/evaluation flags are provably untouched by this control.
 *   - Turning it ON takes two clicks. This is the one setting on the page that causes CareerOps to
 *     spend the user's Claude subscription on work already sitting in the queue, so a single stray
 *     click should not start it.
 *
 * Turning it on grants no new authority: it only lets ALREADY-APPROVED workflows be picked up by the
 * normal scheduled writer. It approves nothing, creates no workflow, and submits no application.
 */
function ResumeWriterControl({
  enabled,
  onChanged,
}: {
  enabled: boolean;
  onChanged: (settings: AppSettings) => void;
}) {
  const candidateId = useActiveCandidateId();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setWriterEnabled(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      // Only this one field is sent — never the whole settings object.
      const res = await fetch(adminApiUrl("/api/settings", candidateId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduler: { writerEnabled: next } }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to update the resume writer setting");
        return;
      }
      // Reflect what was actually persisted, never the value we optimistically sent.
      onChanged(data.settings as AppSettings);
      setConfirming(false);
    } catch {
      setError("Failed to update the resume writer setting");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="plane plane-3 space-y-3 rounded-[var(--radius-xl)] px-5 py-4">
      <div>
        <h2 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Resume Writer</h2>
        <p className="text-xs text-zinc-500">
          Whether the background worker may automatically write resumes for jobs you have already approved. This is
          the only setting that spends your Claude subscription. Turning it on approves nothing, creates no new
          tailoring work, and never submits an application — it only lets already-approved workflows be picked up.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span
          data-testid="writer-enabled-state"
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            enabled
              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
              : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200"
          }`}
        >
          {enabled ? "ON" : "OFF"}
        </span>

        {enabled ? (
          <button
            onClick={() => void setWriterEnabled(false)}
            disabled={busy}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            {busy ? "Saving…" : "Turn Resume Writer OFF"}
          </button>
        ) : confirming ? (
          <>
            <button
              onClick={() => void setWriterEnabled(true)}
              disabled={busy}
              className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Confirm — start writing approved jobs"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Turn Resume Writer ON
          </button>
        )}
      </div>

      {confirming && !enabled && (
        <p className="text-xs font-medium text-amber-800 dark:text-amber-400">
          Any jobs you have already approved will begin being written on the next scheduled pass, using your Claude
          subscription. You still review and send every application yourself.
        </p>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <p className="text-[11px] text-zinc-500">
        Background automation must also be enabled for this to take effect. This control changes nothing else — not the
        automation master switch, and not scan, ingestion, or evaluation.
      </p>
    </section>
  );
}

export default function SettingsPage() {
  const candidateId = useActiveCandidateId();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errors, setErrors] = useState<ApiError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(adminApiUrl("/api/settings", candidateId));
      const data = await res.json();
      setSettings(data.settings);
      setDefaults(data.defaults);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // load is intentionally local; candidateId is its only changing input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  function handleChange(group: GroupKey, key: string, value: number) {
    setSettings((prev) => {
      if (!prev) return prev;
      return { ...prev, [group]: { ...prev[group], [key]: value } };
    });
    setSavedAt(null);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setErrors([]);
    setFormError(null);
    try {
      const res = await fetch(adminApiUrl("/api/settings", candidateId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors(data.details ?? []);
        setFormError(data.error ?? "Failed to save settings");
        return;
      }
      setSettings(data.settings);
      setSavedAt(Date.now());
    } catch {
      setFormError("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function resetToDefaults() {
    if (!confirm("Reset all settings to their safe defaults?")) return;
    setResetting(true);
    setErrors([]);
    setFormError(null);
    try {
      const res = await fetch(adminApiUrl("/api/settings/reset", candidateId), { method: "POST" });
      const data = await res.json();
      setSettings(data.settings);
      setSavedAt(Date.now());
    } finally {
      setResetting(false);
    }
  }

  if (loading || !settings || !defaults) {
    return (
      <div className="flex flex-col gap-4">
        <LoadingRegion label="Loading settings" />
        <Surface level="z3" className="rounded-[var(--radius-xl)] p-5">
          <SkeletonRows rows={8} />
        </Surface>
      </div>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="System settings"
        description="Lifecycle, suppression and scanner behaviour. Defaults reproduce today's existing behaviour — changes take effect on the next scan or sweep. These are operator controls: they affect every profile, not just yours."
        actions={
          <>
            <button
              type="button"
              onClick={resetToDefaults}
              disabled={saving || resetting}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:scale-[0.98] disabled:opacity-50"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || resetting}
              className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-[12.5px] font-semibold text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.98] disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      />

      {formError && <p className="text-[12.5px] text-[var(--error)]">{formError}</p>}
      {savedAt && !formError && <p className="text-[11.5px] text-[var(--success)]">Saved.</p>}

      <ResumeWriterControl
        enabled={settings.scheduler.writerEnabled}
        onChanged={(next) => {
          setSettings(next);
          setSavedAt(null);
        }}
      />
      <SettingsGroup
        title="Lifecycle"
        description="Age-based archive/delete thresholds. Applied/Interviewing/Offer/Employer Rejected and pinned jobs are never affected, regardless of these values."
        group="lifecycle"
        fields={LIFECYCLE_FIELDS}
        values={settings.lifecycle}
        onChange={handleChange}
        errors={errors}
      />
      <SettingsGroup
        title="Suppression"
        description="How long a system-deleted, aged-out job is kept from silently reappearing if the same posting resurfaces in a scan. Explicit Not Interested rejections are always permanent and are not configurable here."
        group="suppression"
        fields={SUPPRESSION_FIELDS}
        values={settings.suppression}
        onChange={handleChange}
        errors={errors}
      />
      <SettingsGroup
        title="Scanner"
        description="Per-attempt timeout, retry/backoff, and how many companies scan in parallel. A failed or partial scan never performs destructive actions, regardless of these values."
        group="scanner"
        fields={SCANNER_FIELDS}
        values={settings.scanner}
        onChange={handleChange}
        errors={errors}
      />
      <CandidateSettingsGroup
        values={settings.candidate}
        onChange={(key, value) => {
          setSettings((prev) => (prev ? { ...prev, candidate: { ...prev.candidate, [key]: value } } : prev));
          setSavedAt(null);
        }}
        errors={errors}
      />
    </div>
  );
}
