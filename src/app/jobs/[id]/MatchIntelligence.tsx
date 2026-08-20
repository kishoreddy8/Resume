"use client";

import type { JobMatchResult } from "@/lib/match/types";
import { StatusDot } from "@/components/ui";

/**
 * WHY THIS MATCH — the engine's own verdict, reorganised into the three questions a person asks
 * before deciding to apply: what is strong, what is a concern, and what should I do.
 *
 * NOTHING IS CALCULATED HERE. Every line is a restatement of a field the match payload already
 * carries — dimension scores, the five requirement buckets, eligibility, and blockingReasons. No
 * new score, no weighting, no threshold of my own. The recommendation is `decision`, passed
 * through; it is never re-derived, because the decision is the one thing Stage 21's gates own.
 *
 * The distinction that shapes the layout: a CONCERN and an UNKNOWN are different, and both are
 * different from a failure. An unresolved requirement is something the engine could not read, and
 * it is listed separately from something the candidate genuinely lacks evidence for. Merging them
 * would tell the user they are weaker than the data says.
 */

const DECISION_COPY: Record<string, { label: string; body: string; tone: "ready" | "attention" | "blocked" }> = {
  READY_FOR_TAILORING: {
    label: "Proceed",
    body: "Cleared every gate. Approving tailoring is the next step.",
    tone: "ready",
  },
  NEEDS_REVIEW: {
    label: "Review",
    body: "Scored, but something below the bar. Read the concerns before approving anything.",
    tone: "attention",
  },
  BLOCKED: {
    label: "Blocked",
    body: "A hard blocker stands. Tailoring is not offered while it does.",
    tone: "blocked",
  },
};

/** One titled list. Hoisted to module scope — a component declared inside render is a new type on
 *  every pass, which resets state and defeats reconciliation. */
function Group({ title, tone, items }: { title: string; tone: "ready" | "attention" | "unknown"; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[9px] font-semibold uppercase tracking-[0.11em] text-tertiary">{title}</div>
      <ul className="mt-1.5 space-y-1">
        {items.map((text, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[12px] leading-relaxed text-secondary">
            <StatusDot tone={tone} className="translate-y-[-1px]" />
            <span className="min-w-0 flex-1">{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MatchIntelligence({ result }: { result: JobMatchResult }) {
  const d = result.dimensionScores;
  const employer = result.employerEvidencedMatches ?? [];
  const inventory = result.inventoryOnlyMatches ?? [];
  const transferable = result.transferableMatches ?? [];
  const missing = result.missingRequirements ?? [];
  const unresolved = result.unresolvedRequirements ?? [];
  const critical = result.criticalGaps ?? [];

  // --- Strengths: only claims the engine actually supports ------------------------------------
  const strengths: string[] = [];
  if (employer.length > 0) {
    const names = employer.slice(0, 3).map((m) => m.requirement.label);
    strengths.push(
      `${employer.length} requirement${employer.length === 1 ? "" : "s"} backed by employer-attributed evidence — ${names.join(", ")}${
        employer.length > names.length ? ` +${employer.length - names.length} more` : ""
      }`
    );
  }
  if (d?.roleAlignment !== null && d?.roleAlignment !== undefined && d.roleAlignment >= 75) {
    strengths.push(
      result.roleAlignmentDetail?.note ?? `Role alignment ${Math.round(d.roleAlignment)}% — this is the kind of role you have held`
    );
  }
  if (d?.experience !== null && d?.experience !== undefined && d.experience >= 100) {
    strengths.push("Experience requirement met");
  }
  if (d?.required !== null && d?.required !== undefined && d.required >= 75) {
    strengths.push(`Required-skill coverage ${Math.round(d.required)}%`);
  }

  // --- Concerns: things the engine says fall short --------------------------------------------
  const concerns: string[] = [...(result.blockingReasons ?? [])];
  if (critical.length > 0) {
    concerns.push(`${critical.length} critical gap${critical.length === 1 ? "" : "s"}: ${critical.map((m) => m.requirement.label).join(", ")}`);
  }
  if (missing.length > 0 && critical.length === 0) {
    const names = missing.slice(0, 3).map((m) => m.requirement.label);
    concerns.push(`No evidence found for ${names.join(", ")}${missing.length > names.length ? ` +${missing.length - names.length} more` : ""}`);
  }
  if (inventory.length > 0) {
    concerns.push(
      `${inventory.length} requirement${inventory.length === 1 ? "" : "s"} matched from your skills inventory only — no employer attribution`
    );
  }
  if (transferable.length > 0) {
    concerns.push(`${transferable.length} credited as transferable rather than a direct match`);
  }

  // --- Unknowns: separate from concerns, deliberately ------------------------------------------
  const unknowns: string[] = [];
  if (result.insufficientJdSignal) {
    unknowns.push("This posting yielded too few structured requirements to trust the score at all");
  }
  if (unresolved.length > 0) {
    unknowns.push(`${unresolved.length} requirement${unresolved.length === 1 ? "" : "s"} the engine could not resolve — not the same as you lacking them`);
  }
  if (result.eligibility?.status === "UNKNOWN") {
    unknowns.push(result.eligibility.sponsorship?.note ?? "Sponsorship signal unknown — advisory, not a blocker");
  }
  if (d?.seniority === null) unknowns.push("Seniority not stated in this posting");

  const decision = DECISION_COPY[result.decision] ?? {
    label: "Unknown",
    body: "No decision recorded for this evaluation.",
    tone: "attention" as const,
  };

  return (
    <div className="space-y-3.5">
      <Group title="Strong alignment" tone="ready" items={strengths} />
      <Group title="Concerns" tone="attention" items={concerns} />
      <Group title="Unknown" tone="unknown" items={unknowns} />

      {strengths.length === 0 && concerns.length === 0 && unknowns.length === 0 && (
        <p className="text-[12px] text-tertiary">
          This evaluation produced no structured signal to summarise.
        </p>
      )}

      {/* The recommendation IS the engine's decision, restated — never recomputed here. */}
      <div className="flex items-baseline gap-2.5 border-t border-[var(--separator)] pt-3">
        <StatusDot tone={decision.tone} className="translate-y-[-1px]" />
        <div className="min-w-0">
          <span className="text-[12.5px] font-semibold text-primary">{decision.label}</span>
          <span className="ml-2 text-[11.5px] leading-relaxed text-tertiary">{decision.body}</span>
        </div>
      </div>
    </div>
  );
}
