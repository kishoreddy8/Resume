import type { FreshnessTier } from "@/lib/rank/forYou";

/**
 * Displays forYou.ts's computeFreshnessTier — a ranking/display concept distinct from
 * src/lib/jobLifecycle.ts's age-band "Fresh" highlight (useLifecycleThresholds/FreshBadge in
 * JobList.tsx), which stays untouched. Shared by JobList (All Jobs) and ForYouList (For You) so both
 * views agree on what "fresh" means for ranking purposes.
 */

const FRESHNESS_LABEL: Record<FreshnessTier, string> = {
  PRIMARY: "Posted ≤10d",
  SECONDARY: "Posted ≤20d",
  UNKNOWN_DATE: "Date unknown",
  STALE: "Stale (>20d)",
};

const FRESHNESS_STYLE: Record<FreshnessTier, string> = {
  PRIMARY: "bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-[var(--success)]",
  SECONDARY: "bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]",
  UNKNOWN_DATE: "bg-[var(--z0-bg)] text-secondary",
  STALE: "bg-[var(--z0-bg)] text-tertiary",
};

export function FreshnessBadge({ tier }: { tier: FreshnessTier }) {
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${FRESHNESS_STYLE[tier]}`}>
      {FRESHNESS_LABEL[tier]}
    </span>
  );
}
