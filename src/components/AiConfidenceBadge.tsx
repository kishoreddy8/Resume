export type AiConfidenceBand = "low" | "review" | "high";

const STYLES: Record<AiConfidenceBand, string> = {
  high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  review: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

const LABELS: Record<AiConfidenceBand, string> = {
  high: "High confidence",
  review: "Needs review",
  low: "Low confidence",
};

/** Same visual language as H1bBadge — a small rounded pill — but a distinct component: AI
 *  confidence (a generic 0..1 score) is a different concept from H1bJobConfidence's closed,
 *  domain-specific enum, and this badge exists specifically to make an AI-sourced value visually
 *  distinguishable from deterministic Job Intelligence data on the page. */
export function AiConfidenceBadge({ value, band }: { value: number; band: AiConfidenceBand }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[band]}`}
      title={`AI confidence: ${Math.round(value * 100)}%`}
    >
      {LABELS[band]}
    </span>
  );
}
