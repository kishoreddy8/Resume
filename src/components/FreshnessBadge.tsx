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
  PRIMARY: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  SECONDARY: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  UNKNOWN_DATE: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  STALE: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500",
};

export function FreshnessBadge({ tier }: { tier: FreshnessTier }) {
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${FRESHNESS_STYLE[tier]}`}>
      {FRESHNESS_LABEL[tier]}
    </span>
  );
}
