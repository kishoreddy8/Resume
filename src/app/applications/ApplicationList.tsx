"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Surface } from "@/components/ui";
import type { ApplicationRecord } from "@/lib/applications/nextAction";

/**
 * The applications this candidate has actually acted on.
 *
 * BOUNDED BY WHAT IT ASKS FOR. The source is candidate_job_state, which only gains a row when the
 * user does something to a job. A candidate with 150,000 evaluated jobs has a handful of rows here.
 * That is deliberate: the board this sits beside once fetched every active job — 16,005 of them,
 * 25 MB, 208,189 DOM nodes — because it asked the wrong question. Filtering a huge list is not the
 * fix; not asking for it is.
 *
 * HISTORY IS PER-APPLICATION AND LAZY. Change logs load only when a row is expanded. Fetching them
 * for the whole list to render a collapsed summary would repeat the same mistake in miniature.
 *
 * EVERY TIMELINE ENTRY IS RECORDED. Nothing is synthesised to fill a gap, and an application with
 * no history shows none rather than an invented "Discovered" event.
 */

interface HistoryRow {
  id: number;
  change_type: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  changed_at: string;
}

const STAGE_TONE: Record<string, string> = {
  New: "text-tertiary",
  Interested: "text-[var(--accent)]",
  Applied: "text-[var(--success)]",
  Interviewing: "text-[var(--success)]",
  Offer: "text-[var(--success)]",
  "Employer Rejected": "text-tertiary",
};

function History({ candidateId, dedupeKey }: { candidateId: number; dedupeKey: string }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/candidates/${candidateId}/applications?dedupeKey=${encodeURIComponent(dedupeKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (!body) return setState("error");
        setRows(body.history ?? []);
        setState("ready");
      })
      .catch(() => !cancelled && setState("error"));
    return () => {
      cancelled = true;
    };
  }, [candidateId, dedupeKey]);

  if (state === "loading") return <p className="mt-2 text-[11.5px] text-tertiary">Loading history…</p>;
  if (state === "error") return <p className="mt-2 text-[11.5px] text-tertiary">History could not be loaded.</p>;
  if (!rows || rows.length === 0)
    return <p className="mt-2 text-[11.5px] text-tertiary">No changes recorded for this application yet.</p>;

  return (
    <ol className="mt-2 space-y-1.5">
      {rows.map((h) => (
        <li key={h.id} className="flex gap-2.5 text-[11.5px] leading-relaxed">
          <span className="shrink-0 tabular-nums text-tertiary">
            {new Date(h.changed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
          <span className="text-secondary">
            {h.change_type.replace(/_/g, " ")}
            {h.old_value || h.new_value ? (
              <span className="text-tertiary">
                {" "}
                {h.old_value ?? "—"} → {h.new_value ?? "—"}
              </span>
            ) : null}
            {h.reason && <span className="text-tertiary"> · {h.reason}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ApplicationList({ candidateId }: { candidateId: number }) {
  const [apps, setApps] = useState<ApplicationRecord[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/candidates/${candidateId}/applications`);
      if (!res.ok) return setState("error");
      const body = await res.json();
      setApps(body.applications ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [candidateId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (state === "loading")
    return (
      <p role="status" className="text-[12.5px] text-tertiary">
        Loading applications…
      </p>
    );
  if (state === "error") return <p className="text-[12.5px] text-tertiary">Applications could not be loaded.</p>;
  if (!apps || apps.length === 0)
    return (
      <p className="text-[12.5px] leading-relaxed text-tertiary">
        Nothing yet. An application appears here once you set a stage, approve tailoring, or write a
        note on a job — this list only ever holds jobs you have actually acted on.
      </p>
    );

  return (
    <ul className="flex flex-col gap-2">
      {apps.map((a) => {
        const expanded = open === a.dedupeKey;
        return (
          <li key={a.dedupeKey}>
            <Surface level="z2" className="rounded-[var(--radius-lg)] px-3.5 py-3">
              <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <Link
                  href={`/jobs/${a.jobId}`}
                  className="text-[13px] font-medium text-primary underline-offset-2 hover:underline"
                >
                  {a.title}
                </Link>
                {a.company && <span className="text-[12px] text-tertiary">{a.company}</span>}
                {/* Stage is a WORD first — the colour only reinforces it. */}
                <span className={`ml-auto text-[11.5px] font-medium ${STAGE_TONE[a.stage] ?? "text-secondary"}`}>
                  {a.stage}
                </span>
              </div>

              <p className="mt-1 text-[11.5px] leading-relaxed text-secondary">{a.nextAction}</p>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-tertiary">
                {a.generatedFileCount > 0 ? (
                  <span>
                    {a.generatedFileCount} generated document{a.generatedFileCount === 1 ? "" : "s"}
                  </span>
                ) : (
                  <span>No documents generated</span>
                )}
                {a.markedForTailoring && <span>Tailoring approved</span>}
                {a.pinned && <span>Pinned</span>}
                {a.stageUpdatedAt && (
                  <span className="tabular-nums">
                    Updated {new Date(a.stageUpdatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : a.dedupeKey)}
                  aria-expanded={expanded}
                  className="ml-auto inline-flex min-h-[30px] items-center rounded-[8px] px-2 text-[12px] font-medium text-secondary transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] hover:text-primary"
                >
                  {expanded ? "Hide history" : "History"}
                </button>
              </div>

              {a.notes && (
                <p className="mt-1.5 border-l-2 border-[var(--separator)] pl-2.5 text-[11.5px] leading-relaxed text-tertiary">
                  {a.notes}
                </p>
              )}

              {expanded && <History candidateId={candidateId} dedupeKey={a.dedupeKey} />}
            </Surface>
          </li>
        );
      })}
    </ul>
  );
}
