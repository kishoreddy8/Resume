"use client";

import { useEffect, useState } from "react";
import { MatchDecisionBadge, type MatchDecision } from "@/components/MatchDecisionBadge";
import type { JobMatchResult } from "@/lib/match/types";
import { useActiveCandidateId } from "@/lib/useActiveCandidateId";

/**
 * Phase 2 — deterministic Job Match / Eligibility / Readiness. Unlike AiInsightsCard, this fetches
 * on mount (GET, cheap/deterministic/zero-cost — no AI involved anywhere in this card) and offers
 * an explicit "Evaluate Match" button (POST) to compute/refresh. Shows more than a percentage —
 * eligibility with its own caveat text, requirement coverage, all four evidence-strength buckets
 * kept visually distinct, critical gaps called out first, recommended track, and the decision plus
 * every blocking reason, never a bare score.
 */

type GetResponse = { status: "none" } | { status: "ok"; result: JobMatchResult } | { error: string };
type PostResponse = { status: "unavailable"; reason: string } | { status: "ok"; cached: boolean; result: JobMatchResult } | { error: string };

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

function RequirementList({ title, items, tone }: { title: string; items: JobMatchResult["missingRequirements"] | undefined; tone: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div>
      <h4 className={`mb-1 text-xs font-semibold ${tone}`}>
        {title} ({items.length})
      </h4>
      <ul className="space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
        {items.map((m, i) => (
          <li key={i}>
            {m.requirement.label}
            {m.transferable && <span className="text-zinc-500"> — via {m.transferable.fromRawSkillName} ({m.transferable.reason})</span>}
            {m.evidence?.employers && m.evidence.employers.length > 0 && (
              <span className="text-zinc-500"> — {m.evidence.employers.join(", ")}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MatchCard({ jobId }: { jobId: number }) {
  const candidateId = useActiveCandidateId();
  const [result, setResult] = useState<JobMatchResult | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ok" | "none" | "unavailable" | "error">("idle");
  const [reason, setReason] = useState<string | null>(null);

  async function loadLatest() {
    setState("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/match?candidateId=${candidateId}`);
      const body = (await res.json().catch(() => null)) as GetResponse | null;
      if (!res.ok || !body || "error" in body) {
        setState("error");
        return;
      }
      if (body.status === "none") {
        setState("none");
        return;
      }
      setResult(body.result);
      setState("ok");
    } catch {
      setState("error");
    }
  }

  useEffect(() => {
    // Intentional: cheap deterministic GET on mount, unlike AiInsightsCard's strictly on-demand
    // pattern — there is no cost/latency reason to gate this behind a click.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLatest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, candidateId]);

  async function evaluate() {
    setState("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const body = (await res.json().catch(() => null)) as PostResponse | null;
      if (!res.ok || !body || "error" in body) {
        setState("error");
        return;
      }
      if (body.status === "unavailable") {
        setReason(body.reason);
        setState("unavailable");
        return;
      }
      setResult(body.result);
      setState("ok");
    } catch {
      setState("error");
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Match &amp; Eligibility</h2>
        {result && <MatchDecisionBadge decision={result.decision as MatchDecision} />}
      </div>
      <p className="mb-3 text-xs text-zinc-500">
        Deterministic — no AI involved. Computed from job_skills/eligibility facts and your candidate
        profile only.
      </p>

      {state === "loading" && <p className="text-sm text-zinc-500">Loading…</p>}

      {state === "none" && (
        <div>
          <p className="mb-2 text-sm text-zinc-500">Not yet evaluated.</p>
          <button
            type="button"
            onClick={evaluate}
            className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Evaluate Match
          </button>
        </div>
      )}

      {state === "unavailable" && (
        <div>
          <p className="text-sm text-zinc-500">
            {reason === "missing_candidate_profile"
              ? "Candidate profile not found — run the build-candidate-profile skill first."
              : reason === "stale_candidate_profile"
                ? "Candidate profile is out of date relative to the current Master Resume/Skills Inventory upload — rebuild it via the build-candidate-profile skill."
                : "Match evaluation unavailable."}
          </p>
          <button
            type="button"
            onClick={evaluate}
            className="mt-2 rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Try again
          </button>
        </div>
      )}

      {state === "error" && <p className="text-sm text-red-600">Failed to load match status.</p>}

      {state === "ok" && result && (
        <div className="space-y-3">
          {result.insufficientJdSignal && (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
              Evaluated with insufficient structured JD data — the score below reflects near-zero
              signal, not a genuine negative match. Re-run Evaluate Match after the job has real
              extracted requirements.
            </div>
          )}
          <div>
            <div className="text-xs font-medium text-zinc-500">
              Overall Score{result.insufficientJdSignal && <span className="ml-1 font-normal text-amber-600 dark:text-amber-500">(low confidence)</span>}
            </div>
            <div className="text-lg font-semibold">{typeof result.overallScore === "number" ? Math.round(result.overallScore) : "—"}</div>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <div>
              <div className="text-zinc-500">Required</div>
              <div className="font-medium">{pct(result.dimensionScores?.required ?? null)}</div>
            </div>
            <div>
              <div className="text-zinc-500">Preferred</div>
              <div className="font-medium">{pct(result.dimensionScores?.preferred ?? null)}</div>
            </div>
            <div>
              <div className="text-zinc-500">Experience</div>
              <div className="font-medium">{pct(result.dimensionScores?.experience ?? null)}</div>
            </div>
            <div>
              <div className="text-zinc-500">Seniority</div>
              <div className="font-medium">{pct(result.dimensionScores?.seniority ?? null)}</div>
            </div>
          </div>

          <div className="text-xs">
            <span className="text-zinc-500">Requirement Coverage: </span>
            <span className="font-medium">{typeof result.requirementCoverage === "number" ? Math.round(result.requirementCoverage * 100) : "—"}%</span>
            <span className="text-zinc-500"> · Employer-Evidenced Share: </span>
            <span className="font-medium">{typeof result.employerEvidencedShare === "number" ? Math.round(result.employerEvidencedShare * 100) : "—"}%</span>
          </div>

          <div className="rounded border border-zinc-200 p-2 text-xs dark:border-zinc-800">
            <div className="mb-1 font-semibold">
              Eligibility: <span className={result.eligibility?.status === "BLOCKED" ? "text-red-600" : result.eligibility?.status === "UNKNOWN" ? "text-amber-600" : "text-emerald-700 dark:text-emerald-400"}>{result.eligibility?.status ?? "Unknown"}</span>
              {result.eligibility?.status === "PASS" && <span className="ml-1 font-normal text-zinc-500">(no known hard blocker — not a confirmation)</span>}
            </div>
            <ul className="space-y-0.5 text-zinc-600 dark:text-zinc-400">
              {(result.eligibility?.reasons ?? []).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>

          {/* Defensive: every field below normalizes with `?? []`/`?.` even though the API is now
              expected to always populate them (see deserializeJobMatchResult) — this component must
              never crash on an old cached result, a manually-inserted row, or a future schema gap. */}
          {(result.criticalGaps ?? []).length > 0 && (
            <RequirementList title="Critical Gaps" items={result.criticalGaps} tone="text-red-600" />
          )}
          <RequirementList title="Employer-Evidenced Matches" items={result.employerEvidencedMatches} tone="text-emerald-700 dark:text-emerald-400" />
          <RequirementList title="Inventory-Only Matches" items={result.inventoryOnlyMatches} tone="text-zinc-600 dark:text-zinc-400" />
          <RequirementList title="Transferable Matches" items={result.transferableMatches} tone="text-amber-600" />
          <RequirementList title="Missing Requirements" items={result.missingRequirements} tone="text-zinc-500" />
          <RequirementList title="Unresolved Requirements" items={result.unresolvedRequirements} tone="text-zinc-500" />

          {(result.unrecognizedCandidateSkills ?? []).length > 0 && (
            <p className="text-xs text-zinc-400">
              Not yet recognized by the skill taxonomy: {result.unrecognizedCandidateSkills.join(", ")}
            </p>
          )}

          <div className="text-xs">
            <span className="text-zinc-500">Recommended Track: </span>
            <span className="font-medium">{result.recommendedTrack ?? "Unknown"}</span>
          </div>

          {(result.blockingReasons ?? []).length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs dark:border-amber-900 dark:bg-amber-900/20">
              <div className="mb-1 font-semibold">Why not Ready for Tailoring:</div>
              <ul className="space-y-0.5">
                {result.blockingReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={evaluate}
            className="rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Re-evaluate
          </button>
        </div>
      )}
    </div>
  );
}
