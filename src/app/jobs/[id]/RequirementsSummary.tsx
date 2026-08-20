"use client";

import type { JobMatchResult } from "@/lib/match/types";
import type { JobCertification, JobWithCompany } from "@/types";

/**
 * The five requirement families at a glance, each reduced to one verdict.
 *
 * Every verdict is READ from a deterministic source — none is recomputed here:
 *   Skills         the match engine's own buckets (missing/unresolved vs evidenced)
 *   Experience     dimensionScores.experience; null stays "Unknown", never "0"
 *   Education      requirement units with kind "education"
 *   Certification  requirement units with kind "certification", against the job's own list
 *   Sponsorship    eligibility.status — BLOCKED stays blocking, UNKNOWN stays advisory
 *
 * A row is a line, not a tile. Clicking jumps to the detailed Requirements section rather than
 * expanding a second copy of it here.
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

export function RequirementsSummary({
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
    return <p className="text-[12px] text-tertiary">Not evaluated — no requirement verdicts yet.</p>;
  }

  const has = (kind: string, bucket: "met" | "missing" | "unresolved") => {
    const lists =
      bucket === "met"
        ? [result.employerEvidencedMatches, result.inventoryOnlyMatches, result.transferableMatches]
        : bucket === "missing"
          ? [result.missingRequirements]
          : [result.unresolvedRequirements];
    return lists.some((l) => (l ?? []).some((m) => m.requirement.kind === kind));
  };

  const skillMissing = (result.missingRequirements ?? []).filter(
    (m) => m.requirement.kind === "skill" || m.requirement.kind === "skill_group"
  ).length;
  const skillUnknown = (result.unresolvedRequirements ?? []).length;
  const skillMet =
    (result.employerEvidencedMatches ?? []).length + (result.inventoryOnlyMatches ?? []).length + (result.transferableMatches ?? []).length;

  const exp = result.dimensionScores?.experience ?? null;
  const eligibility = result.eligibility;

  const rows: { label: string; verdict: V; detail: string }[] = [
    {
      label: "Skills",
      verdict: skillMissing > 0 ? "review" : skillUnknown > 0 ? "unknown" : skillMet > 0 ? "meets" : "unknown",
      detail:
        skillMissing > 0
          ? `${skillMissing} not found`
          : skillUnknown > 0
            ? `${skillUnknown} unresolved`
            : skillMet > 0
              ? `${skillMet} evidenced`
              : "No structured requirements",
    },
    {
      label: "Experience",
      verdict: job.experience_min_years === null ? "unknown" : exp === null ? "unknown" : exp >= 100 ? "meets" : "review",
      detail:
        job.experience_min_years === null
          ? "Not stated"
          : exp === null
            ? `${job.experience_min_years}+ years — not comparable`
            : `${job.experience_min_years}+ years`,
    },
    {
      label: "Education",
      verdict: !job.education_level ? "unknown" : has("education", "met") ? "meets" : has("education", "missing") ? "review" : "unknown",
      detail: job.education_level ? [job.education_level, job.education_field].filter(Boolean).join(" in ") : "Not stated",
    },
    {
      label: "Certifications",
      verdict:
        certifications.length === 0 ? "unknown" : has("certification", "met") ? "meets" : "review",
      detail:
        certifications.length === 0
          ? "None required"
          : `${certifications.length} required${has("certification", "met") ? "" : " — not in your evidence"}`,
    },
    {
      label: "Sponsorship",
      verdict:
        eligibility?.status === "BLOCKED" ? "missing" : eligibility?.status === "PASS" ? "meets" : "unknown",
      detail:
        eligibility?.status === "BLOCKED"
          ? "Blocked"
          : eligibility?.status === "PASS"
            ? "No known hard blocker"
            : "Unknown — advisory, not a blocker",
    },
  ];

  return (
    <div>
      {rows.map((r) => (
        <button
          key={r.label}
          type="button"
          onClick={onJump}
          className="flex w-full items-baseline gap-3 rounded border-b border-[var(--separator)] px-1 py-[6px] text-left transition-colors duration-150 ease-out last:border-b-0 hover:bg-[var(--surface-hover)] active:scale-[0.995]"
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full ${DOT[r.verdict]}`} />
          <span className="w-[6.5rem] shrink-0 text-[11.5px] text-primary">{r.label}</span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-tertiary">{r.detail}</span>
          <span className={`shrink-0 text-[11px] font-medium capitalize ${TEXT[r.verdict]}`}>{r.verdict}</span>
        </button>
      ))}
    </div>
  );
}
