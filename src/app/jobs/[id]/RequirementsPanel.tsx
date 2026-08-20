"use client";

import type { JobMatchResult } from "@/lib/match/types";
import type { JobCertification, JobWithCompany } from "@/types";

/**
 * The non-skill requirements: experience, education, certifications, employment shape.
 *
 * Kept out of the skill matrix on purpose — they answer different questions and have different
 * evidence rules. Every value is read from a column or from the match result; none is computed here.
 *
 * The experience row is the one worth explaining. `job.experience_min_years` is the JD's stated
 * figure. The candidate side is NOT recomputed from employment dates — Career-Ops has its own rules
 * for what counts as stated experience, and re-deriving a number here would bypass them. What is
 * shown instead is the engine's own verdict, `dimensionScores.experience`, which is null whenever
 * the comparison could not be made deterministically. Null renders "Not comparable", never "0".
 */

type Verdict = "meets" | "review" | "unknown";

const VERDICT_TEXT: Record<Verdict, string> = {
  meets: "text-[var(--success)]",
  review: "text-[var(--warning)]",
  unknown: "text-tertiary",
};

function Row({
  label,
  jobSide,
  verdict,
  verdictLabel,
  note,
}: {
  label: string;
  jobSide: string;
  verdict: Verdict;
  verdictLabel: string;
  note?: string | null;
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-[var(--separator)] py-[7px] last:border-b-0">
      <span className="w-[7.5rem] shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-tertiary">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[12.5px] text-primary">
        {jobSide}
        {note && <span className="ml-1.5 text-[11px] text-tertiary">{note}</span>}
      </span>
      <span className={`shrink-0 text-[11.5px] font-medium ${VERDICT_TEXT[verdict]}`}>{verdictLabel}</span>
    </div>
  );
}

export function RequirementsPanel({
  job,
  result,
  certifications,
}: {
  job: JobWithCompany;
  result: JobMatchResult | null;
  certifications: JobCertification[];
}) {
  const rows: React.ReactNode[] = [];

  // --- Experience -----------------------------------------------------------------------------
  const jdYears = job.experience_min_years;
  const expScore = result?.dimensionScores?.experience ?? null;
  if (jdYears !== null && jdYears !== undefined) {
    rows.push(
      <Row
        key="exp"
        label="Experience"
        jobSide={`${jdYears}+ years`}
        verdict={expScore === null ? "unknown" : expScore >= 100 ? "meets" : "review"}
        verdictLabel={expScore === null ? "Not comparable" : expScore >= 100 ? "Meets" : "Review"}
        note={expScore === null ? "— engine could not compare deterministically" : null}
      />
    );
  } else {
    rows.push(
      <Row key="exp" label="Experience" jobSide="Not stated in this posting" verdict="unknown" verdictLabel="Unknown" />
    );
  }

  // --- Education ------------------------------------------------------------------------------
  const eduLevel = job.education_level;
  if (eduLevel) {
    const eduReq = job.education_requirement ?? "Unknown";
    // The match engine emits education as its own requirement unit kind, so its verdict is read
    // from the same buckets the skill matrix uses rather than re-decided here.
    const eduUnresolved = (result?.unresolvedRequirements ?? []).some((m) => m.requirement.kind === "education");
    const eduMissing = (result?.missingRequirements ?? []).some((m) => m.requirement.kind === "education");
    const eduMet =
      (result?.employerEvidencedMatches ?? []).some((m) => m.requirement.kind === "education") ||
      (result?.inventoryOnlyMatches ?? []).some((m) => m.requirement.kind === "education");
    rows.push(
      <Row
        key="edu"
        label="Education"
        jobSide={[eduLevel, job.education_field].filter(Boolean).join(" in ")}
        verdict={eduMet ? "meets" : eduMissing ? "review" : "unknown"}
        verdictLabel={eduMet ? "Meets" : eduMissing ? "Not found" : eduUnresolved ? "Unresolved" : "Unknown"}
        note={`${eduReq}${job.education_equivalent_experience_allowed === 1 ? " · equivalent experience allowed" : ""}`}
      />
    );
  }

  // --- Certifications -------------------------------------------------------------------------
  // Never inferred. A certification counts only when the engine matched it against candidate
  // evidence; anything else is stated as not found, and nothing is ever added by tailoring.
  for (const cert of certifications) {
    const met =
      (result?.employerEvidencedMatches ?? []).some(
        (m) => m.requirement.kind === "certification" && m.requirement.label === cert.name
      ) ||
      (result?.inventoryOnlyMatches ?? []).some(
        (m) => m.requirement.kind === "certification" && m.requirement.label === cert.name
      );
    rows.push(
      <Row
        key={`cert-${cert.name}`}
        label="Certification"
        jobSide={cert.name}
        verdict={met ? "meets" : result ? "review" : "unknown"}
        verdictLabel={met ? "Meets" : result ? "Not in your evidence" : "Unknown"}
        note={cert.requirement_level}
      />
    );
  }

  // --- Employment shape -----------------------------------------------------------------------
  const shape = [job.employment_type_normalized ?? job.employment_type, job.workplace_type_normalized ?? job.workplace_type]
    .filter(Boolean)
    .join(" · ");
  if (shape) {
    rows.push(<Row key="shape" label="Employment" jobSide={shape} verdict="unknown" verdictLabel="—" />);
  }

  if (rows.length === 0) {
    return <p className="text-[12px] text-tertiary">This posting records no structured requirements beyond skills.</p>;
  }

  return <div>{rows}</div>;
}
