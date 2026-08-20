import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunStatus } from "../runState";

/** Notifications must be real events only, deduped per state, and never call a pause a failure. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-notify-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";

/* eslint-disable @typescript-eslint/no-require-imports */
const { notifyApplicationState } = require("../applicationNotifications") as typeof import("../applicationNotifications");
const { listNotificationsForCandidate } = require("@/db/queries/notifications") as typeof import("@/db/queries/notifications");

const run = (id: number, status: RunStatus, question: string | null = null) => ({
  id,
  candidate_id: 1,
  status,
  blocking_question: question,
});

test("NOTIFY-1 a waiting run notifies, and says what it needs", () => {
  assert.equal(notifyApplicationState(run(1, "WAITING_FOR_CAPTCHA"), "Data Engineer", "Acme"), true);
  const n = listNotificationsForCandidate(1).find((x) => x.dedupe_key === "application-run:1:WAITING_FOR_CAPTCHA");
  assert.ok(n);
  assert.match(n!.title, /CAPTCHA/i);
  assert.match(n!.body, /Data Engineer at Acme/);
});

test("NOTIFY-2 the same pause on the same run does not notify twice", () => {
  assert.equal(notifyApplicationState(run(1, "WAITING_FOR_CAPTCHA"), "Data Engineer", "Acme"), false);
  const count = listNotificationsForCandidate(1).filter((x) => x.dedupe_key === "application-run:1:WAITING_FOR_CAPTCHA").length;
  assert.equal(count, 1);
});

test("NOTIFY-3 a genuinely new state on the same run does notify", () => {
  assert.equal(notifyApplicationState(run(1, "READY_FOR_REVIEW"), "Data Engineer", "Acme"), true);
});

test("NOTIFY-4 transient states never interrupt anyone", () => {
  for (const s of ["QUEUED", "STARTING", "NAVIGATING", "FILLING", "SUBMITTING", "CANCELLED"] as RunStatus[]) {
    assert.equal(notifyApplicationState(run(2, s), "Data Engineer", "Acme"), false, `${s} must not notify`);
  }
});

test("NOTIFY-5 a waiting run is never described as a failure", () => {
  for (const s of ["WAITING_FOR_ANSWER", "WAITING_FOR_MFA", "WAITING_FOR_EMAIL_VERIFICATION", "ACCOUNT_REQUIRED", "READY_FOR_REVIEW"] as RunStatus[]) {
    notifyApplicationState(run(3, s, "Desired salary?"), "Data Engineer", "Acme");
  }
  for (const n of listNotificationsForCandidate(1).filter((x) => x.dedupe_key.startsWith("application-run:3:"))) {
    assert.doesNotMatch(`${n.title} ${n.body}`, /\bfail|\berror\b|broken/i, `"${n.title}" reads as a fault`);
  }
});

test("NOTIFY-6 an unconfirmed submission asks the user to check, and never claims success", () => {
  notifyApplicationState(run(4, "SUBMISSION_UNCONFIRMED"), "Data Engineer", "Acme");
  const n = listNotificationsForCandidate(1).find((x) => x.dedupe_key === "application-run:4:SUBMISSION_UNCONFIRMED");
  assert.ok(n);
  assert.match(n!.body, /did not confirm|please check/i);
  assert.doesNotMatch(n!.title, /^Application submitted$/, "it must not read as a confirmed submission");
});

test("NOTIFY-7 a question is quoted verbatim, never paraphrased", () => {
  const question = "Are you willing to relocate to Zürich?";
  notifyApplicationState(run(5, "WAITING_FOR_ANSWER", question), "Data Engineer", "Acme");
  const n = listNotificationsForCandidate(1).find((x) => x.dedupe_key === "application-run:5:WAITING_FOR_ANSWER");
  assert.ok(n!.body.includes(question), "the user must see what was actually asked");
});
