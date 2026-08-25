import test from "node:test";
import assert from "node:assert/strict";
import { buildValidationReport } from "../validation";
import type { FieldPlan } from "../agent/types";

/**
 * PHASE 9D — the deterministic validation report. Pure: constructed FieldPlan[] fixtures, no
 * browser, no DB. Proves this is an INSPECTION layer, not a second decision-maker: readiness always
 * matches what unresolvedRequired()/READY_FOR_REVIEW already imply.
 */

function field(overrides: Partial<FieldPlan["field"]> = {}): FieldPlan["field"] {
  return { selector: "#f", kind: "text", label: "Field", id: "f", name: null, required: true, ...overrides };
}

test("VALIDATION-01: every required field filled or answered, document ready, no blockers → READY_FOR_REVIEW", () => {
  const plans: FieldPlan[] = [
    { action: "fill", field: field({ required: true }), value: "Jordan", source: "PROFILE", canonicalKey: "first_name" },
    { action: "fill", field: field({ required: false }), value: "opt", source: "USER_INTERVENTION", canonicalKey: null },
  ];
  const report = buildValidationReport({ plans, documentReady: true });
  assert.equal(report.readyForReview, true);
  assert.equal(report.unresolvedRequired.length, 0);
  assert.equal(report.filledCount, 1);
  assert.equal(report.userAnsweredCount, 1);
});

test("VALIDATION-02: an unresolved REQUIRED field blocks readiness; an unresolved OPTIONAL one does not", () => {
  const plans: FieldPlan[] = [
    { action: "ask", field: field({ required: true }), question: "Sponsorship?", reason: "No saved answer.", questionType: null },
  ];
  const required = buildValidationReport({ plans, documentReady: true });
  assert.equal(required.readyForReview, false);
  assert.equal(required.unresolvedRequired.length, 1);

  const optionalPlans: FieldPlan[] = [
    { action: "ask", field: field({ required: false }), question: "Portfolio?", reason: "No saved answer.", questionType: null },
  ];
  const optional = buildValidationReport({ plans: optionalPlans, documentReady: true });
  assert.equal(optional.readyForReview, true, "an unresolved OPTIONAL field must not block readiness");
  assert.equal(optional.unresolvedOptional.length, 1);
});

test("VALIDATION-03: an invalid/stale option mapping is surfaced as an incompatible saved answer, and blocks readiness when required", () => {
  const plans: FieldPlan[] = [
    { action: "ask", field: field({ required: true, kind: "select" }), question: "Degree", reason: "\"B.S.\" is not one of the options this form offers.", questionType: null },
  ];
  const report = buildValidationReport({ plans, documentReady: true });
  assert.equal(report.incompatibleSavedAnswers.length, 1);
  assert.equal(report.readyForReview, false);
});

test("VALIDATION-04: a missing required document blocks readiness even with every field resolved", () => {
  const plans: FieldPlan[] = [
    { action: "fill", field: field(), value: "Jordan", source: "PROFILE", canonicalKey: "first_name" },
  ];
  const report = buildValidationReport({ plans, documentReady: false });
  assert.equal(report.readyForReview, false);
  assert.equal(report.documentReady, false);
});

test("auth mid-flow or an active blocking condition both prevent readiness, independent of field resolution", () => {
  const plans: FieldPlan[] = [{ action: "fill", field: field(), value: "Jordan", source: "PROFILE", canonicalKey: "first_name" }];
  assert.equal(buildValidationReport({ plans, documentReady: true, authOutcome: "MFA_REQUIRED" }).readyForReview, false);
  assert.equal(buildValidationReport({ plans, documentReady: true, blockingCondition: "captcha" }).readyForReview, false);
  assert.equal(buildValidationReport({ plans, documentReady: true, authOutcome: "AUTHENTICATED" }).readyForReview, true);
});

test("the page index passes through untouched — this module never invents or resets it", () => {
  const report = buildValidationReport({ plans: [], documentReady: true, page: 3 });
  assert.equal(report.page, 3);
  assert.equal(buildValidationReport({ plans: [], documentReady: true }).page, undefined);
});
