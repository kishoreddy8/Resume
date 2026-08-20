"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { MatchDecisionBadge, type MatchDecision } from "@/components/MatchDecisionBadge";
import { getJobAgeBand, getJobAgeDays, type LifecycleThresholds } from "@/lib/jobLifecycle";
import type { JobWithCompany } from "@/types";
import type { JobMatch } from "./useJobMatch";
import { ScoreRing } from "./ScoreRing";
import { ScoreBreakdown } from "./ScoreBreakdown";
import { HeroTiles } from "./HeroTiles";
import { WorkflowRail, resolveWorkflowStages } from "./WorkflowRail";
import { RoleIdentity } from "./RoleIdentity";
import { SkillAlignment } from "./SkillAlignment";
import { MatchIntelligence } from "./MatchIntelligence";
import { JobQueueNav } from "./JobQueueNav";
import type { QueueNeighbours } from "../queue";
import type { ResumeStageSummary } from "./resumeStage";
import { heroStage, heroRegion, heroStageReduced, heroRegionReduced, verdictGlow } from "./choreography";

/**
 * Stage 2 — the decision header.
 *
 * The page used to open with a title and a link, and buried the verdict three cards down a narrow
 * rail. This block exists to answer, without scrolling: what job is this, is it a match, why, is
 * anything blocking it, and what happens next.
 *
 * It renders the Phase 2 result and nothing else. The decision, the eligibility status, every
 * reason string, the insufficient-signal flag and the sponsorship confidence are passed straight
 * through from the API — no state is derived, no score is recomputed, no sponsorship is inferred,
 * and no reason is re-worded. The caveat sentences below are the ones MatchCard already showed;
 * they travel with the verdict because a decision shown without them would read as more certain
 * than the engine actually is.
 */

const AGE_BAND_LABELS = {
  fresh: "Fresh",
  active: "Active",
  aging: "Aging",
  stale: "Stale",
} as const;

/** Age is metadata, so it is set in text rather than another coloured pill competing with the
 *  verdict. `aging`/`stale` keep a colour because they warn about automatic archival/deletion. */
const AGE_BAND_TEXT = {
  fresh: "text-secondary",
  active: "text-tertiary",
  aging: "text-[var(--warning)]",
  stale: "text-[var(--warning)]",
} as const;

function StateLine({ tone, children }: { tone: "warning" | "error" | "neutral"; children: ReactNode }) {
  const border =
    tone === "error"
      ? "border-l-[var(--error)]"
      : tone === "warning"
        ? "border-l-[var(--warning)]"
        : "border-l-[var(--border)]";
  return <div className={`border-l-2 ${border} py-0.5 pl-3 text-[13px] leading-relaxed text-secondary`}>{children}</div>;
}

export function JobDecisionHeader({
  job,
  match,
  thresholds,
  actions,
  generatedFileCount = 0,
  showBackLink = true,
  onClose,
  headingLevel = "h1",
  nav,
  onSelectJob,
  requirementsSummary,
  intelligenceBand,
  resumeStage,
}: {
  job: JobWithCompany;
  match: JobMatch;
  thresholds: LifecycleThresholds;
  /** The page's existing tailoring controls. Rendered, never invoked from here. */
  actions: ReactNode;
  /** Drives the Resume tile. Read from the detail payload the page already has. */
  generatedFileCount?: number;
  /** Hidden in the Workbench pane, where the list beside it already is the way back. */
  showBackLink?: boolean;
  /** Close affordance for the narrow-screen sheet. Keyboard reachable; never the only way out. */
  onClose?: () => void;
  /** The standalone route owns the page's h1. Inside the Workbench pane the toolbar does, so the
   *  job title steps down to h2 rather than giving the document two competing top-level headings. */
  headingLevel?: "h1" | "h2";
  /** Position in the visible queue; absent on the standalone route. */
  nav?: QueueNeighbours;
  onSelectJob?: (id: number) => void;
  /** Composed by the page from state it already holds — passed in, never re-derived here. */
  requirementsSummary?: ReactNode;
  /** Tailoring studio + application readiness, composed by the page from state it already holds. */
  intelligenceBand?: ReactNode;
  /** The real resume-workflow stage, so the rail's RESUME node agrees with the studio beneath it. */
  resumeStage?: ResumeStageSummary | null;
}) {
  const Heading = headingLevel;
  const reduced = useReducedMotion() ?? false;
  const stage = reduced ? heroStageReduced : heroStage;
  const region = reduced ? heroRegionReduced : heroRegion;
  const { result, state } = match;
  const ageDays = getJobAgeDays({ posted_at: job.posted_at, first_seen_at: job.first_seen_at });
  const ageBand = getJobAgeBand(ageDays, thresholds);

  const context = [job.location, job.employment_type, job.workplace_type, job.salary_text].filter(Boolean);
  const eligibility = result?.eligibility;
  const stages = resolveWorkflowStages(match, job, generatedFileCount, resumeStage);
  const blockingReasons = result?.blockingReasons ?? [];
  // A score is shown only when the engine trusts it. When the JD signal is insufficient the number
  // is an unknown, not a low match, so it is replaced by that statement rather than printed with a
  // footnote the eye can skip.
  // The first blocking reason only. Eligibility reasons already render verbatim below, and
  // promoting one printed the identical sentence twice in the same hero.
  const leadReason = blockingReasons[0] ?? null;

  return (
    <motion.header
      key={job.id}
      variants={stage}
      initial="enter"
      animate="settled"
      className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-surface"
    >
      {/* Queue position and traversal, above the identity: "where am I, and how do I move". */}
      {nav && onSelectJob && nav.index >= 0 && (
        <div className="flex items-center justify-between gap-3 border-b border-[var(--separator)] px-3 py-1.5">
          <JobQueueNav nav={nav} onSelect={onSelectJob} />
          <span className="hidden shrink-0 whitespace-nowrap text-[10.5px] text-tertiary xl:inline">
            ↑ ↓ in the list
          </span>
        </div>
      )}

      <motion.div variants={region} className="border-b border-[var(--separator)] px-5 py-4">
        {showBackLink && (
          <Link
            href="/jobs"
            className="text-[12px] text-tertiary transition-colors duration-150 ease-out hover:text-primary"
          >
            ← Back to jobs
          </Link>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-[12px] text-tertiary transition-colors duration-150 ease-out hover:text-primary active:scale-[0.98]"
          >
            ✕ Close
          </button>
        )}

        <div className="mt-2 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <Heading className="page-title">{job.title}</Heading>
            <p className="mt-1 text-[13px] text-secondary">
              {job.company_name} · {job.source_type}
              {job.is_archived === 1 ? " · archived" : !job.is_active && " · closed"}
              {job.is_archived === 0 && (
                <>
                  {" · "}
                  <span className={AGE_BAND_TEXT[ageBand]}>
                    {AGE_BAND_LABELS[ageBand]} · {ageDays}d
                  </span>
                </>
              )}
            </p>
            {context.length > 0 && (
              <p className="mt-1.5 text-[13px] text-tertiary">{context.join("  ·  ")}</p>
            )}
          </div>

          <a
            href={job.url}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-md bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--accent-fg)] transition-[background-color,transform] duration-150 ease-out hover:bg-[var(--accent-hover)] active:scale-[0.985]"
          >
            View posting ↗
          </a>
        </div>
      </motion.div>

      {/* Verdict hero. The ring, the badge and the caveats are all the engine's own
       *  output — the composition changes, the facts do not. */}
      <motion.div
        variants={region}
        /* Two decorative systems were built for this surface and both were removed after looking
         * at them: pointer tilt (Motion owns `transform` here, so it rendered `transform: none` and
         * never ran) and orbital arcs (no band of this hero is empty enough for an arc to read as
         * an arc — every placement either crossed the eligibility copy or clipped to a stray
         * sliver). The dimensionality is carried statically, by `.lit` and the verdict glow. */
        className="lit relative px-5 py-5"
        // Reflected light, not paint: the glow behind the hero takes the decision's colour.
        style={{ ["--accent-soft" as string]: verdictGlow(result?.decision, !result?.insufficientJdSignal) }}
      >
        <div className="flex items-start gap-5">
          {result && (
            <ScoreRing
              score={typeof result.overallScore === "number" ? result.overallScore : null}
              trusted={!result.insufficientJdSignal}
              tone={
                result.decision === "READY_FOR_TAILORING"
                  ? "ready"
                  : result.decision === "NEEDS_REVIEW"
                    ? "review"
                    : result.decision === "BLOCKED"
                      ? "blocked"
                      : "neutral"
              }
            />
          )}

          <div className="min-w-0 flex-1 space-y-2.5 pt-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {result && <MatchDecisionBadge decision={result.decision as MatchDecision} emphasis="strong" />}
              {state === "loading" && <span className="text-[13px] text-tertiary">Checking match…</span>}
              {state === "none" && <span className="text-[13px] text-tertiary">Not yet evaluated</span>}
              {state === "error" && (
                <span className="text-[13px] text-[var(--error)]">Failed to load match status.</span>
              )}
            </div>

            {/* The strongest single reason, promoted out of the list below so the eye
             *  reaches "why" before it reaches depth. Verbatim engine output. */}
            {leadReason && <p className="text-[12.5px] leading-relaxed text-secondary">{leadReason}</p>}
          </div>

          {/* The hero's empty rectangle, filled with the only thing that answers the ring's
           *  follow-up question. Hidden on narrow panes, where the ring and verdict need the room
           *  more than the breakdown does. */}
          {result && (
            <div className="hidden w-[13.5rem] shrink-0 pt-1 xl:block">
              <ScoreBreakdown
                dimensions={result.dimensionScores}
                trusted={!result.insufficientJdSignal}
              />
            </div>
          )}
        </div>

        {/* PHASE D — where this sits in the workflow, and what role it actually is. Two different
         *  geometries on purpose: a staged rail, then an identity line. Neither is a tile. */}
        <motion.div variants={region} className="mt-5 border-t border-[var(--separator)] pt-4">
          <WorkflowRail stages={stages} />

        </motion.div>

        {/* Why this match — strengths, concerns and unknowns, then the engine's own decision.
         *  Placed before role/skills because it is the question the page exists to answer. */}
        {result && (
          <motion.div variants={region} id="job-why" className="mt-5 scroll-mt-14 border-t border-[var(--separator)] pt-4">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">Why this match</div>
            <div className="mt-2.5">
              <MatchIntelligence result={result} />
            </div>
          </motion.div>
        )}

        {result && (
          <motion.div variants={region} className="mt-5 border-t border-[var(--separator)] pt-4">
            <RoleIdentity result={result} />
          </motion.div>
        )}

        {/* The intelligence band: the studio takes two thirds, readiness one. Two surfaces, not a
         *  row of tiles — and it sits directly under the rail/role so tailoring and resume state
         *  are readable without scrolling. Stacks on narrow panes. */}
        {intelligenceBand && (
          <motion.div variants={region} className="mt-5">
            {intelligenceBand}
          </motion.div>
        )}

        {/* PHASE E — the alignment matrix resolves as ONE region, never row by row. */}
        {result && (
          <motion.div variants={region} className="mt-5 border-t border-[var(--separator)] pt-4">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
              Skill alignment
            </div>
            <div className="mt-2">
              <SkillAlignment
                result={result}
                limit={4}
                onSeeAll={() =>
                  document.getElementById("job-skills")?.scrollIntoView({ block: "start" })
                }
              />
            </div>
          </motion.div>
        )}

        {/* Requirement families at a glance — five lines, each jumping to the detail below. */}
        {requirementsSummary && (
          <motion.div variants={region} className="mt-5 border-t border-[var(--separator)] pt-4">
            <div className="text-[9.5px] font-semibold uppercase tracking-[0.11em] text-tertiary">
              Requirements
            </div>
            <div className="mt-2">{requirementsSummary}</div>
          </motion.div>
        )}

        <motion.div variants={region} className="mt-5">
          <HeroTiles
            job={job}
            result={result}
            thresholds={thresholds}
            generatedFileCount={generatedFileCount}
          />
        </motion.div>

        {/* The engine's own caveats, kept with the verdict rather than filed away below it. */}
        <div className="mt-3 space-y-2">
          {result?.insufficientJdSignal && (
            <StateLine tone="warning">
              <span className="font-medium text-primary">Insufficient structured JD data.</span> Fewer than
              the minimum number of requirements could be extracted from this posting, so the score is an
              unknown — it is neither a confident match nor a confident non-match, and lists rank this
              posting below every fully-evidenced one.
            </StateLine>
          )}

          {blockingReasons.length > 0 && (
            <StateLine tone="warning">
              <span className="font-medium text-primary">Why not Ready for Tailoring</span>
              <ul className="mt-1 space-y-0.5">
                {blockingReasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </StateLine>
          )}

          {eligibility && (
            <StateLine tone={eligibility.status === "BLOCKED" ? "error" : eligibility.status === "UNKNOWN" ? "warning" : "neutral"}>
              <span className="font-medium text-primary">Eligibility: {eligibility.status ?? "Unknown"}</span>
              {eligibility.status === "PASS" && (
                <span className="text-tertiary"> (no known hard blocker — not a confirmation)</span>
              )}
              {eligibility.status === "UNKNOWN" && (
                <span className="text-tertiary">
                  {" "}
                  (advisory — an unknown sponsorship signal is not treated as a blocker, and is not read as
                  a &ldquo;no&rdquo;)
                </span>
              )}
              {(eligibility.reasons ?? []).length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {(eligibility.reasons ?? []).map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </StateLine>
          )}
        </div>

        {/* Next action — the last phase of the choreography. These are the page's existing
         *  controls; tailoring still runs in Claude Code and still requires you to start it. */}
        <motion.div variants={region} className="mt-4 border-t border-[var(--separator)] pt-3">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-tertiary">
            Next action
          </h2>
          {actions}
        </motion.div>
      </motion.div>
    </motion.header>
  );
}
