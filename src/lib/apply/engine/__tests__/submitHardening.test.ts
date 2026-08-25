import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mockAtsUrl } from "./mockAts/paths";
import { credentialReferenceForIdentity, type AtsAccountIdentity, type CredentialStore } from "@/lib/apply/credentials";
import { deriveTenantKey } from "@/lib/apply/auth";
import type { AtsAdapter } from "@/lib/apply/agent/types";
import type { ExecutionCheckpoint } from "../executor";
import type { FinalReview } from "@/lib/apply/finalReview";

/**
 * PHASE 9D — approveAndSubmit hardening: re-authentication before refill, and new-question
 * detection after it. Local mock fixtures only; every "Submit Application" control mutates its own
 * page into a confirmation on click, so a wrong click is directly observable.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-submit-hardening-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { approveAndSubmit } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: null as string | null,
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");

const runtime = new ApplicationBrowserRuntime();

class FakeCredentialStore implements CredentialStore {
  private map = new Map<string, string>();
  private key(identity: AtsAccountIdentity) {
    return credentialReferenceForIdentity(identity);
  }
  async getCredential(identity: AtsAccountIdentity) {
    return this.map.get(this.key(identity)) ?? null;
  }
  async saveCredential(identity: AtsAccountIdentity, secret: string) {
    this.map.set(this.key(identity), secret);
  }
  async deleteCredential(identity: AtsAccountIdentity) {
    this.map.delete(this.key(identity));
  }
  async exists(identity: AtsAccountIdentity) {
    return this.map.has(this.key(identity));
  }
  seed(identity: AtsAccountIdentity, secret: string) {
    this.map.set(this.key(identity), secret);
  }
}

const SIMPLE_REVIEW: FinalReview = {
  company: "Mockcorp",
  role: "Engineer",
  ats: "greenhouse",
  resumeFile: CONTEXT.resumePath,
  coverLetterFile: null,
  answers: [
    { question: "First Name", value: "Jordan", source: "PROFILE" },
    { question: "Last Name", value: "Rivera", source: "PROFILE" },
    { question: "Email", value: "jordan@example.test", source: "PROFILE" },
    { question: "Phone", value: "(214) 555-0100", source: "PROFILE" },
  ],
  documents: [],
  unresolved: [],
  warnings: [],
  canApprove: true,
};

const SIMPLE_COMPLETED: ExecutionCheckpoint["completed"] = [
  { selector: "#first_name", canonicalKey: "first_name", source: "PROFILE", kind: "fill" },
  { selector: "#last_name", canonicalKey: "last_name", source: "PROFILE", kind: "fill" },
  { selector: "#email", canonicalKey: "email", source: "PROFILE", kind: "fill" },
  { selector: "#phone", canonicalKey: "phone", source: "PROFILE", kind: "fill" },
];

function newApprovedRun(applyUrl: string) {
  const run = runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `mock-submit-hardening-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: null,
  });
  const checkpoint: ExecutionCheckpoint = {
    url: applyUrl,
    ats: "greenhouse",
    step: "review",
    completed: SIMPLE_COMPLETED,
    review: SIMPLE_REVIEW,
    lastAction: "application filled; review built",
  };
  runsDb.updateCheckpoint(run.id, checkpoint);
  runsDb.advanceRun(run.id, "STARTING");
  runsDb.advanceRun(run.id, "NAVIGATING");
  runsDb.advanceRun(run.id, "FILLING");
  runsDb.advanceRun(run.id, "READY_FOR_REVIEW");
  return run;
}

function deps() {
  return {
    context: CONTEXT,
    knownVariants: new Map(),
    storedAnswers: new Map(),
  } as Parameters<typeof approveAndSubmit>[3] extends { deps?: infer D } ? D : never;
}

test.after(async () => {
  await runtime.close();
});

test("SUBMIT-03/05a: an expired session detected at submit time re-authenticates, then submission proceeds normally", async () => {
  const url = mockAtsUrl("mock-submit-reauth");
  const store = new FakeCredentialStore();
  const identity: AtsAccountIdentity = { userId: "1", ats: "greenhouse", tenant: deriveTenantKey(url), email: CONTEXT.contact.email };
  store.seed(identity, "StoredTestPass!2024XY");
  const run = newApprovedRun(url);

  const adapter: AtsAdapter = {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    auth: () => ({
      mode: "LOGIN_ONLY",
      emailSelector: "#auth_email",
      passwordSelector: "#auth_password",
      signInSelector: "#signin",
      authenticatedMarkers: ["welcome back"],
    }),
  };

  const after = await approveAndSubmit(run.id, runtime, { runId: run.id }, { adapter, credentialStore: store, deps: deps() });
  assert.equal(after.status, "SUBMITTED", `expected re-auth then successful submit, got ${after.status}`);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("login_started"));
  assert.ok(events.includes("login_succeeded"));
});

test("SUBMIT-05b: an unresolvable auth state (MFA) at submit time aborts BEFORE refill or submit — never clicks Submit", async () => {
  const url = mockAtsUrl("mock-auth-mfa"); // reused from Phase 9C: correct login -> MFA prompt
  const store = new FakeCredentialStore();
  const identity: AtsAccountIdentity = { userId: "1", ats: "greenhouse", tenant: deriveTenantKey(url), email: CONTEXT.contact.email };
  store.seed(identity, "StoredTestPass!2024XY");
  const run = newApprovedRun(url);

  const adapter: AtsAdapter = {
    sourceType: "greenhouse",
    fieldSelectorHints: () => ({}),
    auth: () => ({
      mode: "LOGIN_ONLY",
      emailSelector: "#auth_email",
      passwordSelector: "#auth_password",
      signInSelector: "#signin",
      authenticatedMarkers: ["welcome back"],
    }),
  };

  const after = await approveAndSubmit(run.id, runtime, { runId: run.id }, { adapter, credentialStore: store, deps: deps() });
  assert.equal(after.status, "WAITING_FOR_MFA", `expected the run to pause for MFA, got ${after.status}`);
  assert.equal(after.submitted_at, null);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(!events.includes("submit_attempted"), "submission must never be attempted while auth is unresolved");
});

test("SUBMIT-04: a new required question discovered at submit time cancels submission and returns WAITING_FOR_ANSWER", async () => {
  const url = mockAtsUrl("mock-submit-new-question");
  const run = newApprovedRun(url);

  const after = await approveAndSubmit(run.id, runtime, { runId: run.id }, { deps: deps() });
  assert.equal(after.status, "WAITING_FOR_ANSWER", `expected the new question to cancel submission, got ${after.status}`);
  assert.equal(after.submitted_at, null);
  assert.match(after.blocking_question ?? "", /favorite color/i);
  const events = runsDb.listEvents(run.id).map((e) => e.event_type);
  assert.ok(events.includes("submit_preflight_new_question"));
  assert.ok(!events.includes("submit_attempted"), "the page's Submit Application control must never be clicked");
  const checkpoint = JSON.parse(after.checkpoint_json!);
  assert.ok(checkpoint.humanQuestions?.some((q: { label: string }) => /favorite color/i.test(q.label)));
});

test("SUBMIT-01/02 (approveAndSubmit's own gate): a mismatched approval is refused before any browser action or state change", async () => {
  const url = mockAtsUrl("mock-submit-new-question");
  const run = newApprovedRun(url);
  const otherRun = newApprovedRun(url);

  await assert.rejects(
    () => approveAndSubmit(run.id, runtime, { runId: otherRun.id }),
    /explicit approval/i
  );
  const unchanged = runsDb.getRun(run.id)!;
  assert.equal(unchanged.status, "READY_FOR_REVIEW", "a rejected approval must not move the run at all");
});
