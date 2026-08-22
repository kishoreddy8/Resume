import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunStatus } from "@/lib/apply/runState";
import {
  APPLICATION_GROUPS,
  applicationContext,
  detailPhase,
  groupForStatus,
  primaryActionLabel,
} from "../grouping";
import { STATUS_PRESENTATION, presentStatus } from "../runStatus";

const here = fileURLToPath(new URL("..", import.meta.url));
const listSource = readFileSync(`${here}/page.tsx`, "utf8");
const detailSource = readFileSync(`${here}/[id]/ApplicationDetail.tsx`, "utf8");
const workspaceSource = readFileSync(`${here}/../jobs/[id]/JobWorkspace.tsx`, "utf8");
const apiSource = readFileSync(`${here}/../api/candidates/[candidateId]/application-runs/route.ts`, "utf8");

const statuses = Object.keys(STATUS_PRESENTATION) as RunStatus[];

test("APPS-1 lifecycle summary and tabs use the four approved candidate groups", () => {
  assert.deepEqual(
    APPLICATION_GROUPS.map(({ id, cardLabel }) => [id, cardLabel]),
    [
      ["needs-action", "Needs your action"],
      ["in-progress", "In progress"],
      ["submitted", "Submitted"],
      ["completed", "Completed"],
    ],
  );
  assert.match(listSource, /role="tablist"/);
});

test("APPS-2 waiting and unconfirmed runs require candidate action", () => {
  for (const status of [
    "ACCOUNT_REQUIRED",
    "WAITING_FOR_ANSWER",
    "WAITING_FOR_CAPTCHA",
    "WAITING_FOR_MFA",
    "WAITING_FOR_EMAIL_VERIFICATION",
    "READY_FOR_REVIEW",
    "WAITING_FOR_SUBMIT_APPROVAL",
    "SUBMISSION_UNCONFIRMED",
  ] as RunStatus[]) {
    assert.equal(groupForStatus(status), "needs-action", status);
  }
});

test("APPS-3 active automation remains in progress", () => {
  for (const status of ["QUEUED", "STARTING", "NAVIGATING", "FILLING", "SUBMITTING"] as RunStatus[]) {
    assert.equal(groupForStatus(status), "in-progress", status);
  }
});

test("APPS-4 only a confirmed submission is grouped as submitted", () => {
  assert.equal(groupForStatus("SUBMITTED"), "submitted");
  assert.notEqual(groupForStatus("SUBMISSION_UNCONFIRMED"), "submitted");
});

test("APPS-5 stopped and cancelled histories are completed without success wording", () => {
  assert.equal(groupForStatus("FAILED"), "completed");
  assert.equal(groupForStatus("CANCELLED"), "completed");
  assert.equal(presentStatus("FAILED").label, "Stopped");
  assert.equal(presentStatus("CANCELLED").label, "Cancelled");
});

test("APPS-6 tracked opportunities do not inflate application-run summaries", () => {
  assert.doesNotMatch(listSource, /ApplicationList|Tracked by you|candidate-jobs/);
  assert.match(listSource, /for \(const run of runs \?\? \[\]\)/);
  assert.match(listSource, /all: runs\?\.length \?\? 0/);
});

test("APPS-7 each application row exposes one primary lifecycle destination", () => {
  const card = listSource.slice(listSource.indexOf("function ApplicationCard"));
  assert.equal((card.match(/href=\{`\/applications\/\$\{run\.id\}`\}/g) ?? []).length, 1);
  assert.match(card, /primaryActionLabel\(run\.status\)/);
});

test("APPS-8 confirmed and unconfirmed submission copy remains distinct", () => {
  assert.equal(presentStatus("SUBMITTED").label, "Submitted");
  assert.equal(presentStatus("SUBMISSION_UNCONFIRMED").label, "Submission unconfirmed");
  assert.match(applicationContext("SUBMITTED", null), /confirmed/i);
  assert.match(applicationContext("SUBMISSION_UNCONFIRMED", null), /could not confirm/i);
});

test("APPS-9 final review makes approval explicit and keeps the approved run id", () => {
  assert.match(detailSource, /Nothing will be submitted until you approve this application\./);
  assert.match(detailSource, /action: "submit", runId: run\.id, approvedRunId: run\.id/);
  assert.match(detailSource, /disabled=\{busy !== null \|\| !review\.canApprove\}/);
});

test("APPS-10 verification is manual and resumes only after the candidate acts", () => {
  assert.match(detailSource, /will not solve CAPTCHA, MFA, or email verification for you/);
  assert.match(detailSource, /action: "resume", runId: run\.id/);
  assert.equal(detailPhase("ACCOUNT_REQUIRED"), "verification");
  assert.equal(detailPhase("WAITING_FOR_MFA"), "verification");
});

test("APPS-11 every known status has candidate wording and unknown enums stay hidden", () => {
  for (const status of statuses) {
    assert.doesNotMatch(presentStatus(status).label, /^[A-Z]+(?:_[A-Z]+)+$/, status);
  }
  assert.equal(presentStatus("FUTURE_ENGINE_STATE").label, "Status updated");
  assert.doesNotMatch(detailSource, /event_type\.replace|run\.status\.replace/);
});

test("APPS-12 list loading is bounded and does not fetch timeline or review detail per row", () => {
  assert.equal((listSource.match(/fetch\(/g) ?? []).length, 1);
  assert.match(listSource, /scope=all&limit=100/);
  assert.doesNotMatch(listSource, /runId=|body\.events|body\.review/);
  assert.match(apiSource, /searchParams\.get\("scope"\) === "all"/);
  assert.match(apiSource, /listRuns\(candidateId, limit\)/);
  assert.match(apiSource, /Math\.min\([\s\S]*?, 200\)/);
});

test("APPS-13 the zero-run state has one dominant rendered Browse jobs action", () => {
  assert.match(listSource, /actions=\{runs\.length > 0 \?/);
  const emptyBranch = listSource.slice(listSource.indexOf("runs.length === 0"), listSource.indexOf(": (", listSource.indexOf("runs.length === 0")));
  assert.equal((emptyBranch.match(/Browse jobs/g) ?? []).length, 1);
  assert.match(emptyBranch, /Nothing is submitted without your approval/);
});

test("APPS-14 Job Workspace embeds the same authoritative ApplicationDetail", () => {
  assert.match(workspaceSource, /import \{ ApplicationDetail \} from "@\/app\/applications\/\[id\]\/ApplicationDetail"/);
  assert.match(workspaceSource, /<ApplicationDetail runId=\{latestRun\.id\} embedded \/>/);
});

test("APPS-15 row action stays reachable and touch-sized on mobile", () => {
  const card = listSource.slice(listSource.indexOf("function ApplicationCard"));
  assert.match(card, /min-h-11 w-full text-\[14px\] lg:w-auto/);
});

test("APPS-16 detail phases stay presentation-only and cover the lifecycle", () => {
  assert.equal(detailPhase("QUEUED"), "preparing");
  assert.equal(detailPhase("FILLING"), "filling");
  assert.equal(detailPhase("WAITING_FOR_ANSWER"), "needs-input");
  assert.equal(detailPhase("READY_FOR_REVIEW"), "review");
  assert.equal(detailPhase("SUBMITTING"), "submitting");
  assert.equal(detailPhase("SUBMITTED"), "tracking");
});

test("APPS-17 action labels describe only actions available on detail", () => {
  assert.equal(primaryActionLabel("WAITING_FOR_ANSWER"), "Continue");
  assert.equal(primaryActionLabel("WAITING_FOR_CAPTCHA"), "Complete verification");
  assert.equal(primaryActionLabel("WAITING_FOR_SUBMIT_APPROVAL"), "Review & approve");
  assert.equal(primaryActionLabel("SUBMITTED"), "View submission");
  assert.equal(primaryActionLabel("FAILED"), "View history");
});
