import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discoverFields, selectorFor, type RawControl } from "../fieldDiscovery";
import { planFields, firstBlocker, unresolvedRequired } from "../planFields";
import { detectBlocking, BLOCKING_STATUS } from "../detectBlocking";
import { selectAdapter, automatedSourceTypes } from "../selectAdapter";
import { leverAdapter } from "../adapters/lever";
import type { AdapterContext } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

/**
 * The fixture is a REAL Greenhouse application form, captured read-only from a live posting. These
 * tests therefore check the planner against markup a company actually serves, not against a mock
 * shaped to agree with the implementation.
 */
const REAL_FORM: RawControl[] = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures/greenhouse-form.json"), "utf8")
);

const CONTEXT: AdapterContext = {
  candidateId: 1,
  contact: {
    name: "Jordan Rivera",
    email: "jordan@example.test",
    phone: "(214) 555-0100",
    location: "Dallas, TX",
    linkedin: "linkedin.com/in/jordan",
    github: "github.com/jordan",
  },
  resumePath: "/tmp/resume.docx",
  coverLetterPath: "/tmp/cover.docx",
};

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

test("AGENT-1 a real Greenhouse form yields addressable, labelled fields", () => {
  const fields = discoverFields(REAL_FORM);
  assert.ok(fields.length > 10, `expected a real form's fields, got ${fields.length}`);
  for (const f of fields) {
    assert.ok(f.selector.startsWith("#") || f.selector.startsWith("[name="), `positional selector: ${f.selector}`);
  }
  const ids = fields.map((f) => f.id);
  for (const expected of ["first_name", "last_name", "email", "phone", "resume", "cover_letter"]) {
    assert.ok(ids.includes(expected), `${expected} was not discovered on a real form`);
  }
});

test("AGENT-2 an unaddressable control is never touched", () => {
  assert.equal(selectorFor({ tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: "X", required: false }), null);
  const fields = discoverFields([{ tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: "Mystery", required: true }]);
  assert.deepEqual(fields, [], "a field that cannot be re-found reliably must be dropped, not guessed at");
});

test("AGENT-3 identity and contact come from the profile, with provenance", () => {
  const plans = planFields({ fields: discoverFields(REAL_FORM), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  const byId = (id: string) => plans.find((p) => p.field.id === id);

  const first = byId("first_name");
  assert.equal(first?.action, "fill");
  assert.equal(first?.action === "fill" && first.value, "Jordan");
  assert.equal(first?.action === "fill" && first.source, "PROFILE");

  assert.equal(byId("email")?.action === "fill" && (byId("email") as never as { value: string }).value, "jordan@example.test");
});

test("AGENT-4 the validated resume and cover letter are uploaded, never an older file", () => {
  const plans = planFields({ fields: discoverFields(REAL_FORM), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  const resume = plans.find((p) => p.field.id === "resume");
  assert.equal(resume?.action, "upload");
  assert.equal(resume?.action === "upload" && resume.filePath, "/tmp/resume.docx");

  const withoutResume = planFields({
    fields: discoverFields(REAL_FORM),
    context: { ...CONTEXT, resumePath: null },
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
  });
  const blocked = withoutResume.find((p) => p.field.id === "resume");
  assert.equal(blocked?.action, "ask", "no validated resume means the run stops, never reaches for an old one");
});

test("AGENT-5 an unrecognised question stops the run rather than being guessed at", () => {
  const plans = planFields({
    fields: discoverFields([
      { tag: "textarea", type: null, id: "q_values", name: null, ariaLabel: null, labelText: "Which of our values resonates most with you?*", required: true },
    ]),
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
  });
  assert.equal(plans[0].action, "ask");
  const blocker = firstBlocker(plans);
  assert.ok(blocker, "a required unknown question must block");
  assert.match(blocker!.question, /values resonates/);
});

test("AGENT-6 required unknowns block before optional ones", () => {
  const plans = planFields({
    fields: discoverFields([
      { tag: "input", type: "text", id: "optional_q", name: null, ariaLabel: null, labelText: "Anything else?", required: false },
      { tag: "input", type: "text", id: "required_q", name: null, ariaLabel: null, labelText: "Which shift do you prefer?*", required: true },
    ]),
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
  });
  assert.equal(firstBlocker(plans)?.field.id, "required_q");
  assert.equal(unresolvedRequired(plans).length, 1);
});

test("AGENT-7 a demographic question on a real form is never auto-filled", () => {
  const demographic = REAL_FORM.filter((c) => /gender|race|ethnic|veteran|disability/i.test(c.labelText ?? ""));
  if (demographic.length === 0) return; // Not on this posting; AGENT-8 covers the rule directly.
  const plans = planFields({ fields: discoverFields(demographic), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  for (const p of plans) assert.notEqual(p.action, "fill", `${p.field.label} must never be filled automatically`);
});

test("AGENT-8 a stored answer only fills when its policy and provenance allow", () => {
  const field: RawControl = { tag: "input", type: "text", id: "sponsor", name: null, ariaLabel: null, labelText: "Will you now or in the future require sponsorship?*", required: true };
  const approvedAuto = new Map<string, StoredAnswer>([
    ["sponsorship_required", { answer_value: "No", answer_source: "APPLICATION_ANSWER_VAULT", approved_by_user: 1, auto_fill_allowed: 1 }],
  ]);
  const filled = planFields({ fields: discoverFields([field]), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: approvedAuto });
  assert.equal(filled[0].action, "fill");
  assert.equal(filled[0].action === "fill" && filled[0].value, "No");

  const notAuto = new Map<string, StoredAnswer>([
    ["sponsorship_required", { answer_value: "No", answer_source: "APPLICATION_ANSWER_VAULT", approved_by_user: 1, auto_fill_allowed: 0 }],
  ]);
  assert.equal(planFields({ fields: discoverFields([field]), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: notAuto })[0].action, "ask");
});

test("AGENT-9 CAPTCHA, MFA and verification are DETECTED and never solved", () => {
  assert.equal(detectBlocking({ url: "x", text: "", markers: ["iframe.g-recaptcha"] }), "captcha");
  assert.equal(detectBlocking({ url: "x", text: "I'm not a robot", markers: [] }), "captcha");
  assert.equal(detectBlocking({ url: "x", text: "Enter the verification code we sent", markers: [] }), "mfa");
  assert.equal(detectBlocking({ url: "x", text: "Please verify your email to continue", markers: [] }), "email_verification");
  assert.equal(detectBlocking({ url: "x", text: "Create an account to apply", markers: [] }), "account_required");
  assert.equal(detectBlocking({ url: "x", text: "Tell us about yourself", markers: [] }), null);

  // Every condition routes to a state that stops and asks a human.
  for (const status of Object.values(BLOCKING_STATUS)) {
    assert.match(status, /^(WAITING_FOR_|ACCOUNT_REQUIRED)/, `${status} must be a waiting state`);
  }
});

test("AGENT-10 the adapter is chosen by the job record's OWN ats identity", () => {
  /* Career-Ops already discovers and normalises sources; the job row carries source_type. Selection
   * consumes that rather than sniffing the URL again — a second detector is a second opinion. */
  const gh = selectAdapter({ source_type: "greenhouse", url: "https://job-boards.greenhouse.io/natera/jobs/1" });
  assert.equal(gh?.adapter.sourceType, "greenhouse");
  assert.equal(gh?.via, "job_record");

  const lever = selectAdapter({ source_type: "lever", url: null });
  assert.equal(lever?.adapter.sourceType, "lever");
  assert.equal(lever?.via, "job_record", "no URL is needed when the record already knows");
});

test("AGENT-10b a URL fallback uses the CONNECTOR's detector, not a private one", () => {
  const detected = selectAdapter({ source_type: null, url: "https://job-boards.greenhouse.io/natera/jobs/1" });
  assert.equal(detected?.adapter.sourceType, "greenhouse");
  assert.equal(detected?.via, "connector_detector");
});

test("AGENT-10c an ATS with no form adapter yields null rather than a generic guess", () => {
  /* PHASE 9E — this tripwire previously asserted that Workday yields null. That expectation was
   * correct for as long as no Workday adapter existed, and it was deliberately left in place
   * through Phases 9A-9D so that registering one could never happen by accident.
   *
   * It changes here, in the SAME change that registers the adapter, because the underlying fact
   * changed: Workday's real application form was observed read-only against a live tenant on
   * 2026-08-25 under explicit operator authorisation, sanitized into
   * `mockAts/mock-workday-myinformation.html`, and covered by the WORKDAY-* suite. The adapter
   * declares only what that observation showed. See adapters/workday.ts.
   *
   * The tripwire itself is NOT weakened: an ATS with no adapter must still yield null, and that is
   * still asserted below with ashby — a SourceType the connector layer detects and the apply layer
   * deliberately does not automate. */
  assert.equal(selectAdapter({ source_type: "ashby", url: null }), null, "an unautomated ATS still yields null, never a generic guess");
  assert.equal(selectAdapter({ source_type: null, url: null }), null);
  assert.equal(selectAdapter({ source_type: null, url: "not a url" }), null);
  assert.deepEqual(automatedSourceTypes().sort(), ["greenhouse", "lever", "workday"]);
});

test("AGENT-10d Workday is selected by the job record's own identity, like every other adapter", () => {
  const wd = selectAdapter({ source_type: "workday", url: null });
  assert.equal(wd?.adapter.sourceType, "workday");
  assert.equal(wd?.via, "job_record", "no URL is needed when the record already knows");
});

/* ── Lever, from a real apply form ───────────────────────────────────────────────────────────── */

const LEVER_FORM: RawControl[] = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "fixtures/lever-form.json"), "utf8")
);

test("LEVER-1 real Lever fields carry NO label, and are still identified by adapter hints", () => {
  /* This is the defect real markup exposed. Lever gives its core controls no <label for>, no
   * aria-label and no caption — only a `name`. Without hints every field blocked, including the
   * candidate's own name and email. */
  const fields = discoverFields(LEVER_FORM);
  const core = fields.filter((f) => ["name", "email", "phone"].includes(f.name ?? ""));
  assert.ok(core.length >= 3, "the core fields must be discovered");
  for (const f of core) assert.equal(f.label, null, "Lever genuinely provides no label here");

  const plans = planFields({
    fields,
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    selectorHints: leverAdapter.fieldSelectorHints(),
  });
  const filled = plans.filter((p) => p.action === "fill");
  assert.ok(filled.length >= 5, `expected identity/contact fills, got ${filled.length}`);
  for (const p of filled) {
    assert.equal(p.action === "fill" && p.source, "PROFILE", "hints name a field; they never supply a value");
  }
});

test("LEVER-2 a hint matches by id or name, not only by rendered selector", () => {
  // Lever's location input is name="location" but id="location-input".
  const plans = planFields({
    fields: discoverFields(LEVER_FORM),
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    selectorHints: leverAdapter.fieldSelectorHints(),
  });
  const location = plans.find((p) => p.field.name === "location" || p.field.id === "location-input");
  assert.equal(location?.action, "fill");
  assert.equal(location?.action === "fill" && location.value, "Dallas, TX");
});

test("LEVER-3 custom card questions still stop the run", () => {
  const plans = planFields({
    fields: discoverFields(LEVER_FORM),
    context: CONTEXT,
    knownVariants: NO_VARIANTS,
    storedAnswers: NO_ANSWERS,
    selectorHints: leverAdapter.fieldSelectorHints(),
  });
  const cards = plans.filter((p) => (p.field.name ?? "").startsWith("cards["));
  assert.ok(cards.length > 0, "this posting has custom questions");
  for (const c of cards) assert.equal(c.action, "ask", "a company's own question is never auto-answered");
});

test("LEVER-4 hints can only name known factual fields, never an open-ended one", () => {
  const hints = leverAdapter.fieldSelectorHints();
  for (const key of Object.keys(hints)) {
    assert.doesNotMatch(key, /why|describe|cover|open|salary|demographic|gender|race|veteran|disability/i,
      `${key} must not be fillable from a selector hint`);
  }
});

test("AGENT-11 nothing in the planner can produce a submit action", () => {
  const plans = planFields({ fields: discoverFields(REAL_FORM), context: CONTEXT, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  for (const p of plans) {
    assert.ok(["fill", "upload", "ask", "skip"].includes(p.action), `unexpected action ${p.action}`);
  }
});
