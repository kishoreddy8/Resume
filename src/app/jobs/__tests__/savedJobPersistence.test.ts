import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";

let tmpDir: string;
let candidateAId: number;
let candidateBId: number;
let jobId: number;

let getJob: typeof import("@/db/queries/jobs").getJob;
let patchJob: typeof import("@/app/api/jobs/[id]/route").PATCH;
let getJobRoute: typeof import("@/app/api/jobs/[id]/route").GET;
let getForYou: typeof import("@/app/api/candidates/[candidateId]/for-you/route").GET;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-saved-jobs-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db");
  const { createCandidate } = await import("@/db/queries/candidates");
  const { createCompany } = await import("@/db/queries/companies");
  const { upsertJob, getJobByDedupeKey } = await import("@/db/queries/jobs");
  ({ getJob } = await import("@/db/queries/jobs"));
  ({ PATCH: patchJob, GET: getJobRoute } = await import("@/app/api/jobs/[id]/route"));
  ({ GET: getForYou } = await import("@/app/api/candidates/[candidateId]/for-you/route"));
  getDb();

  candidateAId = createCandidate({ firstName: "Saved", lastName: "Candidate A" }).id;
  candidateBId = createCandidate({ firstName: "Saved", lastName: "Candidate B" }).id;
  const company = createCompany({
    name: "Saved Jobs Test Company",
    source_type: "greenhouse",
    ats_board_token: "saved-jobs-test",
  });
  const dedupeKey = `greenhouse:${company.id}:saved-job`;
  upsertJob({
    companyId: company.id,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: "saved-job",
      title: "Senior Data Engineer",
      location: "Chicago, IL",
      department: null,
      url: "https://example.com/jobs/saved-job",
      descriptionHtml: null,
      descriptionText: "Build reliable data platforms.",
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: false,
    sponsorshipPolarity: "none",
    sponsorshipSnippet: null,
    h1bCombinedConfidence: "Unknown",
  });
  jobId = getJobByDedupeKey(dedupeKey)!.id;
});

after(() => {
  delete process.env.CAREER_OPS_DB_PATH;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function patch(candidateId: number, pinned: unknown) {
  const request = new NextRequest(`http://localhost/api/jobs/${jobId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ candidateId, pinned }),
  });
  return patchJob(request, { params: Promise.resolve({ id: String(jobId) }) });
}

async function savedIds(candidateId: number): Promise<number[]> {
  const request = new NextRequest(
    `http://localhost/api/candidates/${candidateId}/for-you?savedOnly=true&includeStale=true&limit=500`
  );
  const response = await getForYou(request, {
    params: Promise.resolve({ candidateId: String(candidateId) }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { entries: Array<{ job: { id: number } }> };
  return body.entries.map((entry) => entry.job.id);
}

test("the former numeric heart payload is rejected by the boolean PATCH contract", async () => {
  const response = await patch(candidateAId, 1);
  assert.equal(response.status, 400);
  assert.equal(getJob(jobId, candidateAId)!.pinned, 0);
});

test("saving persists candidate_job_state.pinned and survives a fresh detail read", async () => {
  const response = await patch(candidateAId, true);
  assert.equal(response.status, 200);
  assert.equal(getJob(jobId, candidateAId)!.pinned, 1);

  const reload = await getJobRoute(
    new NextRequest(`http://localhost/api/jobs/${jobId}?candidateId=${candidateAId}`),
    { params: Promise.resolve({ id: String(jobId) }) }
  );
  assert.equal(reload.status, 200);
  const body = (await reload.json()) as { job: { pinned: number } };
  assert.equal(body.job.pinned, 1);
});

test("Saved includes a newly saved job without any per-row read", async () => {
  assert.ok((await savedIds(candidateAId)).includes(jobId));
});

test("candidate saved state is isolated", async () => {
  assert.equal(getJob(jobId, candidateBId)!.pinned, 0);
  assert.ok(!(await savedIds(candidateBId)).includes(jobId));
});

test("unsaving persists and removes the job from Saved", async () => {
  const response = await patch(candidateAId, false);
  assert.equal(response.status, 200);
  assert.equal(getJob(jobId, candidateAId)!.pinned, 0);
  assert.ok(!(await savedIds(candidateAId)).includes(jobId));
});
