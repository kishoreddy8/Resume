import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { PipelineStatus } from "@/types";

/**
 * For You STALE-exemption — end-to-end proof (real DB, real candidates, real candidate_job_state)
 * that the narrow protection semantics reused from src/lib/jobLifecycle.ts's isLifecycleProtected
 * are wired correctly through the /for-you route: exactly PROTECTED_PIPELINE_STATUSES
 * (Applied/Interviewing/Offer/Employer Rejected) + pinned bypass the STALE filter, an ordinary
 * New/Interested job does not, Not Interested is excluded outright (unrelated to STALE), and one
 * candidate's protection never leaks into another candidate's view (candidate_job_state is queried
 * WHERE candidate_id = ? — this test proves that at the route level, not just by reading the SQL).
 */

let tmpDir: string;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let setPipelineStatus: typeof import("@/db/queries/candidateJobState").setPipelineStatus;
let setPinned: typeof import("@/db/queries/candidateJobState").setPinned;
let setNotInterested: typeof import("@/db/queries/candidateJobState").setNotInterested;
let GET: typeof import("../[candidateId]/for-you/route").GET;

const STALE_DATE = "2000-01-01T00:00:00.000Z"; // decades old — always > 20 days regardless of "now"

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-foryou-protection-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ setPipelineStatus, setPinned, setNotInterested } = await import("@/db/queries/candidateJobState"));
  ({ GET } = await import("../[candidateId]/for-you/route"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let jobCounter = 0;
function makeStaleJob(companyId: number) {
  jobCounter++;
  const dedupeKey = `greenhouse:${companyId}:job-${jobCounter}`;
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: `job-${jobCounter}`, title: `Role ${jobCounter}`, location: null, department: null,
      url: `https://boards.greenhouse.io/co/jobs/${jobCounter}`, descriptionHtml: null, descriptionText: "desc",
      employmentType: null, workplaceType: null, salaryText: null, postedAt: STALE_DATE, raw: {},
    },
    descriptionSections: null, sponsorshipMentioned: false, sponsorshipPolarity: "none",
    sponsorshipSnippet: null, h1bCombinedConfidence: "Unknown",
  });
  return dedupeKey;
}

async function forYouDedupeKeys(candidateId: number): Promise<string[]> {
  const req = new NextRequest(`http://localhost/api/candidates/${candidateId}/for-you?includeStale=false`);
  const res = await GET(req, { params: Promise.resolve({ candidateId: String(candidateId) }) });
  const body = await res.json();
  return body.entries.map((e: { job: { dedupe_key: string } }) => e.job.dedupe_key);
}

test("New (default, unpinned) -> stale job stays hidden", async () => {
  const company = createCompany({ name: "Co A", source_type: "greenhouse", ats_board_token: "co-a" });
  const candidate = createCandidate({ firstName: "A", lastName: "One" });
  const dedupeKey = makeStaleJob(company.id);
  // No candidate_job_state row at all -> defaults to New/unpinned.
  const visible = await forYouDedupeKeys(candidate.id);
  assert.ok(!visible.includes(dedupeKey), "an ordinary New, unpinned stale job must stay hidden");
});

test("Interested (unpinned) -> stale job stays hidden", async () => {
  const company = createCompany({ name: "Co B", source_type: "greenhouse", ats_board_token: "co-b" });
  const candidate = createCandidate({ firstName: "B", lastName: "One" });
  const dedupeKey = makeStaleJob(company.id);
  setPipelineStatus(candidate.id, dedupeKey, "Interested");
  const visible = await forYouDedupeKeys(candidate.id);
  assert.ok(!visible.includes(dedupeKey), "Interested is NOT a protected status — must stay hidden when stale");
});

const PROTECTED_STATUSES: PipelineStatus[] = ["Applied", "Interviewing", "Offer", "Employer Rejected"];
for (const status of PROTECTED_STATUSES) {
  test(`${status} -> stale job stays visible (protected pipeline status)`, async () => {
    const company = createCompany({ name: `Co ${status}`, source_type: "greenhouse", ats_board_token: `co-${status.toLowerCase().replace(/\s+/g, "-")}` });
    const candidate = createCandidate({ firstName: status, lastName: "One" });
    const dedupeKey = makeStaleJob(company.id);
    setPipelineStatus(candidate.id, dedupeKey, status);
    const visible = await forYouDedupeKeys(candidate.id);
    assert.ok(visible.includes(dedupeKey), `${status} is a PROTECTED_PIPELINE_STATUSES member — must stay visible when stale`);
  });
}

test("pinned (New status) -> stale job stays visible", async () => {
  const company = createCompany({ name: "Co Pinned", source_type: "greenhouse", ats_board_token: "co-pinned" });
  const candidate = createCandidate({ firstName: "Pinned", lastName: "One" });
  const dedupeKey = makeStaleJob(company.id);
  setPinned(candidate.id, dedupeKey, true);
  const visible = await forYouDedupeKeys(candidate.id);
  assert.ok(visible.includes(dedupeKey), "pinned must bypass the STALE filter regardless of pipeline status");
});

test("Not Interested -> excluded outright, independent of STALE/protection logic", async () => {
  const company = createCompany({ name: "Co NI", source_type: "greenhouse", ats_board_token: "co-ni" });
  const candidate = createCandidate({ firstName: "NI", lastName: "One" });
  const dedupeKey = makeStaleJob(company.id);
  setPipelineStatus(candidate.id, dedupeKey, "Applied"); // even a protected status...
  setNotInterested(candidate.id, dedupeKey, true); // ...is still excluded once marked Not Interested
  const visible = await forYouDedupeKeys(candidate.id);
  assert.ok(!visible.includes(dedupeKey), "Not Interested excludes the job entirely, even from an otherwise-protected status");
});

test("candidate B pinning a job does NOT make it visible in candidate A's stale-filtered view", async () => {
  const company = createCompany({ name: "Co Shared", source_type: "greenhouse", ats_board_token: "co-shared" });
  const candidateA = createCandidate({ firstName: "Isolation", lastName: "A" });
  const candidateB = createCandidate({ firstName: "Isolation", lastName: "B" });
  const dedupeKey = makeStaleJob(company.id);

  setPinned(candidateB.id, dedupeKey, true); // only B pins it

  const visibleToA = await forYouDedupeKeys(candidateA.id);
  const visibleToB = await forYouDedupeKeys(candidateB.id);
  assert.ok(!visibleToA.includes(dedupeKey), "candidate A never pinned this job — it must stay hidden in A's view");
  assert.ok(visibleToB.includes(dedupeKey), "candidate B did pin it — it must be visible in B's own view");
});
