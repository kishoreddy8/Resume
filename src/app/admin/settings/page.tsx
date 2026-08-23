"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AdminConfirmDialog,
  AdminErrorState,
  AdminFeedbackBanner,
  AdminLoadingState,
  AdminPageHeader,
  AdminStatus,
} from "@/components/admin";
import { useAdminCandidate } from "@/lib/admin/AdminContext";
import type { AppSettings } from "@/lib/settings";

type Group = keyof AppSettings;

const FIELD_DESCRIPTIONS: Record<string, { label: string; description: string; unit?: string }> = {
  enabled: {
    label: "Master Automation Switch",
    description: "Enable or pause all background automated tasks across the entire system.",
  },
  scanEnabled: {
    label: "Job Discovery Scanner",
    description: "Run automated ATS scans to ingest new job postings.",
  },
  productionEnabled: {
    label: "Production Ingestion",
    description: "Ingest and process discovered job postings into active pipelines.",
  },
  evaluationEnabled: {
    label: "Candidate Matching Evaluation",
    description: "Automatically evaluate and score new jobs against candidate profiles.",
  },
  writerEnabled: {
    label: "Resume Studio Writer",
    description: "Process queued resume tailoring workflows using configured AI model providers.",
  },
  intervalMinutes: {
    label: "Scan Interval",
    description: "Frequency between scheduled automation cycles.",
    unit: "minutes",
  },
  windowStartHour: {
    label: "Execution Window Start",
    description: "Earliest hour of the day (0–23) to run scheduled automation.",
    unit: "hour (0-23)",
  },
  windowEndHour: {
    label: "Execution Window End",
    description: "Latest hour of the day (0–23) to run scheduled automation.",
    unit: "hour (0-23)",
  },
  timezone: {
    label: "Operating Timezone",
    description: "IANA timezone identifier for execution window calculations.",
  },
  timeoutMs: {
    label: "Scanner Timeout",
    description: "Maximum duration before an individual ATS scan request is aborted.",
    unit: "ms",
  },
  maxAttempts: {
    label: "Maximum Retry Attempts",
    description: "Number of retries before a failing connector is marked degraded or offline.",
  },
  baseDelayMs: {
    label: "Base Retry Delay",
    description: "Initial exponential backoff delay before retrying a failed connector.",
    unit: "ms",
  },
  maxDelayMs: {
    label: "Maximum Retry Delay",
    description: "Maximum backoff cap for connector retry attempts.",
    unit: "ms",
  },
  concurrency: {
    label: "Scanner Concurrency",
    description: "Maximum simultaneous connector requests in flight.",
  },
  freshDays: {
    label: "Fresh Job Threshold",
    description: "Jobs posted within this number of days are considered fresh.",
    unit: "days",
  },
  archiveAfterDays: {
    label: "Auto-Archive Age",
    description: "Age in days before inactive postings are automatically archived.",
    unit: "days",
  },
  deleteAfterDays: {
    label: "Purge Threshold",
    description: "Age in days before archived postings are permanently purged.",
    unit: "days",
  },
  expiredJobSuppressionDays: {
    label: "Expired-Job Suppression",
    description: "Number of days to suppress rediscovering closed postings.",
    unit: "days",
  },
};

export default function AdminSettingsPage() {
  const { candidateId } = useAdminCandidate();
  const [data, setData] = useState<AppSettings | null>(null);
  const [savedData, setSavedData] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [saving, setSaving] = useState<Group | "all" | null>(null);
  const [confirmWriter, setConfirmWriter] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/settings?candidateId=${candidateId}`);
      if (!r.ok) throw new Error((await r.json()).error ?? "Settings unavailable");
      const j = await r.json();
      setData(j.settings);
      setSavedData(JSON.parse(JSON.stringify(j.settings)));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settings unavailable");
    }
  }, [candidateId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function save(group: Group) {
    if (!data) return;
    setSaving(group);
    setFeedback(null);
    try {
      const r = await fetch(`/api/settings?candidateId=${candidateId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [group]: data[group] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to save settings");
      setData(j.settings);
      setSavedData(JSON.parse(JSON.stringify(j.settings)));
      setFeedback(`Section "${group}" settings saved successfully.`);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(null);
    }
  }

  function update(group: Group, key: string, value: unknown) {
    setData((current) =>
      current
        ? {
            ...current,
            [group]: {
              ...current[group],
              [key]: value,
            },
          }
        : current
    );
  }

  function isGroupDirty(group: Group): boolean {
    if (!data || !savedData) return false;
    return JSON.stringify(data[group]) !== JSON.stringify(savedData[group]);
  }

  if (error && !data) {
    return <AdminErrorState detail={error} retry={() => void load()} />;
  }

  if (!data) {
    return <AdminLoadingState label="Loading operational system settings" />;
  }

  const scheduler = data.scheduler;
  const anyDirty =
    isGroupDirty("scheduler") ||
    isGroupDirty("scanner") ||
    isGroupDirty("lifecycle") ||
    isGroupDirty("suppression");

  return (
    <div className="admin-page-stack">
      <AdminPageHeader
        eyebrow="Configuration & Policy"
        title="System Settings"
        description="Persisted operational parameters for automation schedules, scanner concurrency, lifecycle thresholds, and job suppression rules."
        statusSummary={
          anyDirty ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 dark:bg-amber-950/40 px-3 py-1 text-xs font-bold text-amber-800 dark:text-amber-300 border border-amber-300 dark:border-amber-800">
              ● Unsaved Changes
            </span>
          ) : (
            <AdminStatus status="healthy" label="All Settings Synced" />
          )
        }
        actions={
          <button
            type="button"
            className="admin-button admin-button-secondary"
            onClick={() => void load()}
          >
            Reset / Refresh
          </button>
        }
      />

      {feedback && (
        <AdminFeedbackBanner
          tone="success"
          message={feedback}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {error && (
        <AdminFeedbackBanner
          tone="error"
          message={error}
          onDismiss={() => setError(null)}
        />
      )}

      {/* Section 1: Automation & Scheduler */}
      <section className="admin-settings-card">
        <div className="admin-section-heading">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="admin-section-title">Automation & Scheduler</h2>
              {isGroupDirty("scheduler") && (
                <span className="text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950 px-2 py-0.5 rounded-md">
                  Unsaved
                </span>
              )}
            </div>
            <p>
              Master switches and subsystem schedules. Turning a switch off pauses that subsystem without discarding its configuration.
            </p>
          </div>
          <button
            type="button"
            className="admin-button admin-button-primary"
            disabled={saving === "scheduler" || !isGroupDirty("scheduler")}
            onClick={() => void save("scheduler")}
          >
            {saving === "scheduler" ? "Saving…" : "Save Automation"}
          </button>
        </div>

        <div className="space-y-4">
          {/* Master automation */}
          <div className="admin-setting-row">
            <div>
              <strong>{FIELD_DESCRIPTIONS.enabled.label}</strong>
              <p>{FIELD_DESCRIPTIONS.enabled.description}</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduler.enabled}
                onChange={(e) => update("scheduler", "enabled", e.target.checked)}
              />
              <span className="text-sm font-semibold">{scheduler.enabled ? "Active" : "Paused"}</span>
            </label>
          </div>

          {/* Scanner */}
          <div className="admin-setting-row">
            <div>
              <strong>{FIELD_DESCRIPTIONS.scanEnabled.label}</strong>
              <p>{FIELD_DESCRIPTIONS.scanEnabled.description}</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduler.scanEnabled}
                onChange={(e) => update("scheduler", "scanEnabled", e.target.checked)}
              />
              <span className="text-sm font-semibold">{scheduler.scanEnabled ? "Active" : "Paused"}</span>
            </label>
          </div>

          {/* Production Ingestion */}
          <div className="admin-setting-row">
            <div>
              <strong>{FIELD_DESCRIPTIONS.productionEnabled.label}</strong>
              <p>{FIELD_DESCRIPTIONS.productionEnabled.description}</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduler.productionEnabled}
                onChange={(e) => update("scheduler", "productionEnabled", e.target.checked)}
              />
              <span className="text-sm font-semibold">{scheduler.productionEnabled ? "Active" : "Paused"}</span>
            </label>
          </div>

          {/* Evaluation */}
          <div className="admin-setting-row">
            <div>
              <strong>{FIELD_DESCRIPTIONS.evaluationEnabled.label}</strong>
              <p>{FIELD_DESCRIPTIONS.evaluationEnabled.description}</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={scheduler.evaluationEnabled}
                onChange={(e) => update("scheduler", "evaluationEnabled", e.target.checked)}
              />
              <span className="text-sm font-semibold">{scheduler.evaluationEnabled ? "Active" : "Paused"}</span>
            </label>
          </div>

          {/* Resume Writer with Confirm Dialog (key==="writerEnabled") */}
          <div className="admin-setting-row">
            <div>
              <strong>{FIELD_DESCRIPTIONS.writerEnabled.label}</strong>
              <p>{FIELD_DESCRIPTIONS.writerEnabled.description}</p>
            </div>
            <button
              type="button"
              className={`admin-button ${scheduler.writerEnabled ? "admin-button-secondary" : "admin-button-primary"} !min-h-[38px] !text-xs`}
              onClick={() => {
                if (scheduler.writerEnabled) {
                  update("scheduler", "writerEnabled", false);
                } else {
                  setConfirmWriter(true);
                }
              }}
            >
              {scheduler.writerEnabled ? "Disable Writer" : "Enable Writer"}
            </button>
          </div>
        </div>

        {/* Schedule Inputs */}
        <div className="admin-settings-grid mt-6 pt-6 border-t border-[var(--separator)]">
          <label className="admin-field">
            <span>
              {FIELD_DESCRIPTIONS.intervalMinutes.label} ({FIELD_DESCRIPTIONS.intervalMinutes.unit})
            </span>
            <input
              type="number"
              min={1}
              max={1440}
              value={scheduler.intervalMinutes}
              onChange={(e) => update("scheduler", "intervalMinutes", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.intervalMinutes.description}</span>
          </label>

          <label className="admin-field">
            <span>Operating Timezone</span>
            <input
              type="text"
              value={scheduler.timezone}
              onChange={(e) => update("scheduler", "timezone", e.target.value)}
              placeholder="e.g. America/Chicago"
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.timezone.description}</span>
          </label>

          <label className="admin-field">
            <span>Window Start Hour (0–23)</span>
            <input
              type="number"
              min={0}
              max={23}
              value={scheduler.windowStartHour}
              onChange={(e) => update("scheduler", "windowStartHour", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.windowStartHour.description}</span>
          </label>

          <label className="admin-field">
            <span>Window End Hour (0–23)</span>
            <input
              type="number"
              min={0}
              max={23}
              value={scheduler.windowEndHour}
              onChange={(e) => update("scheduler", "windowEndHour", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.windowEndHour.description}</span>
          </label>
        </div>
      </section>

      {/* Section 2: Scanner Resilience & Concurrency */}
      <section className="admin-settings-card">
        <div className="admin-section-heading">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="admin-section-title">Scanner Resilience & Concurrency</h2>
              {isGroupDirty("scanner") && (
                <span className="text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950 px-2 py-0.5 rounded-md">
                  Unsaved
                </span>
              )}
            </div>
            <p>Timeouts, retry attempts, exponential backoff curves, and worker request concurrency.</p>
          </div>
          <button
            type="button"
            className="admin-button admin-button-primary"
            disabled={saving === "scanner" || !isGroupDirty("scanner")}
            onClick={() => void save("scanner")}
          >
            {saving === "scanner" ? "Saving…" : "Save Scanner"}
          </button>
        </div>

        <div className="admin-settings-grid">
          <label className="admin-field">
            <span>Scanner Request Timeout (ms)</span>
            <input
              type="number"
              min={1000}
              max={60000}
              step={1000}
              value={data.scanner.timeoutMs}
              onChange={(e) => update("scanner", "timeoutMs", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.timeoutMs.description}</span>
          </label>

          <label className="admin-field">
            <span>Maximum Retry Attempts</span>
            <input
              type="number"
              min={1}
              max={10}
              value={data.scanner.maxAttempts}
              onChange={(e) => update("scanner", "maxAttempts", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.maxAttempts.description}</span>
          </label>

          <label className="admin-field">
            <span>Base Retry Delay (ms)</span>
            <input
              type="number"
              min={100}
              max={10000}
              step={500}
              value={data.scanner.baseDelayMs}
              onChange={(e) => update("scanner", "baseDelayMs", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.baseDelayMs.description}</span>
          </label>

          <label className="admin-field">
            <span>Maximum Retry Delay (ms)</span>
            <input
              type="number"
              min={1000}
              max={60000}
              step={1000}
              value={data.scanner.maxDelayMs}
              onChange={(e) => update("scanner", "maxDelayMs", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.maxDelayMs.description}</span>
          </label>

          <label className="admin-field">
            <span>Worker Concurrency</span>
            <input
              type="number"
              min={1}
              max={16}
              value={data.scanner.concurrency}
              onChange={(e) => update("scanner", "concurrency", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.concurrency.description}</span>
          </label>
        </div>
      </section>

      {/* Section 3: Job Lifecycle & Retention */}
      <section className="admin-settings-card">
        <div className="admin-section-heading">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="admin-section-title">Job Lifecycle & Retention</h2>
              {isGroupDirty("lifecycle") && (
                <span className="text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950 px-2 py-0.5 rounded-md">
                  Unsaved
                </span>
              )}
            </div>
            <p>Thresholds for freshness evaluation, automatic archiving, and durable job record purging.</p>
          </div>
          <button
            type="button"
            className="admin-button admin-button-primary"
            disabled={saving === "lifecycle" || !isGroupDirty("lifecycle")}
            onClick={() => void save("lifecycle")}
          >
            {saving === "lifecycle" ? "Saving…" : "Save Lifecycle"}
          </button>
        </div>

        <div className="admin-settings-grid">
          <label className="admin-field">
            <span>Fresh Active Jobs Threshold (days)</span>
            <input
              type="number"
              min={1}
              max={90}
              value={data.lifecycle.freshDays}
              onChange={(e) => update("lifecycle", "freshDays", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.freshDays.description}</span>
          </label>

          <label className="admin-field">
            <span>Archive Inactive Jobs After (days)</span>
            <input
              type="number"
              min={7}
              max={365}
              value={data.lifecycle.archiveAfterDays}
              onChange={(e) => update("lifecycle", "archiveAfterDays", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.archiveAfterDays.description}</span>
          </label>

          <label className="admin-field">
            <span>Permanently Delete Archived After (days)</span>
            <input
              type="number"
              min={14}
              max={730}
              value={data.lifecycle.deleteAfterDays}
              onChange={(e) => update("lifecycle", "deleteAfterDays", Number(e.target.value))}
            />
            <span className="text-xs text-tertiary">{FIELD_DESCRIPTIONS.deleteAfterDays.description}</span>
          </label>
        </div>
      </section>

      {/* Section 4: Job Suppression */}
      <section className="admin-settings-card">
        <div className="admin-section-heading">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="admin-section-title">Job Suppression Policy</h2>
              {isGroupDirty("suppression") && (
                <span className="text-xs font-bold text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950 px-2 py-0.5 rounded-md">
                  Unsaved
                </span>
              )}
            </div>
            <p>System-level age-out suppression rules. Candidate &ldquo;Not Interested&rdquo; dismissals remain permanently enforced.</p>
          </div>
          <button
            type="button"
            className="admin-button admin-button-primary"
            disabled={saving === "suppression" || !isGroupDirty("suppression")}
            onClick={() => void save("suppression")}
          >
            {saving === "suppression" ? "Saving…" : "Save Suppression"}
          </button>
        </div>

        <div className="admin-settings-grid">
          <label className="admin-field">
            <span>Expired Job Suppression Window (days)</span>
            <input
              type="number"
              min={1}
              max={180}
              value={data.suppression.expiredJobSuppressionDays}
              onChange={(e) =>
                update("suppression", "expiredJobSuppressionDays", Number(e.target.value))
              }
            />
            <span className="text-xs text-tertiary">
              {FIELD_DESCRIPTIONS.expiredJobSuppressionDays.description}
            </span>
          </label>
        </div>
      </section>

      {/* Advanced & Legacy */}
      <section className="admin-operational-card">
        <h3 className="text-base font-bold text-primary">Candidate Profile Authority</h3>
        <p className="admin-card-description mt-1">
          Global candidate eligibility parameters are stored for backward schema compatibility, but live candidate matching reads directly and authoritatively from each candidate&rsquo;s profile.
        </p>
      </section>

      {/* Confirmation Dialog for Enabling Resume Writer */}
      <AdminConfirmDialog
        open={confirmWriter}
        title="Enable Resume Writer Automation?"
        description="Enabling allows the background worker to automatically tailor resumes for queued applications using your configured AI model provider. Make sure your model API keys are configured in the environment."
        confirmLabel="Enable Resume Writer"
        onClose={() => setConfirmWriter(false)}
        onConfirm={() => {
          update("scheduler","writerEnabled",true);
          setConfirmWriter(false);
        }}
      />
    </div>
  );
}
