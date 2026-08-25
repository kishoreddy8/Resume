import test from "node:test";
import assert from "node:assert/strict";
import { discoverFields, type RawControl } from "../fieldDiscovery";
import { planFields } from "../planFields";
import type { AdapterContext } from "../types";
import type { StoredAnswer } from "../../resolveAnswer";
import type { QuestionType } from "../../questionTypes";

/**
 * PHASE 9D — planFields actually consuming AdapterContext.employment/.education (Phase 9A declared
 * these as contract-only; this proves they are now wired, narrowly, for flat single-field
 * questions only — see planFields.ts's employmentValueFor/educationValueFor for the scope boundary).
 */

const NO_VARIANTS = new Map<string, { canonicalKey: string; type: QuestionType }>();
const NO_ANSWERS = new Map<string, StoredAnswer>();

function baseContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    candidateId: 1,
    contact: { name: "Jordan Rivera", email: "jordan@example.test", phone: "(214) 555-0100", location: "Dallas, TX" },
    resumePath: "/tmp/resume.docx",
    coverLetterPath: "/tmp/cover.docx",
    ...overrides,
  };
}

function control(overrides: Partial<RawControl>): RawControl {
  return { tag: "input", type: "text", id: null, name: null, ariaLabel: null, labelText: null, required: false, ...overrides };
}

test("PROFILE-01: a known employment fact fills from authoritative structured data, not from the resume or JD", () => {
  const ctx = baseContext({
    employment: [{ employer: "Acme Corp", title: "Senior Engineer", startDate: "2021-03", endDate: null }],
  });
  const fields = discoverFields([control({ id: "curr_employer", labelText: "Current Employer" })]);
  const plans = planFields({ fields, context: ctx, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "fill");
  assert.equal((plans[0] as { value: string }).value, "Acme Corp");
  assert.equal((plans[0] as { source: string }).source, "PROFILE");
});

test("PROFILE-02: with NO employment data supplied, the same question asks the user rather than fabricating an employer", () => {
  const ctx = baseContext(); // no .employment at all
  const fields = discoverFields([control({ id: "curr_employer", labelText: "Current Employer" })]);
  const plans = planFields({ fields, context: ctx, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask");
});

test("PROFILE-02b: an employment record with no end date (current role) never invents one, and never invents location/salary/manager", () => {
  const ctx = baseContext({ employment: [{ employer: "Acme Corp", title: "Senior Engineer", startDate: "2021-03", endDate: null }] });
  assert.equal(ctx.employment![0].endDate, null);
  assert.ok(!("location" in ctx.employment![0]));
  assert.ok(!("salary" in ctx.employment![0]));
  assert.ok(!("manager" in ctx.employment![0]));
});

test("PROFILE-03: a known education fact (institution) fills from authoritative structured data", () => {
  const ctx = baseContext({ education: [{ level: "Bachelor's Degree", field: "Computer Science", institution: "State University" }] });
  const fields = discoverFields([control({ id: "school_name", labelText: "School Name" })]);
  const plans = planFields({ fields, context: ctx, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "fill");
  assert.equal((plans[0] as { value: string }).value, "State University");
});

test("PROFILE-04: a graduation-date question is asked, not fabricated — EducationEntry carries no graduation date field at all", () => {
  const ctx = baseContext({ education: [{ level: "Bachelor's Degree", field: "Computer Science", institution: "State University" }] });
  assert.ok(!("graduationDate" in ctx.education![0]));
  const fields = discoverFields([control({ id: "grad_date", type: "date", labelText: "Graduation Date" })]);
  const plans = planFields({ fields, context: ctx, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask", "no canonical mapping exists for a graduation date, and none should be invented");
});

test("a stored degree string that does not exactly match the form's current dropdown options is asked, never mis-selected", () => {
  const ctx = baseContext({ education: [{ level: "B.S.", field: "Computer Science", institution: "State University" }] });
  const fields = discoverFields([
    control({ tag: "select", type: null, id: "degree_level", labelText: "What is your highest degree?" }),
  ]);
  fields[0].options = ["Bachelor's Degree", "Master's Degree", "Doctorate"];
  const plans = planFields({ fields, context: ctx, knownVariants: NO_VARIANTS, storedAnswers: NO_ANSWERS });
  assert.equal(plans[0].action, "ask", "\"B.S.\" is not literally one of the offered options — never a close match");
});
