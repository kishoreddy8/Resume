import type { H1bCombinedSignal } from "@/types";

const STYLES: Record<H1bCombinedSignal, string> = {
  Likely: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  High: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  Medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  Low: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  Unlikely: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  Unknown: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export function H1bBadge({ signal }: { signal: H1bCombinedSignal }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[signal]}`}
      title={`H1B sponsorship signal: ${signal}`}
    >
      {signal}
    </span>
  );
}
