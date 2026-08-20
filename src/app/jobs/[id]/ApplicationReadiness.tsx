"use client";

import type { JobMatchResult } from "@/lib/match/types";
import type { JobCertification, JobWithCompany } from "@/types";

/**
 * The five requirement families, each as one verdict — the narrow companion to the Tailoring Studio.
 *
 * There is deliberately NO overall readiness score. The engine publishes per-dimension verdicts and
 * nothing that means "78% ready", so a headline number would have to be invented by weighting
 * things the engine never weighted together. The brief forbade it and it would be the single most
 * misleading element on the page.
 *
 * Every verdict is READ, not recomputed:
 *   Skills         counts from the engine's own buckets
 *   Experience     dimensionScores.experience; null stays Unknown, never 0
 *   Education      requirement units with kind "education"
 *   Certifications requirement units with kind "certification", against the job's own list
 *   Sponsorship    eligibility.status — BLOCKED blocking, UNKNOWN advisory, unchanged semantics
 *
 * Unknown is never folded into Missing anywhere in this module.
 */

type V = "meets" | "review" | "missing" | "unknown";

const TEXT: Record<V, string> = {
  meets: "text-[var(--success)]",
  review: "text-[var(--warning)]",
  missing: "text-[var(--error)]",
  unknown: "text-tertiary",
};
const DOT: Record<V, string> = {
  meets: "bg-[var(--success)]",
  review: "bg-[var(--warning)]",
  missing: "bg-[var(--error)]",
  unknown: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};
const WORD: Record<V, string> = {
  meets: "Meets",
  review: "Review",
  missing: "Blocked",
  unknown: "Unknown",
};

export function ApplicationReadiness({
  job,
  result,
  certifications,
  onJump,
}: {
  job: JobWithCompany;
  result: JobMatchResult | null;
  certifications: JobCertification[];
  onJump: () => void;
}) {
  if (!result) {
    return (
      <section
        aria-label="Application readiness"
        className="tint-info rounded-[var(--radius-lg)] px-4 py-3.5 shadow-[inset_0_1px_0_var(--edge-hi),var(--lift-1)]"
      >
        <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Readiness</h3>
        <p className="mt-2 text-[12px] text-tertiary">Not evaluated — no verdicts yet.</p>
      </section>
    );
  }

  const has = (kind: string, bucket: "met" | "missing") =>
    (bucket === "met"
      ? [result.employerEvidencedMatches, result.inventoryOnlyMatches, result.transferableMatches]
      : [result.missingRequirements]
    ).some((l) => (l ?? []).some((m) => m.requirement.kind === kind));

  const strong = (result.employerEvidencedMatches ?? []).length;
  const partial = (result.inventoryOnlyMatches ?? []).length + (result.transferableMatches ?? []).length;
  const missing = (result.missingRequirements ?? []).length;
  const unknown = (result.unresolvedRequirements ?? []).length;

  const exp = result.dimensionScores?.experience ?? null;
  const elig = result.eligibility;

  const rows: { label: string; verdict: V; detail: string }[] = [
    {
      label: "Experience",
      verdict: job.experience_min_years === null ? "unknown" : exp === null ? "unknown" : exp >= 100 ? "meets" : "review",
      detail: job.experience_min_years === null ? "Not stated" : `${job.experience_min_years}+ yrs`,
    },
    {
      label: "Education",
      verdict: !job.education_level ? "unknown" : has("education", "met") ? "meets" : has("education", "missing") ? "review" : "unknown",
      detail: job.education_level ?? "Not stated",
    },
    {
      label: "Certifications",
      verdict: certifications.length === 0 ? "unknown" : has("certification", "met") ? "meets" : "review",
      detail: certifications.length === 0 ? "None required" : `${certifications.length} required`,
    },
    {
      label: "Sponsorship",
      verdict: elig?.status === "BLOCKED" ? "missing" : elig?.status === "PASS" ? "meets" : "unknown",
      detail: elig?.status === "BLOCKED" ? "Hard blocker" : elig?.status === "PASS" ? "No known blocker" : "Advisory only",
    },
  ];

  return (
    <section
      aria-label="Application readiness"
      className="tint-info rounded-[var(--radius-lg)] px-4 py-3.5 shadow-[inset_0_1px_0_var(--edge-hi),var(--lift-1)]"
    >
      <h3 className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Readiness</h3>

      {/* Skills first, as counts rather than a verdict — four buckets do not reduce to one word
       *  without discarding the distinction between "not found" and "unresolved". */}
      <button
        type="button"
        onClick={onJump}
        className="mt-2 flex w-full items-baseline gap-2 rounded px-1 py-1 text-left transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:scale-[0.99]"
      >
        <span className="w-[5.5rem] shrink-0 text-[11.5px] text-primary">Skills</span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 text-[11px]">
          <span className={strong > 0 ? "text-[var(--success)]" : "text-tertiary"}>
            <span className="font-semibold tabular-nums">{strong}</span> strong
          </span>
          <span className={partial > 0 ? "text-[var(--warning)]" : "text-tertiary"}>
            <span className="font-semibold tabular-nums">{partial}</span> partial
          </span>
          <span className="text-tertiary">
            <span className="font-semibold tabular-nums">{missing}</span> missing
          </span>
          {unknown > 0 && (
            <span className="text-tertiary">
              <span className="font-semibold tabular-nums">{unknown}</span> unknown
            </span>
          )}
        </span>
      </button>

      <div className="mt-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline gap-2 px-1 py-[5px]" title={r.detail}>
            <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${DOT[r.verdict]}`} />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-primary">{r.label}</span>
            {/* The verdict is a word. The dot repeats it; it never carries it alone. */}
            <span className={`shrink-0 text-[11px] font-medium ${TEXT[r.verdict]}`}>{WORD[r.verdict]}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
