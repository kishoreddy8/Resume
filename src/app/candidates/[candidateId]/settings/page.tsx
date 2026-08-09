"use client";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import type { MatchAffectingCandidateSettings, CandidateRankingPreferences } from "@/db/queries/candidateSettings";

/**
 * Per-candidate preferences UI — see CAREER_OPS_PHASE_2_5_CHECKPOINT.md §5/§6 stage 2.
 * candidateSettings.ts's two-bucket type boundary is surfaced directly: "Ranking Preferences"
 * (For You only, never invalidates the match cache) is visually separate from "Eligibility"
 * (match-affecting — changing these legitimately re-evaluates future match runs).
 */

const CLEARANCE_LEVELS = ["None", "Public Trust", "Secret", "Top Secret", "TS/SCI"] as const;
const WORKPLACE_OPTIONS = ["Remote", "Hybrid", "Onsite"] as const;
const EMPLOYMENT_TYPE_OPTIONS = ["Full-Time", "Part-Time", "Contract", "Temporary", "Internship", "Contract-to-Hire"] as const;

function parseCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function CandidateSettingsPage({ params }: { params: Promise<{ candidateId: string }> }) {
  const { candidateId: candidateIdParam } = use(params);
  const candidateId = Number(candidateIdParam);

  const [matchAffecting, setMatchAffecting] = useState<MatchAffectingCandidateSettings | null>(null);
  const [preferences, setPreferences] = useState<CandidateRankingPreferences | null>(null);
  const [secondaryRolesText, setSecondaryRolesText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/settings`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load candidate settings");
        return;
      }
      setMatchAffecting(data.matchAffecting);
      setPreferences(data.preferences);
      setSecondaryRolesText((data.preferences?.secondaryTargetRoles ?? []).join(", "));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateId]);

  async function save() {
    if (!matchAffecting || !preferences) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/candidates/${candidateId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchAffecting,
          preferences: { ...preferences, secondaryTargetRoles: parseCommaList(secondaryRolesText) },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      setMatchAffecting(data.matchAffecting);
      setPreferences(data.preferences);
      setSecondaryRolesText((data.preferences?.secondaryTargetRoles ?? []).join(", "));
      setSavedAt(Date.now());
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function toggleWorkplace(option: string) {
    setPreferences((prev) => {
      if (!prev) return prev;
      const has = prev.workplacePreference.includes(option);
      const next = has ? prev.workplacePreference.filter((w) => w !== option) : [...prev.workplacePreference, option];
      return { ...prev, workplacePreference: next };
    });
    setSavedAt(null);
  }

  if (loading || !matchAffecting || !preferences) {
    return <p className="text-sm text-zinc-500">{error ?? "Loading…"}</p>;
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Candidate Preferences</h1>
          <p className="text-xs text-zinc-500">
            Ranking preferences change ordering only — they never invalidate cached Phase 2 match
            results or manufacture technical evidence. Eligibility fields feed the deterministic match
            engine directly; changing one legitimately re-evaluates future match runs for this
            candidate.
          </p>
        </div>
        <Link href="/jobs" className="text-xs text-zinc-500 hover:underline">
          ← Back to Jobs
        </Link>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {savedAt && !error && <p className="text-xs text-emerald-700 dark:text-emerald-400">Saved.</p>}

      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="text-sm font-semibold">Ranking Preferences</h2>
          <p className="text-xs text-zinc-500">
            Drives For You ordering only. A job outside these roles still shows up in For You — it just
            isn&apos;t promoted to the top.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Primary target role</span>
            <input
              value={preferences.primaryTargetRole ?? ""}
              onChange={(e) => {
                setPreferences((p) => (p ? { ...p, primaryTargetRole: e.target.value || null } : p));
                setSavedAt(null);
              }}
              placeholder="e.g. Data Engineer"
              className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Secondary target roles</span>
            <input
              value={secondaryRolesText}
              onChange={(e) => {
                setSecondaryRolesText(e.target.value);
                setSavedAt(null);
              }}
              placeholder="Azure Data Engineer, AI Engineer"
              className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <span className="text-xs text-zinc-500">Comma-separated.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Location preference</span>
            <input
              value={preferences.locationPreference ?? ""}
              onChange={(e) => {
                setPreferences((p) => (p ? { ...p, locationPreference: e.target.value || null } : p));
                setSavedAt(null);
              }}
              placeholder="e.g. Remote, or a city"
              className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Employment type preference</span>
            <select
              value={preferences.employmentTypePreference ?? ""}
              onChange={(e) => {
                setPreferences((p) => (p ? { ...p, employmentTypePreference: e.target.value || null } : p));
                setSavedAt(null);
              }}
              className="rounded border border-zinc-300 px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">No preference</option>
              {EMPLOYMENT_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div>
          <span className="mb-1 block text-sm font-medium">Workplace preference</span>
          <div className="flex gap-4">
            {WORKPLACE_OPTIONS.map((option) => (
              <label key={option} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={preferences.workplacePreference.includes(option)}
                  onChange={() => toggleWorkplace(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div>
          <h2 className="text-sm font-semibold">Eligibility</h2>
          <p className="text-xs text-zinc-500">
            Used by Phase 2&apos;s job-match eligibility check (sponsorship/clearance/work-authorization
            hard blockers). Never inferred from your resume — set these directly and accurately.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchAffecting.requiresSponsorship}
              onChange={(e) => {
                setMatchAffecting((m) => (m ? { ...m, requiresSponsorship: e.target.checked } : m));
                setSavedAt(null);
              }}
            />
            <span>Requires visa sponsorship</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchAffecting.usCitizen}
              onChange={(e) => {
                setMatchAffecting((m) => (m ? { ...m, usCitizen: e.target.checked } : m));
                setSavedAt(null);
              }}
            />
            <span>U.S. citizen</span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={matchAffecting.workAuthorizedUS}
              onChange={(e) => {
                setMatchAffecting((m) => (m ? { ...m, workAuthorizedUS: e.target.checked } : m));
                setSavedAt(null);
              }}
            />
            <span>Currently work-authorized in the U.S.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Security clearance held</span>
            <select
              value={matchAffecting.clearanceLevel}
              onChange={(e) => {
                setMatchAffecting((m) =>
                  m ? { ...m, clearanceLevel: e.target.value as MatchAffectingCandidateSettings["clearanceLevel"] } : m
                );
                setSavedAt(null);
              }}
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
      </section>

      <div>
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
