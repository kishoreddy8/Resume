import type { H1bJobConfidence } from "@/types";

const STYLES: Record<H1bJobConfidence, string> = {
  "Very High": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  High: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  Medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  Low: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  "Not Sponsoring": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  Unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

/** confidence accepts H1bJobConfidence (job level, 6 values) or H1bCompanyConfidence (company
 *  level, its 5 values are a strict subset) — one badge for both call sites. */
export function H1bBadge({ confidence }: { confidence: H1bJobConfidence }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[confidence]}`}
      title={`H1B sponsorship confidence: ${confidence}`}
    >
      {confidence}
    </span>
  );
}
