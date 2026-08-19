"use client";

import Link from "next/link";
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

  // Stage 1 restyle only: this lives in the shell's sidebar account area now, so
  // the control stacks instead of sitting in a header row. Every value, handler
  // and destination below is unchanged.
  return (
    <div className="flex flex-row items-center gap-2 lg:flex-col lg:items-stretch lg:gap-1.5">
      <select
        value={activeId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-surface px-2 py-1.5 text-[13px] text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] lg:w-full lg:flex-none"
        title="Current candidate — switching does not rescan shared jobs/companies"
      >
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.display_name}
          </option>
        ))}
        <option value="__new__">+ Add candidate…</option>
      </select>
      {activeId && (
        <Link
          href={`/candidates/${activeId}/settings`}
          title="Preferences (target roles, eligibility)"
          className="shrink-0 rounded-md px-2.5 py-1 text-[12px] text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:bg-[var(--surface-active)]"
        >
          Preferences
        </Link>
      )}
    </div>
  );
}
