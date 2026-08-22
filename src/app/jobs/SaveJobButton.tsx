"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";

export function SaveJobButton({
  jobId,
  jobTitle,
  candidateId,
  initialSaved,
  onSavedChange,
  className = "",
}: {
  jobId: number;
  jobTitle: string;
  candidateId: number;
  initialSaved: boolean;
  onSavedChange?: (jobId: number, saved: boolean) => void;
  className?: string;
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [saving, setSaving] = useState(false);
  const reduced = useReducedMotion() ?? false;

  async function toggle() {
    if (saving) return;
    const previous = saved;
    const next = !previous;
    setSaved(next);
    setSaving(true);
    onSavedChange?.(jobId, next);
    try {
      const response = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, pinned: next }),
      });
      if (!response.ok) throw new Error("Could not update saved job");
    } catch {
      setSaved(previous);
      onSavedChange?.(jobId, previous);
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.button
      type="button"
      aria-label={saved ? "Remove saved job" : "Save job"}
      title={saved ? `Remove ${jobTitle} from saved jobs` : `Save ${jobTitle}`}
      aria-pressed={saved}
      disabled={saving}
      onClick={(event) => {
        event.stopPropagation();
        void toggle();
      }}
      animate={reduced ? undefined : { scale: saved ? [1, 1.16, 1] : 1 }}
      transition={{ duration: reduced ? 0 : 0.16 }}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:opacity-60 ${
        saved ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-tertiary hover:bg-[var(--surface-hover)] hover:text-primary"
      } ${className}`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5">
        <path
          d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.5a5.5 5.5 0 0 0 0-7.8Z"
          fill={saved ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </motion.button>
  );
}
