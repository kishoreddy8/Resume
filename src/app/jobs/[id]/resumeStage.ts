/**
 * The resume workflow's real stage, lifted out of ResumeQualityPipeline so the command center at
 * the top can show it.
 *
 * WHY THIS EXISTS: the page had two stage displays that never spoke to each other — the top rail's
 * RESUME node (which only knew whether files existed) and the pipeline's own Created → Writer →
 * Review → Improvement → Ready strip buried at the bottom. You could not tell from the top where a
 * resume actually stood. This is the bridge.
 *
 * IT ADDS NO REQUEST. ResumeQualityPipeline already fetches `quality-workflow`; it now reports what
 * it received upward, and the top reads that. There is still exactly one GET call site.
 */

export type ResumeStageKey =
  | "not_started"
  | "waiting_writer"
  | "review"
  | "improvement"
  | "ready"
  | "safe_best_attempt"
  | "failed";

export interface ResumeStageSummary {
  key: ResumeStageKey;
  /** Short words for the studio cell. Never a percentage, never "generating" unless truly running. */
  label: string;
  detail: string | null;
  /** Index into Created·Writer·Review·Improvement·Ready, so the top can mirror the same 5 steps. */
  step: number;
  tone: "done" | "active" | "idle" | "blocked" | "unknown";
}

/**
 * Maps the workflow record the pipeline already holds. Deliberately a pure function of `status`,
 * `waitingFor` and the Stage 28 disposition — it re-decides nothing.
 *
 * SAFE_BEST_ATTEMPT is kept distinct from both READY and FAILED, because Stage 21's whole point is
 * that a safe best attempt is neither. Collapsing it either way here would misreport the one state
 * the truthfulness gates exist to express.
 */
export function summarizeResumeStage(input: {
  status: string | null;
  waitingFor: string | null;
  disposition: string | null;
  currentIteration: number | null;
} | null): ResumeStageSummary {
  if (!input || !input.status) {
    return { key: "not_started", label: "Not started", detail: null, step: 0, tone: "idle" };
  }

  const { status, waitingFor, disposition, currentIteration } = input;
  const iter = typeof currentIteration === "number" ? `Iteration ${currentIteration}` : null;

  if (status === "READY") {
    if (disposition === "SAFE_BEST_ATTEMPT") {
      return {
        key: "safe_best_attempt",
        label: "Safe best attempt",
        detail: "Reached the end with usable output — not a full READY publication",
        step: 4,
        tone: "active",
      };
    }
    if (disposition === "BLOCKED") {
      return { key: "failed", label: "Blocked", detail: "Publication blocked", step: 4, tone: "blocked" };
    }
    return { key: "ready", label: "Ready", detail: "Passed the quality gate", step: 4, tone: "done" };
  }

  if (status === "FAILED") {
    return { key: "failed", label: "Needs attention", detail: iter, step: 3, tone: "blocked" };
  }
  if (status === "IMPROVEMENT_RUNNING") {
    return { key: "improvement", label: "Improving", detail: iter, step: 3, tone: "active" };
  }
  if (status === "REVIEW_RUNNING" || status === "REVIEW_COMPLETED") {
    return { key: "review", label: "In review", detail: iter, step: 2, tone: "active" };
  }
  if (status === "CREATED" || status === "WRITER_RUNNING" || status === "WRITER_COMPLETED") {
    // CREATED means "approved, waiting for the writer's first draft" — and with Resume Writer off
    // nothing is running, so this says waiting rather than generating.
    return {
      key: "waiting_writer",
      label: waitingFor === "EXTERNAL_WRITER" ? "Awaiting writer" : "Drafting",
      detail: iter,
      step: 1,
      tone: "active",
    };
  }

  return { key: "not_started", label: "Not started", detail: null, step: 0, tone: "idle" };
}

/* Short labels for the compact mirror at the top — five columns inside a ~420px card cannot fit
 * "Improvement" without truncating it to "IMPROVEME…". The detailed pipeline below keeps the full
 * word; this is a display abbreviation, not a different vocabulary. */
export const RESUME_STEPS = ["Created", "Writer", "Review", "Improve", "Ready"] as const;

/**
 * UI-0 DEFECT 1 — the READY success banner rendered `workflow.latest_overall_score ?? 96`: a
 * hard-coded 96 whenever the real score was null, printed in bold inside a success panel
 * immediately before the resume can be attached to a real application. Career-Ops never fabricates
 * an answer it cannot evidence; a quality score is no exception. When no authoritative score
 * exists, say so honestly rather than substitute any number — 96, 100, or otherwise.
 */
export function formatQualityScore(score: number | null): string {
  return typeof score === "number" ? `${score}/100` : "Quality check unavailable";
}
