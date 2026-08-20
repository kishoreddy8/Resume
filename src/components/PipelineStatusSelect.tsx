"use client";

import { useState } from "react";
import type { PipelineStatus } from "@/types";

const STATUSES: PipelineStatus[] = [
  "New",
  "Interested",
  "Applied",
  "Interviewing",
  "Offer",
  "Employer Rejected",
];

export function PipelineStatusSelect({
  jobId,
  value,
  candidateId,
  onChanged,
}: {
  jobId: number;
  value: PipelineStatus;
  candidateId: number;
  onChanged?: (status: PipelineStatus) => void;
}) {
  const [status, setStatus] = useState(value);
  const [saving, setSaving] = useState(false);

  async function handleChange(next: PipelineStatus) {
    const prev = status;
    setStatus(next);
    setSaving(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId, pipelineStatus: next }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      onChanged?.(next);
    } catch {
      setStatus(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <select
      value={status}
      disabled={saving}
      onChange={(e) => handleChange(e.target.value as PipelineStatus)}
      className="rounded-md border border-[var(--border)] bg-surface px-2 py-1 text-[11.5px] text-primary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] disabled:opacity-50"
    >
      {STATUSES.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </select>
  );
}
