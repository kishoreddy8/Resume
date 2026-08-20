/**
 * Tracks profile builds so they outlive the page that started them.
 *
 * WHY. The build takes about two minutes and was driven entirely by a client fetch: navigate away
 * and the browser forgot it was happening, while the server kept going. Worse, nothing stopped a
 * second click from spawning a second CLI process — two billed runs racing to write the same
 * candidate-profile.json, with the loser's output silently overwriting the winner's.
 *
 * State lives in module memory. That is the right scope for this app — one local Next server, one
 * user — and deliberately not the database: a build is in-flight work, not a fact about the
 * candidate, and a server restart genuinely does end it. Anything that must survive a restart is
 * already on disk in the profile itself.
 */

import type { BuildPhase } from "./invoker";

export type BuildStatus = "running" | "done" | "failed";

/**
 * Why a build ended, as a code rather than prose.
 *
 * The UI maps these to an explanation, what is still safe, and a next action. Passing a code
 * instead of a sentence keeps that mapping in one place and stops raw CLI output — which can be a
 * stack trace — from reaching a user-facing screen.
 */
export type BuildFailureCode =
  | "cli_disabled"
  | "cli_unavailable"
  | "cli_timeout"
  | "cli_error"
  | "documents_missing"
  | "documents_unreadable"
  | "validation_failed"
  | "unexpected";

/** Human-facing wording for each observed phase. Present tense: it is happening right now. */
export const PHASE_LABEL: Record<BuildPhase, string> = {
  extracting: "Reading your uploaded documents",
  reading_resume: "Reading your resume",
  reading_skills: "Reading your skills inventory",
  writing: "Writing your profile",
  validating: "Checking the profile is valid",
};

export interface BuildState {
  status: BuildStatus;
  /**
   * Phases in the order they were ACTUALLY observed, deduped.
   *
   * Not a monotonic "furthest reached" counter, which is what this was first written as. Nothing
   * tells the CLI to read the resume before the skills inventory, so a run that happened to read
   * them the other way round had a genuine observation silently discarded for being "backwards",
   * and the UI showed a finished step as pending. An arrival-ordered list cannot lie that way:
   * every entry is something that demonstrably happened.
   */
  observed: BuildPhase[];
  startedAt: number;
  finishedAt?: number;
  /** Present only on failure. */
  failure?: { code: BuildFailureCode; detail: string };
  /** Present only on success — real counts read from the validated profile, never estimated. */
  summary?: { skills: number; experience: number; certifications: number };
}

const builds = new Map<number, BuildState>();

/** A finished build stops being interesting once the UI has had a chance to see it. */
const KEEP_FINISHED_MS = 5 * 60 * 1000;

export function getBuildState(candidateId: number): BuildState | null {
  const state = builds.get(candidateId);
  if (!state) return null;
  if (state.status !== "running" && state.finishedAt && Date.now() - state.finishedAt > KEEP_FINISHED_MS) {
    builds.delete(candidateId);
    return null;
  }
  return state;
}

export function isBuilding(candidateId: number): boolean {
  return getBuildState(candidateId)?.status === "running";
}

/** Returns false when a build is already in flight — the caller must not start a second one. */
export function beginBuild(candidateId: number): boolean {
  if (isBuilding(candidateId)) return false;
  builds.set(candidateId, { status: "running", observed: [], startedAt: Date.now() });
  return true;
}

/** Record that a phase actually happened. Repeats are ignored; nothing is ever un-recorded. */
export function reportPhase(candidateId: number, phase: BuildPhase): void {
  const state = builds.get(candidateId);
  if (!state || state.status !== "running") return;
  if (state.observed.includes(phase)) return;
  state.observed.push(phase);
}

export function finishBuild(
  candidateId: number,
  outcome:
    | { ok: true; summary: BuildState["summary"] }
    | { ok: false; code: BuildFailureCode; detail: string }
): void {
  const previous = builds.get(candidateId);
  const startedAt = previous?.startedAt ?? Date.now();
  const observed = previous?.observed ?? [];
  builds.set(
    candidateId,
    outcome.ok
      ? { status: "done", observed, startedAt, finishedAt: Date.now(), summary: outcome.summary }
      : {
          status: "failed",
          observed,
          startedAt,
          finishedAt: Date.now(),
          failure: { code: outcome.code, detail: outcome.detail },
        }
  );
}

export function listRunning(): { candidateId: number; startedAt: number }[] {
  const out: { candidateId: number; startedAt: number }[] = [];
  for (const [candidateId, state] of builds) {
    if (state.status === "running") out.push({ candidateId, startedAt: state.startedAt });
  }
  return out;
}
