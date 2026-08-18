import assert from "node:assert/strict";
import { test } from "node:test";
import {
  diffSnapshots,
  diffTableCounts,
  findForbiddenManifestContent,
  selectAcceptanceWorkflow,
  verifyManifestIdentity,
  type AcceptanceWorkflowCandidate,
  type ExpectedManifestIdentity,
  type FileSnapshot,
} from "../phase9a-final-publication-acceptance";

/**
 * Tests for the Phase 9A acceptance harness's own decision logic — selection, manifest identity
 * checking, snapshot diffing, and table-count diffing. These prove the harness would actually catch
 * the failures it claims to catch, which is the part that can be verified without the real corpus.
 *
 * They deliberately prove nothing about production: the real-corpus run is the only thing that can
 * do that, and it is not simulated here.
 */

function wf(overrides: Partial<AcceptanceWorkflowCandidate> = {}): AcceptanceWorkflowCandidate {
  return {
    workflowId: 1,
    candidateId: 1,
    tailoringRunId: 10,
    dedupeKey: "greenhouse:5:abc",
    status: "READY",
    finalApprovedIteration: 2,
    currentIteration: 2,
    jobId: 100,
    jobTitle: "Data Engineer",
    companyId: 5,
    companyName: "Acme",
    ...overrides,
  };
}

// --- selectAcceptanceWorkflow -------------------------------------------------------------------

test("selection returns null rather than inventing a workflow when none is READY", () => {
  assert.equal(selectAcceptanceWorkflow([]), null);
  assert.equal(
    selectAcceptanceWorkflow([wf({ status: "FAILED" }), wf({ workflowId: 2, status: "IMPROVEMENT_RUNNING" })]),
    null
  );
});

test("selection never chooses a non-READY workflow", () => {
  const result = selectAcceptanceWorkflow([
    wf({ workflowId: 9, status: "FAILED" }),
    wf({ workflowId: 3, status: "READY" }),
    wf({ workflowId: 8, status: "REVIEW_COMPLETED" }),
  ]);
  assert.equal(result?.selected.workflowId, 3);
  assert.equal(result?.selected.status, "READY");
});

test("the preferred Celigo job 7362 workflow wins when present and READY", () => {
  const result = selectAcceptanceWorkflow([
    wf({ workflowId: 50, jobId: 999, companyName: "Other Co" }),
    wf({ workflowId: 12, jobId: 7362, companyName: "Celigo, Inc." }),
  ]);
  assert.equal(result?.reason, "preferred");
  assert.equal(result?.selected.workflowId, 12);
});

test("the preferred workflow is not chosen when it exists but is not READY", () => {
  const result = selectAcceptanceWorkflow([
    wf({ workflowId: 12, jobId: 7362, companyName: "Celigo, Inc.", status: "FAILED" }),
    wf({ workflowId: 4, jobId: 555, companyName: "Other Co", status: "READY" }),
  ]);
  assert.equal(result?.reason, "deterministic-fallback");
  assert.equal(result?.selected.workflowId, 4);
});

test("the preferred match requires BOTH the job id and the company name", () => {
  // Right job id, wrong company — must not be treated as the Stage 25C workflow.
  const result = selectAcceptanceWorkflow([wf({ workflowId: 7, jobId: 7362, companyName: "Nowhere Ltd" })]);
  assert.equal(result?.reason, "deterministic-fallback");
});

test("the fallback is deterministic — highest READY workflow id, regardless of input order", () => {
  const rows = [wf({ workflowId: 4 }), wf({ workflowId: 31 }), wf({ workflowId: 17 })];
  const a = selectAcceptanceWorkflow(rows);
  const b = selectAcceptanceWorkflow([...rows].reverse());
  assert.equal(a?.selected.workflowId, 31);
  assert.equal(b?.selected.workflowId, 31);
  assert.equal(a?.reason, "deterministic-fallback");
});

// --- verifyManifestIdentity ---------------------------------------------------------------------

const EXPECTED: ExpectedManifestIdentity = {
  candidateId: 1,
  candidateName: "Sai Kishore Onteru",
  companyId: 5,
  companyName: "Celigo, Inc.",
  jobId: 7362,
  jobTitle: "Senior Data Engineer",
  tailoringRunId: 10,
  workflowId: 12,
  iterationId: 2,
  workflowStatus: "READY",
  qualityGateOutcome: "READY",
  resumeSha256: "a".repeat(64),
  coverLetterSha256: "b".repeat(64),
};

function goodManifest(overrides: Record<string, unknown> = {}) {
  return {
    candidateId: 1,
    candidateName: "Sai Kishore Onteru",
    companyId: 5,
    companyName: "Celigo, Inc.",
    jobId: 7362,
    jobTitle: "Senior Data Engineer",
    tailoringRunId: 10,
    workflowId: 12,
    iterationId: 2,
    workflowStatus: "READY",
    qualityGateOutcome: "READY",
    files: { resume: "SaiKishore_Resume.docx", coverLetter: "SaiKishore_CoverLetter.docx" },
    checksums: { resume: "a".repeat(64), coverLetter: "b".repeat(64) },
    ...overrides,
  };
}

test("a correct manifest produces no identity failures", () => {
  assert.deepEqual(verifyManifestIdentity(goodManifest(), EXPECTED), []);
});

test("a manifest naming the wrong candidate, job, or workflow is caught", () => {
  assert.equal(verifyManifestIdentity(goodManifest({ candidateId: 2 }), EXPECTED).length, 1);
  assert.equal(verifyManifestIdentity(goodManifest({ jobId: 7363 }), EXPECTED).length, 1);
  assert.equal(verifyManifestIdentity(goodManifest({ workflowId: 13 }), EXPECTED).length, 1);
  assert.equal(verifyManifestIdentity(goodManifest({ iterationId: 3 }), EXPECTED).length, 1);
  assert.equal(verifyManifestIdentity(goodManifest({ tailoringRunId: 11 }), EXPECTED).length, 1);
  assert.equal(verifyManifestIdentity(goodManifest({ companyName: "Wrong Co" }), EXPECTED).length, 1);
});

test("a manifest claiming a non-READY status is caught", () => {
  const failures = verifyManifestIdentity(goodManifest({ workflowStatus: "IMPROVEMENT_RUNNING" }), EXPECTED);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("workflowStatus"));
});

test("a checksum that does not match the approved source is caught", () => {
  const failures = verifyManifestIdentity(goodManifest({ checksums: { resume: "c".repeat(64), coverLetter: "b".repeat(64) } }), EXPECTED);
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("checksums.resume"));
});

test("a missing checksums block or resume filename is caught, and a non-object never crashes", () => {
  assert.ok(verifyManifestIdentity(goodManifest({ checksums: undefined }), EXPECTED).some((f) => f.includes("checksums is missing")));
  assert.ok(verifyManifestIdentity(goodManifest({ files: {} }), EXPECTED).some((f) => f.includes("files.resume")));
  assert.deepEqual(verifyManifestIdentity(null, EXPECTED), ["manifest.json did not parse into an object"]);
  assert.deepEqual(verifyManifestIdentity("nope", EXPECTED), ["manifest.json did not parse into an object"]);
});

test("a cover-letter-less publication is accepted only when null is genuinely expected", () => {
  const expected = { ...EXPECTED, coverLetterSha256: null };
  const manifest = goodManifest({ checksums: { resume: "a".repeat(64), coverLetter: null } });
  assert.deepEqual(verifyManifestIdentity(manifest, expected), []);
  // ...and a null checksum where one was expected is still a failure.
  assert.equal(verifyManifestIdentity(manifest, EXPECTED).length, 1);
});

// --- findForbiddenManifestContent ---------------------------------------------------------------

test("secret-shaped content in a manifest is detected, case-insensitively", () => {
  assert.deepEqual(findForbiddenManifestContent(JSON.stringify(goodManifest())), []);
  assert.deepEqual(findForbiddenManifestContent('{"apiKey":"x"}'), ["apikey"]);
  assert.deepEqual(findForbiddenManifestContent('{"h":"Bearer abc"}'), ["bearer"]);
  assert.deepEqual(findForbiddenManifestContent('{"a":"SECRET"}'), ["secret"]);
});

// --- diffSnapshots ------------------------------------------------------------------------------

function snap(relPath: string, sha: string, mtimeMs = 1000): FileSnapshot {
  return { relPath, sha256: sha, size: 10, mtimeMs };
}

test("identical master-file snapshots produce no drift", () => {
  const before = [snap("master/resume.docx", "aa"), snap("master/skills.docx", "bb")];
  assert.deepEqual(diffSnapshots(before, [...before]), []);
});

test("changed bytes, touched mtimes, deletions, and additions are all caught", () => {
  const before = [snap("master/resume.docx", "aa", 1000)];

  assert.ok(diffSnapshots(before, [snap("master/resume.docx", "zz", 1000)])[0].includes("bytes changed"));
  assert.ok(diffSnapshots(before, [snap("master/resume.docx", "aa", 2000)])[0].includes("mtime changed"));
  assert.ok(diffSnapshots(before, [])[0].includes("disappeared"));
  assert.ok(
    diffSnapshots(before, [snap("master/resume.docx", "aa", 1000), snap("master/new.docx", "cc")])[0].includes(
      "new file appeared"
    )
  );
});

// --- diffTableCounts ----------------------------------------------------------------------------

test("an unchanged database produces no mutation report", () => {
  const before = [
    { table: "jobs", rows: 18065 },
    { table: "candidates", rows: 1 },
  ];
  assert.deepEqual(diffTableCounts(before, [...before]), []);
});

test("any row-count movement is reported as a production mutation", () => {
  const before = [
    { table: "jobs", rows: 18065 },
    { table: "tailoring_runs", rows: 12 },
  ];
  const after = [
    { table: "jobs", rows: 18065 },
    { table: "tailoring_runs", rows: 13 },
  ];
  const drift = diffTableCounts(before, after);
  assert.equal(drift.length, 1);
  assert.ok(drift[0].includes("tailoring_runs"));
  assert.ok(drift[0].includes("12 -> 13"));

  assert.ok(diffTableCounts(before, [{ table: "jobs", rows: 18065 }])[0].includes("disappeared"));
  assert.ok(
    diffTableCounts([{ table: "jobs", rows: 1 }], [
      { table: "jobs", rows: 1 },
      { table: "brand_new", rows: 0 },
    ])[0].includes("appeared")
  );
});
