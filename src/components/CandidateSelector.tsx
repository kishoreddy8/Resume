"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { IconSettings } from "@/components/icons";

interface CandidateOption {
  id: number;
  display_name: string;
}

/**
 * Phase 2.5: the candidate selector is a UX convenience only — switching here updates
 * settings.candidate_ui.active_candidate_id (see src/db/queries/candidates.ts), which every page's
 * useActiveCandidateId() hook reads as its default. It does NOT rescan shared companies/jobs — those
 * stay global; only which candidate's match results/preferences/job-state the UI shows changes.
 *
 * PRESENTATION NOTE. It reads as an account block — avatar, name, preferences — because that is
 * what sits at the foot of a rail in a product a person uses to look for work. It is still one
 * native <select>: the control, its values, its handler and its destinations are unchanged, and no
 * status is invented beside the name. A "plan" or "tier" line would be decoration standing where a
 * fact should be, so the block carries the name and nothing else.
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

  const activeName = candidates.find((c) => c.id === activeId)?.display_name ?? "";
  const initials =
    activeName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";

  return (
    <div className="flex h-[52px] items-center gap-2.5 rounded-[12px] border border-[var(--border)] bg-[var(--z3-bg)] px-2.5">
      <span
        aria-hidden="true"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[12px] font-bold text-[var(--accent)]"
      >
        {initials}
      </span>
      <select
        value={activeId ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        className="min-w-0 flex-1 truncate rounded-md border-0 bg-transparent px-0 py-0.5 text-[13px] font-semibold text-primary transition-colors duration-150 ease-out focus:outline-none"
        /* The rail is a fixed 216px and a long name is ellipsised rather than widening it. The
         * full name stays reachable: the control is labelled with it, and the browser shows it. */
        aria-label={activeName ? `Active candidate: ${activeName}` : "Active candidate"}
        title={activeName || "Current candidate — switching does not rescan shared jobs/companies"}
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
          aria-label="Preferences (target roles, eligibility)"
          title="Preferences (target roles, eligibility)"
          className="shrink-0 rounded-md p-1 text-tertiary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary active:bg-[var(--surface-active)]"
        >
          <IconSettings size={15} />
        </Link>
      )}
    </div>
  );
}
