"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { primeActiveCandidateId } from "@/lib/useActiveCandidateId";

/**
 * Minimal candidate onboarding: name only here — master resume/skills upload happens on the
 * existing /master-files page (now candidate-scoped, see src/app/api/master-files/route.ts), and
 * eligibility/target-role preferences default conservatively (requiresSponsorship: true) and can be
 * adjusted later. This keeps onboarding to exactly what's needed to create a usable candidate
 * profile, per CAREER_OPS_HANDOFF.md's Phase 2.5 design record §C ("do not invent unnecessary
 * fields").
 */
export default function NewCandidatePage() {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!firstName.trim() || !lastName.trim()) {
      setError("First and last name are both required.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(typeof data.error === "string" ? data.error : "Failed to create candidate");
      }
      const { candidate } = await res.json();
      await fetch("/api/candidates/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: candidate.id }),
      });
      // The next page is reached by client-side navigation, so nothing clears the cached active id.
      // Seed it with the candidate we just created, or /master-files renders the previous one.
      primeActiveCandidateId(candidate.id);
      router.push("/master-files");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create candidate");
      setSaving(false);
    }
  }

  return (
    <div className="max-w-md">
      <h1 className="page-title">Add a candidate</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Companies/jobs stay shared — everything else (resume, skills, match results, pipeline,
        preferences) is isolated per candidate. After this, you&apos;ll upload their Master Resume
        and Master Skills Inventory.
      </p>

      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">First name</label>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-zinc-500">Last name</label>
          <input
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          />
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button
          disabled={saving}
          onClick={create}
          className="rounded bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {saving ? "Creating…" : "Create candidate"}
        </button>
      </div>
    </div>
  );
}
