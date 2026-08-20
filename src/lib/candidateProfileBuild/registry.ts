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

/** Human-facing wording for each observed phase. Present tense: it is happening right now. */
export const PHASE_LABEL: Record<BuildPhase, string> = {
  extracting: "Reading your uploaded documents",
  reading_resume: "Reading your resume",
  reading_skills: "Reading your skills inventory",
  writing: "Writing your profile",
  validating: "Checking the profile is valid",
};

/** Declared order, used only to stop a late-arriving event from moving the display backwards. */
const PHASE_ORDER: BuildPhase[] = ["extracting", "reading_resume", "reading_skills", "writing", "validating"];

export interface BuildState {
  status: BuildStatus;
  /** The furthest phase actually observed. Null until the first one is reported. */
  phase: BuildPhase | null;
  startedAt: number;
  finishedAt?: number;
  /** Present only on failure — the message the UI should show. */
  error?: string;
  /** Present only on success, for a summary without re-reading the profile. */
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
  builds.set(candidateId, { status: "running", phase: null, startedAt: Date.now() });
  return true;
}

/**
 * Record an observed phase. Monotonic: a phase earlier than the one already recorded is ignored,
 * so an out-of-order or repeated event can never make the display appear to go backwards.
 */
export function reportPhase(candidateId: number, phase: BuildPhase): void {
  const state = builds.get(candidateId);
  if (!state || state.status !== "running") return;
  const current = state.phase ? PHASE_ORDER.indexOf(state.phase) : -1;
  if (PHASE_ORDER.indexOf(phase) <= current) return;
  state.phase = phase;
}

export function finishBuild(
  candidateId: number,
  outcome: { ok: true; summary: BuildState["summary"] } | { ok: false; error: string }
): void {
  const startedAt = builds.get(candidateId)?.startedAt ?? Date.now();
  builds.set(
    candidateId,
    outcome.ok
      ? { status: "done", phase: null, startedAt, finishedAt: Date.now(), summary: outcome.summary }
      : { status: "failed", phase: builds.get(candidateId)?.phase ?? null, startedAt, finishedAt: Date.now(), error: outcome.error }
  );
}

/** Any candidate currently building — the global status strip needs this without knowing who. */
export function listRunning(): { candidateId: number; startedAt: number }[] {
  const out: { candidateId: number; startedAt: number }[] = [];
  for (const [candidateId, state] of builds) {
    if (state.status === "running") out.push({ candidateId, startedAt: state.startedAt });
  }
  return out;
}
