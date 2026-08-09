export type MatchDecision = "BLOCKED" | "NEEDS_REVIEW" | "READY_FOR_TAILORING";

const STYLES: Record<MatchDecision, string> = {
  READY_FOR_TAILORING: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  NEEDS_REVIEW: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  BLOCKED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
};

const LABELS: Record<MatchDecision, string> = {
  READY_FOR_TAILORING: "Ready for Tailoring",
  NEEDS_REVIEW: "Needs Review",
  BLOCKED: "Blocked",
};

/** Same small-pill visual language as H1bBadge/AiConfidenceBadge — Phase 2's terminal decision
 *  state, always shown alongside its blockingReasons/eligibility text, never as a bare label (see
 *  MatchCard.tsx — PASS/READY must never be presented as more certain than they are). */
export function MatchDecisionBadge({ decision }: { decision: MatchDecision }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[decision]}`}
      title={`Phase 2 match decision: ${LABELS[decision]}`}
    >
      {LABELS[decision]}
    </span>
  );
}
