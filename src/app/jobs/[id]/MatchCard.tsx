"use client";

import type { JobMatchResult } from "@/lib/match/types";
import { Disclosure } from "./Disclosure";
import type { JobMatch } from "./useJobMatch";

/**
 * Phase 2 — deterministic Job Match / Eligibility / Readiness. Unlike AiInsightsCard, no AI is
 * involved anywhere in this card: it renders job_skills/eligibility facts scored against the
 * candidate profile, showing more than a percentage — requirement coverage, all four evidence-
 * strength buckets kept visually distinct, critical gaps called out first, and the recommended
 * track. It never shows a bare score.
 *
 * STAGE 24B. Evaluation is automatic (src/lib/match/tick.ts): a job normally already has a result
 * by the time this mounts, and Evaluate/Re-evaluate is an explicit refresh/recovery action, not the
 * normal workflow. The card states plainly that an insufficient-signal score is an unknown rather
 * than a low match.
 *
 * STAGE 2 (UI). Two changes, both presentational:
 *
 *  - The request logic moved to useJobMatch so the decision header and this section render from one
 *    result; this component is now purely presentational and mutates nothing except by calling the
 *    `evaluate` action the user pressed.
 *  - The verdict, the insufficient-signal warning, the eligibility block and the blocking reasons
 *    are no longer drawn here because JobDecisionHeader now renders them, verbatim, at the top of
 *    the page where they are read first. They were promoted, not dropped. The Overall Score row
 *    below deliberately stays, caveat and all, so the number is never absent from the page even
 *    when the header withholds it as untrustworthy.
 */

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function RequirementList({
  title,
  items,
  tone,
}: {
  title: string;
  items: JobMatchResult["missingRequirements"] | undefined;
  tone: string;
}) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h4 className={`mb-1 text-xs font-semibold ${tone}`}>
        {title} ({items.length})
      </h4>
      <ul className="space-y-1 text-xs text-secondary">
        {items.map((m, i) => (
          <li key={i}>
            {m.requirement.label}
            {m.transferable && (
              <span className="text-tertiary">
                {" "}
                — via {m.transferable.fromRawSkillName} ({m.transferable.reason})
              </span>
            )}
            {m.evidence?.employers && m.evidence.employers.length > 0 && (
              <span className="text-tertiary"> — {m.evidence.employers.join(", ")}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-tertiary">{label}</div>
      <div className="text-[13px] font-medium tabular-nums text-primary">{value}</div>
    </div>
  );
}

export function MatchCard({ match }: { match: JobMatch }) {
  const { result, state, reason, evaluate } = match;

  const secondaryLists =
    result !== null &&
    ((result.inventoryOnlyMatches ?? []).length > 0 ||
      (result.transferableMatches ?? []).length > 0 ||
      (result.unresolvedRequirements ?? []).length > 0 ||
      (result.unrecognizedCandidateSkills ?? []).length > 0);

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface p-5">
      <h2 className="section-title">Match evidence</h2>
      <p className="mt-0.5 mb-4 text-[12px] text-tertiary">
        Deterministic — no AI involved. Computed from job_skills/eligibility facts and your candidate
        profile only.
      </p>

      {state === "loading" && <p className="text-[13px] text-tertiary">Loading…</p>}

      {state === "none" && (
        <div>
          <p className="mb-2 text-[13px] text-tertiary">Not yet evaluated.</p>
          <button
            type="button"
            onClick={evaluate}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
          >
            Evaluate Match
          </button>
        </div>
      )}

      {state === "unavailable" && (
        <div>
          <p className="text-[13px] text-secondary">
            {reason === "missing_candidate_profile"
              ? "Candidate profile not found — run the build-candidate-profile skill first."
              : reason === "stale_candidate_profile"
                ? "Candidate profile is out of date relative to the current Master Resume/Skills Inventory upload — rebuild it via the build-candidate-profile skill."
                : "Match evaluation unavailable."}
          </p>
          <button
            type="button"
            onClick={evaluate}
            className="mt-2 rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
          >
            Try again
          </button>
        </div>
      )}

      {state === "error" && <p className="text-[13px] text-[var(--error)]">Failed to load match status.</p>}

      {state === "ok" && result && (
        <div className="space-y-4">
          <div>
            <div className="text-[11px] text-tertiary">
              Overall Score
              {result.insufficientJdSignal && (
                <span className="ml-1 text-[var(--warning)]">(not reliable — insufficient data)</span>
              )}
            </div>
            <div className="text-[20px] font-semibold tabular-nums leading-tight text-primary">
              {typeof result.overallScore === "number" ? Math.round(result.overallScore) : "—"}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Metric label="Role Alignment" value={pct(result.dimensionScores?.roleAlignment ?? null)} />
            <Metric label="Required" value={pct(result.dimensionScores?.required ?? null)} />
            <Metric label="Preferred" value={pct(result.dimensionScores?.preferred ?? null)} />
            <Metric label="Experience" value={pct(result.dimensionScores?.experience ?? null)} />
            <Metric label="Seniority" value={pct(result.dimensionScores?.seniority ?? null)} />
          </div>

          {result.roleAlignmentDetail && (
            <p className="text-xs text-secondary">
              <span className="text-tertiary">Role alignment: </span>
              {result.roleAlignmentDetail.note}
            </p>
          )}

          <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--separator)] pt-3 text-xs">
            <span className="text-tertiary">
              Requirement Coverage{" "}
              <span className="font-medium tabular-nums text-primary">
                {typeof result.requirementCoverage === "number"
                  ? Math.round(result.requirementCoverage * 100)
                  : "—"}
                %
              </span>
            </span>
            <span className="text-tertiary">
              Employer-Evidenced Share{" "}
              <span className="font-medium tabular-nums text-primary">
                {typeof result.employerEvidencedShare === "number"
                  ? Math.round(result.employerEvidencedShare * 100)
                  : "—"}
                %
              </span>
            </span>
            <span className="text-tertiary">
              Recommended Track <span className="font-medium text-primary">{result.recommendedTrack ?? "Unknown"}</span>
            </span>
          </div>

          {/* Defensive: every field below normalizes with `?? []`/`?.` even though the API is now
              expected to always populate them (see deserializeJobMatchResult) — this component must
              never crash on an old cached result, a manually-inserted row, or a future schema gap. */}
          <div className="space-y-3 border-t border-[var(--separator)] pt-3">
            {(result.criticalGaps ?? []).length > 0 && (
              <RequirementList title="Critical Gaps" items={result.criticalGaps} tone="text-[var(--error)]" />
            )}
            <RequirementList
              title="Employer-Evidenced Matches"
              items={result.employerEvidencedMatches}
              tone="text-[var(--success)]"
            />
            <RequirementList title="Missing Requirements" items={result.missingRequirements} tone="text-secondary" />
          </div>

          {/* Supporting breakdown only. Gaps and employer-evidenced strengths stay above, always
           *  visible — nothing that bears on the decision is hidden behind this. */}
          {secondaryLists && (
            <div className="border-t border-[var(--separator)] pt-3">
              <Disclosure title="Full requirement breakdown">
                <div className="space-y-3">
                  <RequirementList
                    title="Inventory-Only Matches"
                    items={result.inventoryOnlyMatches}
                    tone="text-secondary"
                  />
                  <RequirementList
                    title="Transferable Matches"
                    items={result.transferableMatches}
                    tone="text-[var(--warning)]"
                  />
                  <RequirementList
                    title="Unresolved Requirements"
                    items={result.unresolvedRequirements}
                    tone="text-secondary"
                  />
                  {(result.unrecognizedCandidateSkills ?? []).length > 0 && (
                    <p className="text-xs text-tertiary">
                      Not yet recognized by the skill taxonomy:{" "}
                      {result.unrecognizedCandidateSkills.join(", ")}
                    </p>
                  )}
                </div>
              </Disclosure>
            </div>
          )}

          <button
            type="button"
            onClick={evaluate}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs font-medium transition-colors duration-150 ease-out hover:bg-[var(--surface-hover)] active:bg-[var(--surface-active)]"
          >
            Re-evaluate
          </button>
        </div>
      )}
    </section>
  );
}
