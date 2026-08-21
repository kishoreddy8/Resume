import type { H1bJobConfidence } from "@/types";

/** Dot carries the semantic; the label always carries the meaning. Unknown is hollow so an
 *  absent signal is distinguishable from a weak positive without relying on colour. */
const DOT: Record<H1bJobConfidence, string> = {
  "Very High": "bg-[var(--success)]",
  High: "bg-[var(--success)]",
  Medium: "bg-[var(--warning)]",
  Low: "bg-orange-500",
  "Not Sponsoring": "bg-[var(--error)]",
  Unknown: "bg-transparent ring-1 ring-inset ring-[var(--border)]",
};

const TEXT: Record<H1bJobConfidence, string> = {
  "Very High": "text-secondary",
  High: "text-secondary",
  Medium: "text-secondary",
  Low: "text-secondary",
  "Not Sponsoring": "text-[var(--error)] font-medium",
  Unknown: "text-tertiary",
};

/** confidence accepts H1bJobConfidence (job level, 6 values) or H1bCompanyConfidence (company
 *  level, its 5 values are a strict subset) — one badge for both call sites. */
export function H1bBadge({ confidence }: { confidence: H1bJobConfidence }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] ${TEXT[confidence]}`}
      title={`H1B sponsorship confidence: ${confidence}`}
    >
      <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[confidence]}`} />
      {confidence}
    </span>
  );
}
