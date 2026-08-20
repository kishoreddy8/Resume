import test from "node:test";
import assert from "node:assert/strict";
import { buildFinalReview, readSubmissionOutcome } from "../finalReview";
import type { FieldPlan, DiscoveredField } from "../agent/types";

const field = (over: Partial<DiscoveredField> = {}): DiscoveredField => ({
  selector: "#x", kind: "text", label: "Email", id: "x", name: null, required: true, ...over,
});

test("REVIEW-1 the review lists the values that will actually be typed, with their sources", () => {
  const plans: FieldPlan[] = [
    { action: "fill", field: field({ label: "Email" }), value: "j@x.test", source: "PROFILE", canonicalKey: "email" },
    { action: "fill", field: field({ label: "Sponsorship?" }), value: "No", source: "APPLICATION_ANSWER_VAULT", canonicalKey: "sponsorship_required" },
    { action: "upload", field: field({ label: "Resume", kind: "file" }), filePath: "/g/Resume.docx", source: "VALIDATED_CANDIDATE_PROFILE" },
  ];
  const r = buildFinalReview({ company: "Acme", role: "DE", ats: "greenhouse", plans, resumeFile: "/g/Resume.docx", coverLetterFile: null });
  assert.equal(r.answers.length, 2);
  assert.deepEqual(r.answers.map((a) => a.source), ["PROFILE", "APPLICATION_ANSWER_VAULT"]);
  assert.equal(r.documents[0].value, "/g/Resume.docx");
});

test("REVIEW-2 an unanswered REQUIRED field blocks approval outright", () => {
  const plans: FieldPlan[] = [
    { action: "ask", field: field({ label: "Desired salary", required: true }), question: "Desired salary", reason: "No saved answer.", questionType: "salary" },
  ];
  const r = buildFinalReview({ company: "Acme", role: "DE", ats: "lever", plans, resumeFile: "/g/R.docx", coverLetterFile: null });
  assert.equal(r.canApprove, false, "approval must not be offered for an incomplete form");
  assert.equal(r.unresolved.length, 1);
});

test("REVIEW-3 an unanswered OPTIONAL field warns but does not block", () => {
  const plans: FieldPlan[] = [
    { action: "fill", field: field(), value: "j@x.test", source: "PROFILE", canonicalKey: "email" },
    { action: "ask", field: field({ label: "Anything else?", required: false }), question: "Anything else?", reason: "No saved answer.", questionType: null },
  ];
  const r = buildFinalReview({ company: "Acme", role: "DE", ats: "greenhouse", plans, resumeFile: "/g/R.docx", coverLetterFile: "/g/C.docx" });
  assert.equal(r.canApprove, true);
  assert.ok(r.warnings.some((w) => /optional question/.test(w)));
});

test("REVIEW-4 a missing resume is surfaced as a warning the reviewer will see", () => {
  const r = buildFinalReview({ company: "Acme", role: "DE", ats: "greenhouse", plans: [], resumeFile: null, coverLetterFile: null });
  assert.ok(r.warnings.some((w) => /No resume will be attached/.test(w)));
});

test("REVIEW-5 a click is not a confirmation — only the site's own words are", () => {
  assert.equal(readSubmissionOutcome("Thank you for applying! We have received your application.").confirmed, true);
  assert.equal(readSubmissionOutcome("Application received — reference 12345").confirmed, true);
  assert.equal(readSubmissionOutcome("Submit").confirmed, false, "a button label is not a receipt");
  assert.equal(readSubmissionOutcome("").confirmed, false);
  assert.equal(readSubmissionOutcome("An error occurred. Please try again.").confirmed, false);
});

test("REVIEW-6 a confirmation records the evidence, not just the verdict", () => {
  const out = readSubmissionOutcome("Great news — your application has been submitted to Acme Corp for review.");
  assert.equal(out.confirmed, true);
  assert.ok(out.evidence && out.evidence.includes("application has been submitted"), "the record must show WHY it was called submitted");
});
