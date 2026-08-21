"use client";

import type { ReactNode } from "react";
import type { JobWithCompany } from "@/types";
import { combineH1bConfidence } from "@/lib/h1b/combineSignal";
import type { QualityWorkflowData } from "./useQualityWorkflow";
import { FactRow, StepSectionHeading, WsCard } from "./WorkspaceUI";

/**
 * Step 5 — Application, before a run exists: four columns read across.
 *
 * THE CHECKLIST REPORTS, IT DOES NOT PROMISE. Every row reads real state: the resume line follows
 * the validator's own readiness (not the review score — see ValidationStep for why those differ),
 * and every row after "start" is "Not started", because nothing has happened yet. There is no
 * progress bar and no row that reads complete on the strength of something adjacent being complete.
 *
 * NOTHING ON THIS SCREEN CAN SEND ANYTHING. Starting is one guarded button, the server refuses a
 * start it cannot support, and submission needs its own separate approval on the run itself.
 */

type RowState = "ready" | "blocked" | "not-started" | "unknown";

const STATE_WORD: Record<RowState, string> = {
  ready: "Ready",
  blocked: "Blocked",
  "not-started": "Not started",
  unknown: "Unknown",
};

const STATE_TONE: Record<RowState, string> = {
  ready: "text-[var(--pill-success-fg)]",
  blocked: "text-[var(--error)]",
  "not-started": "text-tertiary",
  unknown: "text-tertiary",
};

function CheckRow({ label, state }: { label: string; state: RowState }) {
  return (
    <li className="flex items-center justify-between gap-2 py-[6px]">
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            state === "ready"
              ? "bg-[var(--pill-success-fg)]"
              : state === "blocked"
                ? "bg-[var(--error)]"
                : "bg-[var(--border-control)]"
          }`}
        />
        <span className="truncate text-[12.5px] text-primary">{label}</span>
      </span>
      {/* The word is always present; the dot repeats it and never replaces it. */}
      <span className={`shrink-0 text-[11px] font-medium ${STATE_TONE[state]}`}>{STATE_WORD[state]}</span>
    </li>
  );
}

/** The board a person could recognise. `built_in` is an internal seed marker, not a place. */
function sourceLabel(source: string | null): string | null {
  if (!source || source === "built_in") return null;
  return source.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function ApplicationReadyStep({
  job,
  quality,
  startControl,
}: {
  job: JobWithCompany;
  /** Null until Validation has been opened — the resume row then reads "Unknown", not "Ready". */
  quality: QualityWorkflowData | null;
  startControl: ReactNode;
}) {
  const h1b = combineH1bConfidence(job.company_h1b_confidence, job.sponsorship_polarity);
  const ats = sourceLabel(job.source_type);
  const domain = domainOf(job.url);

  /* The resume row follows readiness, which is the authority on whether a package may be sent. */
  const resumeState: RowState = !quality?.readiness
    ? "unknown"
    : quality.readiness.readiness === "READY" && quality.readiness.humanMaySend
      ? "ready"
      : quality.readiness.readiness === "BLOCKED"
        ? "blocked"
        : "unknown";

  return (
    <div>
      <StepSectionHeading
        title="Application"
        blurb="What this application will need from you. Nothing starts until you press the button."
      />

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {/* 1 — overview */}
        <WsCard title="Application overview">
          <ul className="divide-y divide-[#F2F3F7] dark:divide-[var(--separator)]">
            <CheckRow label="Tailored resume" state={resumeState} />
            <CheckRow label="Application form" state="not-started" />
            <CheckRow label="Screening questions" state="not-started" />
            <CheckRow label="Review & confirm" state="not-started" />
            <CheckRow label="Submit" state="not-started" />
          </ul>
          {resumeState === "blocked" && quality?.readiness?.blockingReasons[0] && (
            <p className="mt-2.5 border-t border-[#F2F3F7] pt-2.5 text-[11px] leading-relaxed text-[var(--error)] dark:border-[var(--separator)]">
              {quality.readiness.blockingReasons[0]}
            </p>
          )}
          {resumeState === "unknown" && (
            <p className="mt-2.5 border-t border-[#F2F3F7] pt-2.5 text-[11px] leading-relaxed text-tertiary dark:border-[var(--separator)]">
              Open Validation to see where the resume stands.
            </p>
          )}
        </WsCard>

        {/* 2 — info. Only fields this posting actually carries. */}
        <WsCard title="Application info">
          <ul className="divide-y divide-[#F2F3F7] dark:divide-[var(--separator)]">
            {ats && <FactRow label="Platform" value={ats} />}
            {domain && <FactRow label="Applies at" value={domain} />}
            {job.workplace_type && <FactRow label="Work mode" value={job.workplace_type} />}
            {job.employment_type && <FactRow label="Employment" value={job.employment_type} />}
            {job.location && <FactRow label="Location" value={job.location} />}
            <FactRow
              label="Sponsorship"
              value={
                h1b.confidence === "Not Sponsoring"
                  ? "Not stated"
                  : h1b.confidence === "Unknown"
                    ? "Unknown"
                    : h1b.confidence
              }
            />
          </ul>
        </WsCard>

        {/* 3 — next steps: the controlled workflow, not a progress claim */}
        <WsCard title="Next steps">
          <ol className="flex flex-col">
            {[
              "Start the application",
              "JobHunt fills what your evidence supports",
              "Answer anything it cannot evidence",
              "Review the exact values to be sent",
              "Approve & submit",
            ].map((s, i) => (
              <li key={s} className="flex items-start gap-2 py-[5px]">
                <span
                  aria-hidden="true"
                  className="mt-px grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full bg-[var(--accent-tint)] text-[10px] font-bold text-[var(--accent)]"
                >
                  {i + 1}
                </span>
                <span className="text-[12.5px] leading-relaxed text-secondary">{s}</span>
              </li>
            ))}
          </ol>
        </WsCard>

        {/* 4 — what is actually guaranteed */}
        <WsCard tone="warm" title="Before you start">
          <ul className="flex flex-col gap-2">
            <li className="text-[12.5px] leading-relaxed text-secondary">
              <span className="font-semibold text-primary">Nothing is submitted until you approve it.</span> The
              final review shows the exact values first, and that approval covers this application only.
            </li>
            <li className="text-[12.5px] leading-relaxed text-secondary">
              If the employer asks something your evidence cannot answer, JobHunt stops and asks you.
            </li>
            <li className="text-[12.5px] leading-relaxed text-secondary">
              A CAPTCHA or verification step pauses the run so you can complete it yourself.
            </li>
          </ul>
          <div className="mt-3 border-t border-[#F0E6D2] pt-3 dark:border-[var(--separator)]">{startControl}</div>
        </WsCard>
      </div>
    </div>
  );
}
