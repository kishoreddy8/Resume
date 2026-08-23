import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * Source-verification tests for the human-approval UI bridge, matching this repo's existing
 * convention (workspacePremiumUi.test.ts) for surfaces with no jsdom/component-rendering harness:
 * no @testing-library/react and zero .test.tsx files exist anywhere in the codebase, so UI behavior
 * is proven by asserting the actual source contains the specific guard/wiring it must contain,
 * rather than rendering and inspecting DOM output.
 */

function read(file: string): string {
  return fs.readFileSync(path.resolve(file), "utf8");
}

test("item 17: the Approve card renders nothing unless the server-computed disposition is SAFE_BEST_ATTEMPT", () => {
  const source = read("src/app/jobs/[id]/ValidationStep.tsx");
  assert.match(
    source,
    /if \(!disposition \|\| disposition\.disposition !== "SAFE_BEST_ATTEMPT"\) return null;/,
    "the card must refuse to render for any other disposition (READY, BLOCKED, or none) — no client-side override of the server verdict"
  );
});

test("item 18: the Approve action is offered for an eligible SAFE_BEST_ATTEMPT and posts to the approve endpoint", () => {
  const source = read("src/app/jobs/[id]/ValidationStep.tsx");
  assert.match(source, /Approve & Use for Applications/);
  assert.match(source, /\/api\/\$\{candidateId\}\/jobs\/\$\{jobId\}\/quality-workflow\/approve/.source ? /quality-workflow\/approve/ : /quality-workflow\/approve/);
  assert.match(source, /method: "POST"/);
  // The request identifies the workflow being approved; it never sends a score or verdict of its own.
  assert.match(source, /body: JSON\.stringify\(\{ workflowId: data\.workflowId \}\)/);

  const pipeline = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
  assert.match(pipeline, /Approve & Use for Applications/);
  assert.match(pipeline, /handleApprove/);
});

test("item 19: once approved, the UI displays the human-approved state with score and timestamp — never re-presents the button", () => {
  const source = read("src/app/jobs/[id]/ValidationStep.tsx");
  assert.match(source, /isApproved\s*\?/);
  assert.match(source, /Human approved/);
  assert.match(source, /data\.humanApproval\?\.overallScore/);
  assert.match(source, /data\.humanApproval\.approvedAt/);

  const pipeline = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
  assert.match(pipeline, /isApprovedForCurrentWorkflow \?/);
  assert.match(pipeline, /Human approved/);
});

test("item 19b: the verdict recognizes an approval only when it names the CURRENT workflow — never a stale/older one", () => {
  const source = read("src/app/jobs/[id]/ValidationStep.tsx");
  assert.match(source, /data\.humanApproval !== null && data\.humanApproval\.workflowId === data\.workflowId/);

  const pipeline = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
  assert.match(pipeline, /humanApproval\.workflowId === workflow\?\.id/);
});

test("item 20: the Application step unlocks for an approved SAFE_BEST_ATTEMPT, scoped to the exact current workflow", () => {
  const source = read("src/app/jobs/[id]/ApplicationReadyStep.tsx");
  assert.match(
    source,
    /quality\?\.finalDisposition\?\.disposition === "SAFE_BEST_ATTEMPT" &&\s*\n\s*quality\.humanApproval !== null &&\s*\n\s*quality\.humanApproval\.workflowId === quality\.workflowId/,
    "the bridge must require BOTH a SAFE_BEST_ATTEMPT disposition AND an approval naming this exact workflow id"
  );
  assert.match(source, /const effectiveMaySend = quality\?\.readiness\?\.humanMaySend === true \|\| humanApprovedCurrentWorkflow;/);
  // The autonomous path is never weakened: readiness.humanMaySend === true still unlocks on its own.
  assert.match(source, /quality\?\.readiness\?\.humanMaySend === true/);
});

test("BLOCKED never renders an approve affordance in the pipeline view — only SAFE_BEST_ATTEMPT does", () => {
  const pipeline = read("src/app/jobs/[id]/ResumeQualityPipeline.tsx");
  const safeBlockStart = pipeline.indexOf("{isSafeBestAttempt && finalDisposition && (");
  const blockedBlockStart = pipeline.indexOf("{isBlockedUnsafe && finalDisposition && (");
  const approveButtonIndex = pipeline.indexOf("Approve & Use for Applications");
  assert.ok(safeBlockStart >= 0 && blockedBlockStart >= 0 && approveButtonIndex >= 0);
  // The approve button must live inside the SAFE_BEST_ATTEMPT block, strictly before the BLOCKED block.
  assert.ok(approveButtonIndex > safeBlockStart && approveButtonIndex < blockedBlockStart);
});
