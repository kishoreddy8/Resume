"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { JobWithCompany } from "@/types";
import { useResolvedCandidateId } from "@/lib/useActiveCandidateId";
import { useJobMatch } from "./useJobMatch";
import { useTailoringPlan } from "./useTailoringPlan";
import type { ResumeStageSummary } from "./resumeStage";
import { JobIdentityHeader } from "./JobIdentityHeader";
import { WorkflowStepper } from "./WorkflowStepper";
import { defaultStep, resolveWorkflowSteps, type StepKey, type WorkflowInput } from "./workflowSteps";
import { MatchStep } from "./MatchStep";
import { ResumeStudioStep } from "./ResumeStudioStep";
import { TailoringResultsStep } from "./TailoringResultsStep";
import { ValidationStep } from "./ValidationStep";
import { ApplicationReadyStep } from "./ApplicationReadyStep";
import { useQualityWorkflow } from "./useQualityWorkflow";
import { TailoringStudio } from "./TailoringStudio";
import { ResumeQualityPipeline } from "./ResumeQualityPipeline";
import { StartApplication } from "./StartApplication";
import { ApplicationDetail } from "@/app/applications/[id]/ApplicationDetail";
import { JobReviewSkeleton } from "../Skeletons";
import { EmptyNote, WsCard } from "./WorkspaceUI";
import {
  resolveWorkspaceRouteStep,
  type WorkspaceRouteRequest,
} from "./workspaceRoute";
import { workspaceHeroPresentation } from "./workspacePresentation";

/**
 * The Job Workspace.
 *
 * ONE JOB, ONE WORKFLOW, ONE STEP AT A TIME:
 *
 *   MATCH → RESUME STUDIO → TAILORING RESULTS → VALIDATION → APPLICATION
 *
 * ONLY THE ACTIVE STEP IS RENDERED. The previous page stacked nine sections into a single column
 * you scrolled for a minute to reach the bottom of; on a laptop that is not a workflow, it is a
 * report. Here the other four steps are navigation, so the screen only ever holds identity, the
 * stepper, and the thing you are actually doing.
 *
 * IT COMPOSES, IT DOES NOT REIMPLEMENT. Every panel below already exists and already answers to the
 * engine that owns it — MatchIntelligence, RequirementsPanel, TailoringPlanPanel, TailoringImpact,
 * ResumeQualityPipeline, ApplicationReadiness, StartApplication. Rewriting their contents to fit a
 * new layout would have meant re-deriving evidence, validation verdicts and application gating in a
 * second place, which is exactly how two sources of truth about "is this resume safe to send" get
 * created. The workspace decides which of them you see, and nothing else.
 *
 * TRACKING IS INSIDE APPLICATION, not beside it. See workflowSteps.ts.
 *
 * NOTHING RUNS ON LOAD. No AI call, no evaluation, no resume generation, no browser. The heavy
 * later-stage data is fetched only once its step is opened (the tailoring plan, the quality
 * workflow), so opening a job costs the job and its match and nothing else.
 */

interface JobDetail {
  job: JobWithCompany;
  /** Files actually on disk — the only proof a resume was produced. */
  generatedFiles: string[];
}

/** Runs for THIS job, from the candidate's bounded run list. */
interface RunRow {
  id: number;
  jobId: number;
  status: string;
}

const CARD = "rounded-[14px] border border-[var(--border)] bg-[var(--z3-bg)] shadow-[var(--shadow-card)]";

/** A step that cannot be entered yet says what is missing, in the engine's terms. */
function LockedStep({ title, reason }: { title: string; reason: string | null }) {
  return (
    <WsCard title={title}>
      <EmptyNote>{reason ?? "This step is not available yet."}</EmptyNote>
    </WsCard>
  );
}

/** A native disclosure that does not mount its expensive contents until the candidate opens it. */
function LazyDetails({
  summary,
  defaultOpen = false,
  className,
  children,
}: {
  summary: ReactNode;
  defaultOpen?: boolean;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className={className}
    >
      {summary}
      {open ? children : null}
    </details>
  );
}

export function JobWorkspace({
  jobId,
  routeRequest,
}: {
  jobId: number;
  routeRequest: WorkspaceRouteRequest;
}) {
  const candidateId = useResolvedCandidateId();
  const reduced = useReducedMotion() ?? false;
  const workspaceRef = useRef<HTMLDivElement>(null);

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [resume, setResume] = useState<ResumeStageSummary | null>(null);
  /** Null until the user opens a step; then it is whichever step they chose. */
  const [chosen, setChosen] = useState<StepKey | null>(null);
  /* Bumped after a re-validation so the quality record is re-read. Every verdict is then derived
   * from the refetched result — nothing is set optimistically. */
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionFocus, setActionFocus] = useState<WorkspaceRouteRequest["focus"]>(null);

  const match = useJobMatch(jobId, candidateId);

  /* ── job identity ─────────────────────────────────────────────────────────────────────────── */
  useEffect(() => {
    if (candidateId === null) return;
    let cancelled = false;
    fetch(`/api/jobs/${jobId}?candidateId=${candidateId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        if (!body?.job) return setFailed(true);
        setDetail({
          job: body.job as JobWithCompany,
          generatedFiles: (body.generatedFiles ?? []) as string[],
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [jobId, candidateId]);

  /* ── whether an application already exists for this job ───────────────────────────────────────
   * One bounded list read. It is needed by the stepper itself: without it, a job that has already
   * been submitted would render Application as merely "available", which reads as "not started". */
  useEffect(() => {
    if (candidateId === null) return;
    let cancelled = false;
    fetch(`/api/candidates/${candidateId}/application-runs?scope=all&limit=200`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return;
        setRuns(((body?.runs ?? []) as RunRow[]).filter((r) => r.jobId === jobId));
      })
      .catch(() => !cancelled && setRuns([]));
    return () => {
      cancelled = true;
    };
  }, [jobId, candidateId]);

  /* THE HEAVY VALIDATION RECORD IS NOT FETCHED FOR GATING.
   *
   * The quality-workflow endpoint returns the whole review — measured at 4.5KB for one job and
   * 29KB for another — because it carries every iteration, the latest review and the publication
   * record. Pulling that on every workspace open, purely to decide whether a stepper node should
   * be clickable, would have made opening a job cost more than reading it.
   *
   * So the Validation step is simply reachable once the job has been evaluated, and the pipeline
   * that owns the record reports its real stage upward when it mounts (`onStageChange`). Being
   * reachable is not a verdict: a step only reads `done`, and Application only unlocks, on the
   * strength of a stage the validator actually returned. */

  /* The quality record is read by Tailoring Results, Validation and Application — never by Match or
   * Resume Studio, which is why it is gated on the step rather than fetched on mount. `activeKey`
   * is resolved before the input below so the fetch can be gated without a circular dependency:
   * the landing step never depends on the quality record (see defaultStep). */
  const preflightInput: WorkflowInput = {
      result: match.result,
      matchLoading: match.state === "loading" || match.state === "idle",
      resume,
      generatedFileCount: detail?.generatedFiles.length ?? 0,
      runStatuses: (runs ?? []).map((r) => r.status),
      humanMaySend: null,
    };
  /* A requested later step is provisionally mounted so its existing bounded read can establish
   * eligibility. The query itself still performs no work: it only selects which read-only panel
   * supplies the state used by resolveWorkspaceRouteStep below. */
  const provisionalKey: StepKey =
    chosen ?? routeRequest.step ?? defaultStep(preflightInput);
  const plan = useTailoringPlan(
    candidateId ?? 0,
    jobId,
    candidateId !== null && (provisionalKey === "studio" || provisionalKey === "results")
  );
  const quality = useQualityWorkflow(
    candidateId,
    jobId,
    provisionalKey === "results" || provisionalKey === "validation" || provisionalKey === "application",
    refreshKey
  );
  const qualityData = quality.state === "ready" ? quality.data : null;

  const workflowInput: WorkflowInput = useMemo(
    () => ({
      result: match.result,
      matchLoading: match.state === "loading" || match.state === "idle",
      resume,
      generatedFileCount: detail?.generatedFiles.length ?? 0,
      runStatuses: (runs ?? []).map((r) => r.status),
      humanMaySend: qualityData?.readiness?.humanMaySend ?? null,
    }),
    [match.result, match.state, resume, detail?.generatedFiles.length, runs, qualityData]
  );

  /* Explicit valid routes outrank the generic landing rule, but only after the current step model
   * proves the destination is reachable. A user's in-page choice then outranks the original URL. */
  const genericDefault = defaultStep(workflowInput);
  const provisionalSteps = resolveWorkflowSteps(workflowInput, provisionalKey);
  const active: StepKey = chosen ??
    (routeRequest.step
      ? resolveWorkspaceRouteStep(routeRequest.step, provisionalSteps, genericDefault)
      : genericDefault);
  const steps = resolveWorkflowSteps(workflowInput, active);
  const activeStep = steps.find((s) => s.key === active)!;
  const hero = useMemo(
    () =>
      workspaceHeroPresentation({
        matchDecision: match.result?.decision ?? null,
        resumeStage: resume?.key ?? null,
        qualityLoading: quality.state === "loading",
        readiness: qualityData?.readiness?.readiness ?? null,
        humanMaySend: qualityData?.readiness?.humanMaySend ?? null,
        canRevalidate: Boolean(
          qualityData?.revalidation?.isLegacyMissingAnalysis && qualityData.revalidation.canRevalidate
        ),
        runStatuses: (runs ?? []).map((run) => run.status),
        steps,
      }),
    [match.result?.decision, quality.state, qualityData, resume?.key, runs, steps]
  );

  /* The tailoring plan is Resume Studio's data and is requested only on that step. */

  const go = useCallback((key: StepKey) => setChosen(key), []);

  /* Focus is deliberately inert: it can only find an existing labelled target, scroll it into
   * view, and move keyboard focus. There is no click(), submit(), fetch(), or state transition in
   * this effect. Missing or incompatible focus values simply do nothing. */
  useEffect(() => {
    const requestedFocus = actionFocus ?? routeRequest.focus;
    if (!requestedFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const target = workspaceRef.current?.querySelector<HTMLElement>(
        `[data-workspace-focus~="${requestedFocus}"]`
      );
      if (!target) return;
      target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
      target.focus({ preventScroll: true });
      target.dataset.focusedFromRoute = "true";
    });
    return () => window.cancelAnimationFrame(frame);
  }, [actionFocus, active, quality.state, plan.state, reduced, routeRequest.focus]);

  /* The newest run for this job. The list is already ordered newest-first by the endpoint. */
  const latestRun = (runs ?? [])[0] ?? null;

  if (candidateId === null || (!detail && !failed)) {
    return <JobReviewSkeleton />;
  }

  if (!detail) {
    return (
      <div className="mx-auto w-full max-w-[1240px] py-6">
        <h1 className="text-[20px] font-bold text-primary">We couldn&apos;t load this job.</h1>
        <p className="mt-2 text-[13px] text-tertiary">
          The job may have been removed, or the request failed.{" "}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
          >
            Retry
          </button>
        </p>
      </div>
    );
  }

  const { job, generatedFiles } = detail;
  const result = match.result;

  /* Presentation over the authorities already loaded above. This button only navigates/focuses; it
   * never starts tailoring, validation or an application. */
  const primary = hero.action
    ? {
        label: hero.action.label,
        onClick: () => {
          setActionFocus(hero.action?.focus ?? null);
          go(hero.action!.step);
        },
      }
    : null;

  const rise = {
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    transition: reduced ? { duration: 0.12 } : ({ type: "spring", duration: 0.32, bounce: 0 } as const),
  };

  return (
    <div ref={workspaceRef} className="mx-auto flex w-full max-w-[var(--home-max-w)] flex-col gap-5 pb-8 pt-1">
      <JobIdentityHeader
        job={job}
        result={result}
        candidateId={candidateId}
        status={hero.status}
        primary={primary}
      />

      <WorkflowStepper steps={steps} active={active} onSelect={go} />

      {/* ── the active step, and only the active step ──────────────────────────────────────── */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={active} {...rise} className="min-w-0">
          {active === "match" && (
            <div className="flex flex-col gap-5">
              {!result ? (
                <WsCard title="Match">
                  <p className="text-[13px] leading-relaxed text-tertiary">
                    {match.state === "loading"
                      ? "Reading this posting's evaluation…"
                      : "This posting has not been evaluated against your profile yet."}
                  </p>
                  {match.state !== "loading" && (
                    <button
                      type="button"
                      onClick={match.evaluate}
                      className="mt-3 flex h-[42px] items-center rounded-[10px] bg-[var(--accent)] px-5 text-[13px] font-semibold text-[var(--accent-fg)] transition-colors duration-150 ease-out hover:bg-[var(--accent-hover)]"
                    >
                      Evaluate this job
                    </button>
                  )}
                </WsCard>
              ) : (
                <MatchStep result={result} />
              )}
            </div>
          )}

          {active === "studio" && (
            <div data-workspace-focus="tailor" tabIndex={-1} className="workspace-focus-target flex flex-col gap-5">
              {activeStep.state === "locked" || activeStep.state === "blocked" ? (
                <LockedStep title="Resume Studio" reason={activeStep.lockedReason} />
              ) : plan.state === "ready" ? (
                <>
                  <ResumeStudioStep plan={plan.plan} />
                  {/* Where the tailoring itself stands. Generation is NOT triggered from here:
                   *  approving a job and starting the writer both belong to the resume pipeline,
                   *  which enforces the one-writer-at-a-time rule. Offering a second button for the
                   *  same action is how two writers get started for one job. */}
                  <TailoringStudio
                    job={job}
                    match={match}
                    generatedFileCount={generatedFiles.length}
                    resume={resume}
                    onJumpToPipeline={() => go("validation")}
                  />
                </>
              ) : (
                <WsCard title="Resume studio">
                  <EmptyNote>
                    {plan.state === "loading"
                      ? "Reading this posting's plan…"
                      : plan.state === "not_evaluated"
                        ? "This posting has not been evaluated, so there is no plan to show."
                        : plan.state === "error"
                          ? "The tailoring plan could not be loaded."
                          : ""}
                  </EmptyNote>
                </WsCard>
              )}
            </div>
          )}

          {active === "results" && (
            <div className="flex flex-col gap-4">
              {activeStep.state === "locked" || activeStep.state === "blocked" ? (
                <LockedStep title="Tailoring Results" reason={activeStep.lockedReason} />
              ) : (
                <>
                  <TailoringResultsStep plan={plan.state === "ready" ? plan.plan : null} data={qualityData} />
                  {/* The controls that actually START tailoring live in ResumeQualityPipeline —
                   *  approve, retry the writer, re-tailor a terminal workflow. They were reachable
                   *  only from the Validation step, behind a closed disclosure, so arriving here
                   *  (which is the DEFAULT landing step — see defaultStep) offered no way to run
                   *  anything. Rendering the same component here, open, gives this step its actions
                   *  without a second implementation of the approval boundary. */}
                  <LazyDetails
                    defaultOpen={
                      routeRequest.focus === "retailor" ||
                      routeRequest.focus === "progress" ||
                      actionFocus === "retailor" ||
                      actionFocus === "progress"
                    }
                    data-workspace-focus="retailor progress"
                    className="premium-expansion workspace-focus-target group mt-4 rounded-[18px] border border-[var(--border)] bg-[var(--z3-bg)] p-4 shadow-[var(--shadow-row)]"
                    summary={
                      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-[13.5px] font-semibold text-[var(--accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
                        Resume actions and pipeline details
                        <span aria-hidden="true" className="text-[18px] transition-transform group-open:rotate-45">+</span>
                      </summary>
                    }
                  >
                    <div className="mt-4 border-t border-[var(--separator)] pt-4">
                      <ResumeQualityPipeline
                        jobId={jobId}
                        jobTitle={job.title}
                        companyName={job.company_name}
                        onStageChange={setResume}
                      />
                    </div>
                  </LazyDetails>
                </>
              )}
            </div>
          )}

          {active === "validation" && (
            <div
              data-workspace-focus="revalidate issues"
              tabIndex={-1}
              className="workspace-focus-target flex flex-col gap-5"
            >
              {activeStep.state === "locked" || activeStep.state === "blocked" ? (
                <LockedStep title="Validation" reason={activeStep.lockedReason} />
              ) : quality.state === "ready" ? (
                <>
                  <ValidationStep
                    data={quality.data}
                    candidateId={candidateId}
                    jobId={jobId}
                    onRevalidated={() => setRefreshKey((k) => k + 1)}
                  />
                  {/* The full record and its actions — approve, retry the writer, export — stay with
                   *  the component that owns them. It is behind a disclosure so the compact strip is
                   *  what the step opens on, and its own request is only made when opened. */}
                  <LazyDetails
                    className="premium-expansion group"
                    summary={
                      <summary className="flex min-h-11 cursor-pointer list-none items-center text-[12.5px] font-medium text-[var(--accent)] underline-offset-2 hover:underline">
                        Open the full resume pipeline
                      </summary>
                    }
                  >
                    <div className="mt-3">
                      <ResumeQualityPipeline
                        jobId={jobId}
                        jobTitle={job.title}
                        companyName={job.company_name}
                        onStageChange={setResume}
                      />
                    </div>
                  </LazyDetails>
                </>
              ) : (
                <WsCard title="Validation">
                  <EmptyNote>
                    {quality.state === "loading"
                      ? "Reading this resume's review…"
                      : quality.state === "none"
                        ? "No resume has been produced for this job yet, so there is nothing to validate."
                        : "The review could not be loaded."}
                  </EmptyNote>
                </WsCard>
              )}
            </div>
          )}

          {active === "application" && (
            <div className="flex flex-col gap-4">
              {activeStep.state === "locked" || activeStep.state === "blocked" ? (
                <LockedStep title="Application" reason={activeStep.lockedReason} />
              ) : latestRun ? (
                /* ── a run exists: the Command Center's own surface, in place ──────────────────
                 *
                 * THIS IS THE SAME COMPONENT /applications/[id] RENDERS. Not a copy of its markup
                 * and not a second reading of the run — the identical component, so there is
                 * exactly one mapping from run state to what a candidate is told, one intervention
                 * form, one final review and one approval path. A compact re-implementation here
                 * would have been a second answer to "is this application about to be submitted",
                 * which is the one question that must never have two.
                 *
                 * It is already phase-conditional: the question form appears only while the run is
                 * waiting for an answer, the review only when the engine has one to show, and the
                 * timeline only reports events that were actually recorded. */
                <div className="flex flex-col gap-3">
                  <div className={`${CARD} px-5 py-[18px]`}>
                    <ApplicationDetail runId={latestRun.id} embedded />
                  </div>
                  {/* Secondary, for anyone who wants the dedicated page. */}
                  <p className="text-[12.5px] text-tertiary">
                    <a
                      href={`/applications/${latestRun.id}`}
                      className="font-medium text-[var(--accent)] underline-offset-2 hover:underline"
                    >
                      Open full application
                    </a>{" "}
                    for the dedicated view.
                  </p>
                </div>
              ) : quality.state === "loading" ? (
                <WsCard title="Application">
                  <EmptyNote>Checking whether this resume is ready for an application…</EmptyNote>
                </WsCard>
              ) : (
                /* ── no run yet ─────────────────────────────────────────────────────────────── */
                <ApplicationReadyStep
                  job={job}
                  quality={qualityData}
                  onReviewIssues={() => {
                    setActionFocus("issues");
                    go("validation");
                  }}
                  startControl={<StartApplication candidateId={candidateId} jobId={jobId} />}
                />
              )}
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
