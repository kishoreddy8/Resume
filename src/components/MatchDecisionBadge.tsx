export type MatchDecision = "BLOCKED" | "NEEDS_REVIEW" | "READY_FOR_TAILORING";

const STYLES: Record<MatchDecision, string> = {
  READY_FOR_TAILORING: "bg-[color-mix(in_oklab,var(--success)_14%,transparent)] text-[var(--success)]",
  NEEDS_REVIEW: "bg-[color-mix(in_oklab,var(--warning)_14%,transparent)] text-[var(--warning)]",
  BLOCKED: "bg-[color-mix(in_oklab,var(--error)_13%,transparent)] text-[var(--error)]",
};

const LABELS: Record<MatchDecision, string> = {
  READY_FOR_TAILORING: "Ready for Tailoring",
  NEEDS_REVIEW: "Needs Review",
  BLOCKED: "Blocked",
};

/** Same small-pill visual language as H1bBadge/AiConfidenceBadge — Phase 2's terminal decision
 *  state, always shown alongside its blockingReasons/eligibility text, never as a bare label (see
 *  MatchCard.tsx — PASS/READY must never be presented as more certain than they are).
 *
 *  `emphasis="strong"` is the same decision, the same label and the same colour, set larger for the
 *  job detail page's decision header, where the verdict is the primary thing on the page rather than
 *  one cell in a table. It is opt-in so every existing call site — the jobs list included — keeps
 *  the compact form unchanged. */
export function MatchDecisionBadge({
  decision,
  emphasis = "default",
}: {
  decision: MatchDecision;
  emphasis?: "default" | "strong";
}) {
  const sizing =
    emphasis === "strong" ? "rounded-lg px-2.5 py-1 text-sm font-semibold" : "rounded-full px-2 py-0.5 text-xs font-medium";
  return (
    <span
      className={`inline-flex items-center ${sizing} ${STYLES[decision]}`}
      title={`Phase 2 match decision: ${LABELS[decision]}`}
    >
      {LABELS[decision]}
    </span>
  );
}
