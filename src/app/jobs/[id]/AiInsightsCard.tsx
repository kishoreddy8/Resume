"use client";

import { useState } from "react";
import { AiConfidenceBadge } from "@/components/AiConfidenceBadge";
import { toConfidenceBand } from "@/lib/ai/confidence";
import type { FieldSuggestion } from "@/lib/ai/tasks/jobDetailEnrichment";

/**
 * "Enrich with AI" — Job Detail. Strictly on-demand: nothing in this component fires on mount —
 * the only network call happens inside handleEnrich, itself only ever invoked by the button's
 * onClick. Every AI-sourced value rendered here lives in its own card, under its own "AI" heading,
 * with its own confidence badge — never blended into AtAGlanceCard's deterministic values.
 */

type EnrichResponse =
  | { status: "ok"; cached: boolean; enrichmentId: number; summary: string; suggestions: FieldSuggestion[] }
  | { status: "unavailable"; reason: string };

const FIELD_LABELS: Record<FieldSuggestion["field"], string> = {
  seniority: "Seniority",
  employmentType: "Employment Type",
  workplaceType: "Work Arrangement",
  industryDomain: "Industry / Domain",
  compensation: "Salary",
};

function formatSuggestionValue(suggestion: FieldSuggestion): string {
  if (suggestion.field === "compensation") {
    const { min, max, currency, period } = suggestion.value;
    const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
    const range = min !== null && max !== null ? `${fmt(min)} - ${fmt(max)}` : fmt((min ?? max)!);
    const periodLabel = period === "hourly" ? "/hr" : period === "annual" ? "/yr" : "";
    return `${currency ?? ""} ${range}${periodLabel}`.trim();
  }
  return suggestion.value;
}

type Decision = "accepted" | "rejected";

function SuggestionRow({
  suggestion,
  jobId,
  enrichmentId,
}: {
  suggestion: FieldSuggestion;
  jobId: number;
  enrichmentId: number;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [busy, setBusy] = useState(false);
  const band = toConfidenceBand(suggestion.confidence);

  async function decide(event: Decision) {
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/ai-enrich`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enrichmentId, event, field: suggestion.field }),
      });
      if (res.ok) setDecision(event);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-zinc-500">{FIELD_LABELS[suggestion.field]}</div>
        <AiConfidenceBadge value={suggestion.confidence} band={band} />
      </div>
      <div className="mb-2 text-sm text-zinc-800 dark:text-zinc-200">{formatSuggestionValue(suggestion)}</div>
      <blockquote className="mb-2 rounded border-l-2 border-zinc-300 bg-zinc-50 px-2 py-1.5 text-xs italic text-zinc-600 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-400">
        &ldquo;{suggestion.evidence.excerpt}&rdquo;
      </blockquote>
      {decision ? (
        <div className="text-xs font-medium text-zinc-500">
          {decision === "accepted" ? "Accepted" : "Dismissed"}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("accepted")}
            className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("rejected")}
            className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function AiInsightsCard({ jobId }: { jobId: number }) {
  const [state, setState] = useState<"idle" | "loading" | "ok" | "unavailable">("idle");
  const [result, setResult] = useState<Extract<EnrichResponse, { status: "ok" }> | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  async function handleEnrich() {
    setState("loading");
    try {
      const res = await fetch(`/api/jobs/${jobId}/ai-enrich`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as EnrichResponse | null;
      if (!res.ok || !body || body.status !== "ok") {
        setReason(body && "reason" in body ? body.reason : null);
        setState("unavailable");
        return;
      }
      setResult(body);
      setState("ok");
    } catch {
      setReason(null);
      setState("unavailable");
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="mb-1 text-sm font-semibold">AI Insights</h2>
      <p className="mb-3 text-xs text-zinc-500">
        AI-generated — always verify against the full description below. Never replaces the
        deterministic fields in At a Glance.
      </p>

      {state === "idle" && (
        <button
          type="button"
          onClick={handleEnrich}
          className="rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          Enrich with AI
        </button>
      )}

      {state === "loading" && <p className="text-sm text-zinc-500">Enriching…</p>}

      {state === "unavailable" && (
        <div>
          <p className="text-sm text-zinc-500" title={reason ?? undefined}>
            AI enrichment unavailable right now.
          </p>
          <button
            type="button"
            onClick={handleEnrich}
            className="mt-2 rounded border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Try again
          </button>
        </div>
      )}

      {state === "ok" && result && (
        <div>
          <div className="mb-3">
            <div className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-500">
              <span>AI Summary</span>
              {result.cached && <span className="text-zinc-400">(cached)</span>}
            </div>
            <p className="text-sm text-zinc-700 dark:text-zinc-300">{result.summary}</p>
          </div>

          {result.suggestions.length > 0 && (
            <div>
              <div className="mb-2 text-xs font-medium text-zinc-500">AI Suggestions</div>
              <div className="space-y-2">
                {result.suggestions.map((suggestion) => (
                  <SuggestionRow
                    key={suggestion.field}
                    suggestion={suggestion}
                    jobId={jobId}
                    enrichmentId={result.enrichmentId}
                  />
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleEnrich}
            className="mt-3 rounded border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Refresh
          </button>
        </div>
      )}
    </div>
  );
}
