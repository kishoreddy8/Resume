import type { Stage, StageState } from "./BuildStageRail";

/**
 * The mapping from every visible build stage to the operation that proves it happened.
 *
 * This file is the answer to "is that label telling the truth?". A stage may appear here only if
 * something in the system actually reports it. Three candidate stages were considered and left out
 * for failing that test:
 *
 *   - "Connecting to Claude"    nothing observes a connection; the CLI is a subprocess that either
 *                               starts or does not. A spawn is not a session.
 *   - "Analyzing your skills"   the CLI does not report reasoning steps, only tool calls. There is
 *                               no event behind this sentence.
 *   - "Almost done"             a claim about remaining time, which nothing can support.
 *
 * SOURCE TABLE
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *  Setup saved            client        the PATCH calls in saveAll() returned ok
 *  Documents extracted    server phase  `extracting` — jszip finished writing the .txt sidecars
 *  Resume read            server phase  `reading_resume` — CLI issued Read on .extracted-resume.txt
 *  Skills inventory read  server phase  `reading_skills` — CLI issued Read on .extracted-skills.txt
 *  Intelligence written   server phase  `writing` — CLI issued Write
 *  Evidence validated     server phase  `validating` + build status `done` — loadCandidateProfile
 *                                       accepted the file against the matching engine's own schema
 *  Jobs evaluated         client+API    rematch cursor's pairsAttempted, then setup.steps.evaluated
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The CLI phases arrive from --output-format stream-json as tool-use events, recorded in the order
 * they actually occurred. Read order is NOT assumed: nothing instructs the CLI to open the resume
 * before the skills inventory, so each is marked independently by its own event.
 */

export type BuildStatus = "idle" | "running" | "done" | "failed";

export interface StageInputs {
  /** True once the setup PATCH calls have succeeded at least once this session. */
  saved: boolean;
  /** Both master documents present on the server. Separate from `saved` on purpose — see below. */
  documentsPresent: boolean;
  status: BuildStatus;
  /** Phase keys the server actually observed, in arrival order. */
  observed: string[];
  failureCode: string | null;
  /** Client-side evaluation progress; pairs attempted so far. */
  evaluating: boolean;
  evaluatedCount: number;
  /** From the setup endpoint — whether any job has been scored for this candidate. */
  hasEvaluated: boolean;
}

/** A CLI stage: done if its event was seen, active if it is the most recent, else pending. */
function cliStage(key: string, label: string, phase: string, i: StageInputs): Stage {
  const seen = i.observed.includes(phase);
  const isLatest = i.observed.at(-1) === phase;

  let state: StageState;
  if (i.status === "done") state = seen ? "done" : "skipped";
  else if (i.status === "failed") state = isLatest ? "failed" : seen ? "done" : "pending";
  else if (!seen) state = "pending";
  else state = isLatest ? "active" : "done";

  return { key, label, state };
}

export function buildStages(i: StageInputs): Stage[] {
  const stages: Stage[] = [
    {
      key: "saved",
      label: "Setup saved",
      state: i.saved || i.status === "running" ? "done" : "pending",
      /* Two facts, reported separately. Saying "details and documents are stored" off the back of
       * a successful settings PATCH claimed something the PATCH does not prove — the documents are
       * uploaded by a different call entirely, and could be absent while the details saved fine. */
      detail: !i.saved
        ? undefined
        : i.documentsPresent
          ? "Your details are stored, and both documents are uploaded."
          : "Your details are stored.",
    },
    cliStage("extracting", "Documents read", "extracting", i),
    cliStage("reading_resume", "Master Resume read by Claude", "reading_resume", i),
    cliStage("reading_skills", "Skills Inventory read by Claude", "reading_skills", i),
    cliStage("writing", "Candidate Intelligence written", "writing", i),
  ];

  /* Validation is its own row because it is the step that decides whether ANY of the above is
   * kept. It is marked done only when the loader accepted the file, never when the CLI merely
   * finished writing one. */
  stages.push({
    key: "validating",
    label: "Evidence validated",
    state:
      i.status === "done"
        ? "done"
        : i.failureCode === "validation_failed"
          ? "failed"
          : i.status === "failed"
            ? "pending"
            : i.observed.includes("validating")
              ? "active"
              : "pending",
    detail:
      i.status === "done"
        ? "Checked against the same schema the matching engine uses."
        : i.failureCode === "validation_failed"
          ? "The generated profile was rejected and discarded."
          : undefined,
  });

  stages.push({
    key: "evaluation",
    label: "Jobs evaluated",
    state: i.hasEvaluated
      ? "done"
      : i.evaluating
        ? "active"
        : i.status === "failed"
          ? "pending"
          : "pending",
    detail:
      i.evaluating && i.evaluatedCount > 0
        ? `${i.evaluatedCount.toLocaleString()} scored so far`
        : i.hasEvaluated
          ? "Your recommendations are ready."
          : undefined,
  });

  return stages;
}

/**
 * What each failure means, what is still safe, and what to do next.
 *
 * Raw CLI output never reaches this screen — it can be a stack trace, and a stack trace is not a
 * next action. The server sends a code; this turns it into something a person can act on.
 */
export interface FailureGuidance {
  title: string;
  /** What actually went wrong, in plain words. */
  what: string;
  /** What is still intact. Always stated, because the first fear is "did I just lose my data?". */
  safe: string;
  /** The single most useful next step. */
  next: string;
  /** Whether the manual Claude Code command is worth offering for this failure. */
  offerManual: boolean;
}

const PROFILE_SAFE =
  "Nothing was overwritten. Your uploaded documents and any previous profile are exactly as they were.";

export const FAILURE_GUIDANCE: Record<string, FailureGuidance> = {
  cli_disabled: {
    title: "Automatic building is switched off here",
    what: "This environment sets CAREER_OPS_DISABLE_REAL_CLAUDE_CLI, which blocks the app from starting the Claude CLI.",
    safe: PROFILE_SAFE,
    next: "Unset that variable and restart the server, or build the profile yourself in Claude Code.",
    offerManual: true,
  },
  cli_unavailable: {
    title: "The Claude CLI could not be started",
    what: "The `claude` command was not found on this machine, or it failed to launch.",
    safe: PROFILE_SAFE,
    next: "Install the Claude CLI and make sure `claude` runs in your terminal, then try again.",
    offerManual: false,
  },
  cli_timeout: {
    title: "The build ran out of time",
    what: "Claude was still working when the time limit was reached, so the run was stopped.",
    safe: PROFILE_SAFE,
    next: "Try again — builds usually finish in about two minutes. If it times out repeatedly, run it in Claude Code where there is no limit.",
    offerManual: true,
  },
  cli_error: {
    title: "Claude stopped before finishing",
    what: "The CLI exited without producing a profile.",
    safe: PROFILE_SAFE,
    next: "Try again. If it keeps happening, run the command in Claude Code — you will see the full output there.",
    offerManual: true,
  },
  documents_missing: {
    title: "A document is missing",
    what: "Both the Master Resume and the Master Skills Inventory must be uploaded before a profile can be built.",
    safe: "Anything you have already uploaded is still stored.",
    next: "Upload the missing document above, then build again.",
    offerManual: false,
  },
  documents_unreadable: {
    title: "A document could not be read",
    what: "One of your uploaded files could not be opened as a document.",
    safe: PROFILE_SAFE,
    next: "Re-upload it as a .docx, .md or .txt file. A file renamed to .docx without being one will fail here.",
    offerManual: false,
  },
  validation_failed: {
    title: "The generated profile was rejected",
    what:
      "Claude produced a profile, but it did not pass the same validation the matching engine uses — so it was discarded rather than trusted.",
    safe:
      "It was never used. Your previous profile, if you had one, was restored untouched, and no job was evaluated against the rejected file.",
    next: "Try again. If it fails a second time, run the build in Claude Code to see what the profile was missing.",
    offerManual: true,
  },
  unexpected: {
    title: "The build failed unexpectedly",
    what: "Something went wrong that the app does not have a specific explanation for.",
    safe: PROFILE_SAFE,
    next: "Try again, or run the build in Claude Code.",
    offerManual: true,
  },
};

/** One-line version of the matrix above, for surfaces with no room for the full explanation. */
export function shortFailure(code: string | null): string {
  if (!code) return "The profile build did not complete.";
  const g = FAILURE_GUIDANCE[code] ?? FAILURE_GUIDANCE.unexpected;
  return `${g.title}. ${g.next}`;
}
