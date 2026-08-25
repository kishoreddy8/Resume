import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { shouldPollRunStatus } from "../runStatus";
import { WAITING_STATES, TERMINAL_STATES, type RunStatus } from "@/lib/apply/runState";

/**
 * UI-0 DEFECT 5 — the application detail page fetched its run once and never again, so a live
 * Workday automation could sign in, fill fields, hit a wall, or need answers with nothing on
 * screen reflecting it until a manual reload. `shouldPollRunStatus` is the pure decision this
 * fixes; it is derived from the engine's own WAITING_STATES/TERMINAL_STATES so it can never drift
 * from the real state machine as new statuses are added.
 */

const ALL_STATUSES: RunStatus[] = [
  "QUEUED",
  "STARTING",
  "NAVIGATING",
  "ACCOUNT_REQUIRED",
  "FILLING",
  "WAITING_FOR_ANSWER",
  "WAITING_FOR_CAPTCHA",
  "WAITING_FOR_MFA",
  "WAITING_FOR_EMAIL_VERIFICATION",
  "READY_FOR_REVIEW",
  "WAITING_FOR_SUBMIT_APPROVAL",
  "SUBMITTING",
  "SUBMITTED",
  "SUBMISSION_UNCONFIRMED",
  "FAILED",
  "CANCELLED",
];

test("APPLICATION-POLL-01: actively-executing states poll (QUEUED, STARTING, NAVIGATING, FILLING, SUBMITTING)", () => {
  for (const status of ["QUEUED", "STARTING", "NAVIGATING", "FILLING", "SUBMITTING"] as const) {
    assert.equal(shouldPollRunStatus(status), true, `${status} must poll — it can change without any click on this page`);
  }
});

test("APPLICATION-POLL-02: terminal runs never poll (SUBMITTED, FAILED, and every other terminal state)", () => {
  for (const status of TERMINAL_STATES) {
    assert.equal(shouldPollRunStatus(status), false, `${status} is terminal and must never poll`);
  }
});

test("waiting-on-the-user states do not poll — the same in-page action that resolves them already reloads", () => {
  for (const status of WAITING_STATES) {
    assert.equal(shouldPollRunStatus(status), false, `${status} is resolved by an explicit in-page action, not by polling`);
  }
  /* Specifically called out by the task as a state that must not aggressively poll. */
  assert.equal(shouldPollRunStatus("READY_FOR_REVIEW"), false);
});

test("every RunStatus is classified as exactly one of poll / wait / terminal — nothing is silently uncovered", () => {
  for (const status of ALL_STATUSES) {
    const polls = shouldPollRunStatus(status);
    const waits = WAITING_STATES.includes(status);
    const terminal = TERMINAL_STATES.includes(status);
    assert.equal(waits && terminal, false, `${status} cannot be both waiting and terminal`);
    assert.equal(polls, !waits && !terminal, `${status}: shouldPollRunStatus disagrees with the engine's own state lists`);
  }
});

test("APPLICATION-POLL-03/04/05: the effect is interval-based, visibility-guarded, cleans up, and is gated on shouldPollRunStatus (single source, no duplicate loop)", () => {
  const source = fs.readFileSync("src/app/applications/[id]/ApplicationDetail.tsx", "utf8");

  /* Exactly one polling effect exists — a second competing interval would be a duplicate loop. */
  const setIntervalCount = (source.match(/setInterval\(/g) ?? []).length;
  assert.equal(setIntervalCount, 1, "exactly one setInterval call site must exist on this page");

  assert.match(source, /if \(!runStatus \|\| !shouldPollRunStatus\(runStatus\)\) return;/, "polling is gated on the pure decision, not re-implemented inline");
  assert.match(source, /document\.visibilityState === "visible"/, "reuses the existing visibility-guarded convention (see admin/page.tsx)");
  assert.match(source, /return \(\) => clearInterval\(timer\);/, "the interval is cleared in the effect's cleanup — on unmount AND before every re-run");
  assert.match(source, /useEffect\(\(\) => \{\s*if \(!runStatus/, "the polling effect is a real useEffect, not a bare setInterval call");
});

test("no new polling library was introduced — setInterval/clearInterval only", () => {
  const packageJson = fs.readFileSync("package.json", "utf8");
  assert.doesNotMatch(packageJson, /"swr"|"react-query"|"@tanstack\/react-query"/, "no polling/data-fetching library was added for this fix");
});
