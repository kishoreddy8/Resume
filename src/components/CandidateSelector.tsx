"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface CandidateOption {
  id: number;
  display_name: string;
}

/**
 * Phase 2.5: the candidate selector is a UX convenience only — switching here updates
 * settings.candidate_ui.active_candidate_id (see src/db/queries/candidates.ts), which every page's
 * useActiveCandidateId() hook reads as its default. It does NOT rescan shared companies/jobs — those
 * stay global; only which candidate's match results/preferences/job-state the UI shows changes.
 */
export function CandidateSelector() {
  const router = useRouter();
  const [candidates, setCandidates] = useState<CandidateOption[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    const [candidatesRes, activeRes] = await Promise.all([
      fetch("/api/candidates").then((r) => r.json()),
      fetch("/api/candidates/active").then((r) => r.json()),
    ]);
    setCandidates(candidatesRes.candidates ?? []);
    setActiveId(activeRes.candidateId ?? null);
    setLoading(false);
  }

  useEffect(() => {
    // Intentional: fetch-on-mount with a loading flag, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  async function handleChange(next: string) {
    if (next === "__new__") {
      router.push("/candidates/new");
      return;
    }
    const candidateId = Number(next);
    setActiveId(candidateId);
    await fetch("/api/candidates/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId }),
    });
    // Every page's useActiveCandidateId() only fetches once on mount — a full reload is the
    // simplest way to guarantee every open view re-reads the new active candidate consistently.
    window.location.reload();
  }

  if (loading) return null;

  return (
    <select
      value={activeId ?? ""}
      onChange={(e) => handleChange(e.target.value)}
      className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      title="Current candidate — switching does not rescan shared jobs/companies"
    >
      {candidates.map((c) => (
        <option key={c.id} value={c.id}>
          {c.display_name}
        </option>
      ))}
      <option value="__new__">+ Add candidate…</option>
    </select>
  );
}
