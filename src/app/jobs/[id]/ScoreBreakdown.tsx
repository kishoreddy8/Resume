"use client";

import type { DimensionScores } from "@/lib/match/types";

/**
 * The five dimensions behind the ring, sitting where the hero was empty.
 *
 * The ring answers "how strong is this?" and left a large blank rectangle beside it; the obvious
 * thing to put there is the only content that answers the immediate follow-up — "made of what?".
 * These are `dimensionScores`, the engine's own published components, already in the match payload.
 * Nothing is recomputed, re-weighted or combined here.
 *
 * NULL IS NOT ZERO. A dimension is null when it does not apply to this posting — no Required units,
 * no stated seniority, no deterministic experience comparison. It renders an em dash over a dashed
 * track, never a bar at zero, because a zero-length bar reads as "you scored nothing" when the truth
 * is "this was not scored". The same rule the ScoreRing follows for an untrusted overall score.
 *
 * The bars are aria-hidden decoration; every value is also printed as text.
 */

const LABELS: { key: keyof DimensionScores; label: string }[] = [
  { key: "roleAlignment", label: "Role" },
  { key: "required", label: "Required" },
  { key: "preferred", label: "Preferred" },
  { key: "experience", label: "Experience" },
  { key: "seniority", label: "Seniority" },
];

export function ScoreBreakdown({
  dimensions,
  trusted,
}: {
  dimensions: DimensionScores | null | undefined;
  /** False when insufficientJdSignal is set — the components mean as little as the total does. */
  trusted: boolean;
}) {
  if (!dimensions) return null;

  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-[7px]">
      {LABELS.map(({ key, label }) => {
        const raw = dimensions[key];
        const value = typeof raw === "number" ? Math.max(0, Math.min(100, raw)) : null;
        const shown = value !== null && trusted;
        return (
          <div key={key} className="contents">
            <dt className="text-[10.5px] uppercase tracking-[0.06em] text-tertiary">{label}</dt>
            <dd aria-hidden="true" className="h-[3px] min-w-[40px] rounded-full bg-[var(--separator)]">
              {shown ? (
                <div
                  className="h-full rounded-full bg-[var(--accent)] opacity-70"
                  style={{ width: `${value}%` }}
                />
              ) : (
                // Dashed, unfilled: the dimension was not scored, which is not a score of zero.
                <div className="h-full rounded-full border-t border-dashed border-[var(--border)]" />
              )}
            </dd>
            <dd className="w-[2.6rem] text-right text-[11.5px] tabular-nums text-secondary">
              {shown ? `${Math.round(value)}%` : "—"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
