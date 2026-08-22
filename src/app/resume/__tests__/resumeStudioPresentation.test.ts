import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { ResumeLibraryEntry } from "@/app/api/candidates/[candidateId]/resume-library/route";
import {
  RESUME_STUDIO_EMPTY_COPY,
  RESUME_STUDIO_TABS,
  presentResumeStudioEntry,
} from "../resumeStudioPresentation";

function entry(overrides: Partial<ResumeLibraryEntry> = {}): ResumeLibraryEntry {
  return {
    jobId: 42,
    dedupeKey: "greenhouse:example:42",
    company: "Example Co",
    title: "Senior Data Engineer",
    location: "Chicago, IL",
    ats: "greenhouse",
    workflowId: 9,
    workflowStatus: "READY",
    iteration: 2,
    updatedAt: "2026-08-21 12:00:00",
    readiness: "READY_FOR_HUMAN_APPLICATION",
    humanMaySend: true,
    blockingReason: null,
    qualityGatePassed: true,
    overallScore: 96,
    isLegacyMissingAnalysis: false,
    canRevalidate: false,
    canRetry: false,
    documents: { resume: true, coverLetter: true, packageKind: "final" },
    ...overrides,
  };
}

test("Resume Studio exposes exactly the five approved tabs in order", () => {
  assert.deepEqual(RESUME_STUDIO_TABS.map((tab) => tab.label), [
    "All",
    "Ready to use",
    "Tailoring",
    "Needs review",
    "Blocked",
  ]);
});

test("Ready to use requires canonical readiness and humanMaySend", () => {
  assert.equal(presentResumeStudioEntry(entry()).bucket, "ready");
  assert.equal(
    presentResumeStudioEntry(entry({ humanMaySend: false })).bucket,
    "needs-review"
  );
});

test("workflow READY alone never implies Ready to use", () => {
  const result = presentResumeStudioEntry(entry({ readiness: "BLOCKED", humanMaySend: false }));
  assert.equal(result.bucket, "blocked");
  assert.notEqual(result.action.kind, "open");
});

test("active tailoring appears only in the Tailoring view", () => {
  const result = presentResumeStudioEntry(entry({ workflowStatus: "REVIEW_RUNNING", readiness: null, humanMaySend: null }));
  assert.equal(result.bucket, "tailoring");
  assert.equal(result.label, "Tailoring");
});

test("eligible legacy validation appears in Needs review with direct revalidation", () => {
  const result = presentResumeStudioEntry(entry({ readiness: "BLOCKED", humanMaySend: false, isLegacyMissingAnalysis: true, canRevalidate: true }));
  assert.equal(result.bucket, "needs-review");
  assert.equal(result.action.kind, "revalidate");
});

test("blocked packages remain in Blocked and route to validation issues", () => {
  const result = presentResumeStudioEntry(entry({ readiness: "BLOCKED", humanMaySend: false }));
  assert.equal(result.bucket, "blocked");
  assert.deepEqual(result.action, { kind: "issues", label: "Review issues", href: "/jobs/42?step=validation&focus=issues" });
});

test("Re-run validation is never offered without canRevalidate", () => {
  const result = presentResumeStudioEntry(entry({ readiness: "BLOCKED", humanMaySend: false, isLegacyMissingAnalysis: true, canRevalidate: false }));
  assert.notEqual(result.action.kind, "revalidate");
});

test("Re-tailor is offered only from the server retry projection", () => {
  const base = { workflowStatus: "FAILED", readiness: "NEEDS_IMPROVEMENT" as const, humanMaySend: false };
  assert.equal(presentResumeStudioEntry(entry({ ...base, canRetry: false })).action.kind, "issues");
  assert.deepEqual(presentResumeStudioEntry(entry({ ...base, canRetry: true })).action, {
    kind: "retry",
    label: "Re-tailor",
    href: "/jobs/42?step=results&focus=retailor",
  });
});

test("active progress uses the existing results deep-link", () => {
  const result = presentResumeStudioEntry(entry({ workflowStatus: "WRITER_RUNNING", readiness: null, humanMaySend: null }));
  assert.deepEqual(result.action, { kind: "progress", label: "View progress", href: "/jobs/42?step=results&focus=progress" });
});

test("ready resume opens the lazy in-page preview when a document exists", () => {
  assert.equal(presentResumeStudioEntry(entry()).action.kind, "open");
  assert.equal(presentResumeStudioEntry(entry({ documents: { resume: false, coverLetter: false, packageKind: null } })).action.kind, "details");
});

test("presentation buckets never duplicate a record", () => {
  const fixtures = [
    entry(),
    entry({ workflowStatus: "PENDING", readiness: null, humanMaySend: null }),
    entry({ readiness: "NEEDS_IMPROVEMENT", humanMaySend: false }),
    entry({ readiness: "BLOCKED", humanMaySend: false }),
  ];
  for (const fixture of fixtures) {
    const bucket = presentResumeStudioEntry(fixture).bucket;
    assert.ok(bucket === null || ["ready", "tailoring", "needs-review", "blocked"].includes(bucket));
  }
});

test("empty-state copy is truthful and state-specific", () => {
  assert.equal(RESUME_STUDIO_EMPTY_COPY.tailoring, "No resumes are tailoring right now.");
  assert.equal(RESUME_STUDIO_EMPTY_COPY["needs-review"], "Nothing needs your review.");
  assert.equal(RESUME_STUDIO_EMPTY_COPY.blocked, "No blocked resumes.");
});

test("page renders only candidate-facing status vocabulary", () => {
  const source = fs.readFileSync(path.resolve("src/app/resume/page.tsx"), "utf8");
  assert.doesNotMatch(source, />\s*(READY|FAILED|WAITING_PROMPT|SAFE_BEST_ATTEMPT|humanMaySend|qualityGate)\s*</);
  assert.match(source, /presentation\.label/);
});

test("list stays metadata-only and preview remains lazy", () => {
  const page = fs.readFileSync(path.resolve("src/app/resume/page.tsx"), "utf8");
  const route = fs.readFileSync(path.resolve("src/app/api/candidates/[candidateId]/resume-library/route.ts"), "utf8");
  assert.match(page, /previewing && entry\.jobId !== null/);
  assert.match(page, /<ResumePreview/);
  assert.doesNotMatch(route, /readFileSync|readFile\(/);
  assert.match(route, /documentPresence/);
});

test("Resume Studio makes only three bounded page-level requests and no request per row", () => {
  const source = fs.readFileSync(path.resolve("src/app/resume/page.tsx"), "utf8");
  const loadBlock = source.slice(source.indexOf("const load = useCallback"), source.indexOf("useEffect", source.indexOf("const load = useCallback")));
  assert.equal(loadBlock.match(/fetch\(`/g)?.length, 3);
  assert.doesNotMatch(source.slice(source.indexOf("function ResumeCard")), /useEffect\(/);
});

test("mobile cards keep the primary action reachable at a 44px target", () => {
  const source = fs.readFileSync(path.resolve("src/app/resume/page.tsx"), "utf8");
  assert.match(source, /const className = `\$\{BTN_PRIMARY\} min-h-11 w-full sm:w-auto`/);
  assert.match(source, /overflow-x-auto/);
});
