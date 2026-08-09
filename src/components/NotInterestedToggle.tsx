"use client";

import { useState } from "react";

/**
 * Inline Not Interested action for Jobs list rows/cards — see AGENTS.md §19. Previously this
 * required opening the job detail page. Uses candidate_job_state exclusively (POST /api/jobs/[id]/
 * not-interested — see that route's own doc comment): reversible, never deletes the global job row,
 * never touches another candidate's state.
 */
export function NotInterestedToggle({
  jobId,
  jobTitle,
  candidateId,
  initialNotInterested,
  onChanged,
}: {
  jobId: number;
  jobTitle: string;
  candidateId: number;
  initialNotInterested: boolean;
  /** Called after a successful toggle with the new state — e.g. For You removes the row entirely
   *  (it would be filtered out on the next fetch anyway), All Jobs just re-renders the toggle. */
  onChanged?: (notInterested: boolean) => void;
}) {
  const [notInterested, setNotInterested] = useState(initialNotInterested);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !notInterested;
    if (next && !confirm(`Mark "${jobTitle}" as Not Interested? It stays visible to any other candidate profile.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/not-interested`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, notInterested: next }),
      });
      if (!res.ok) return;
      setNotInterested(next);
      onChanged?.(next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={toggle}
      title={notInterested ? "Undo Not Interested" : "Mark Not Interested"}
      className={`text-xs hover:underline disabled:opacity-50 ${
        notInterested ? "text-zinc-400" : "text-zinc-500 hover:text-red-600 dark:hover:text-red-400"
      }`}
    >
      {notInterested ? "Undo" : "Not interested"}
    </button>
  );
}
