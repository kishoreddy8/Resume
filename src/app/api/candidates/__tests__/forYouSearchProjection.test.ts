import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { NextRequest } from "next/server";
import type { ForYouApiResponse } from "../[candidateId]/for-you/route";

/**
 * Stage 32 follow-up — the For You SEARCH path must not reintroduce the full-job projection.
 *
 * The unsearched feed has always used a compact projection, but a text search took a different
 * branch that selected `j.*` and shipped every column back. On the real corpus that was ~5.3 MB per
 * searched request against ~376 KB unsearched: description_html, description_sections and raw_json
 * are read by nothing, and description_text is read only by the server-side filters below — never
 * by the list UI.
 *
 * These tests pin both halves of the fix:
 *   1. no heavy column appears in a searched response, and
 *   2. searching changes WHICH jobs come back and in what order — never the shape of a job, and
 *      never the recommendation semantics attached to it.
 *
 * The second half matters more than the first. Trimming a payload is only correct if the trimmed
 * response still describes the same feed, so the assertions compare ids, order, buckets, decisions
 * and scores against the unsearched response rather than merely counting bytes.
 */

/** Read by nothing in the list contract. None of these may appear in a For You entry. */
const HEAVY_COLUMNS = ["description_html", "description_sections", "raw_json"] as const;
/** Read by the server-side search/skills filters, never sent to the client. */
const SERVER_ONLY_COLUMNS = ["description_text"] as const;

let tmpDir: string;
let createCandidate: typeof import("@/db/queries/candidates").createCandidate;
let createCompany: typeof import("@/db/queries/companies").createCompany;
let upsertJob: typeof import("@/db/queries/jobs").upsertJob;
let GET: typeof import("../[candidateId]/for-you/route").GET;

let candidateId: number;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-foryou-projection-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  const { getDb } = await import("@/db/index");
  ({ createCandidate } = await import("@/db/queries/candidates"));
  ({ createCompany } = await import("@/db/queries/companies"));
  ({ upsertJob } = await import("@/db/queries/jobs"));
  ({ GET } = await import("../[candidateId]/for-you/route"));
  getDb();

  candidateId = createCandidate({ firstName: "Projection", lastName: "Candidate" }).id;
  const companyId = createCompany({ name: "Snowdrift Analytics", source_type: "greenhouse", ats_board_token: "snowdrift" }).id;

  // A deliberately fat body: if the full-job projection ever comes back, these bytes come with it.
  // Note the body deliberately shares no term with either title, so a title search genuinely
  // narrows the feed and a body search genuinely proves description_text is still filtered on.
  const fatBody = "Owns delivery cadence and incident rotation. ".repeat(400);
  const now = new Date().toISOString();

  for (let i = 1; i <= 6; i++) {
    upsertJob({
      companyId,
      sourceType: "greenhouse",
      dedupeKey: `gh:projection:${i}`,
      job: {
        externalId: `projection-${i}`,
        // Half match the query in the title, half only in the body, so the search genuinely
        // exercises both the SQL filter and the description_text filter.
        title: i % 2 === 0 ? `Snowflake Data Engineer ${i}` : `Platform Engineer ${i}`,
        location: "Austin, TX",
        department: "Engineering",
        url: `https://example.com/jobs/${i}`,
        descriptionHtml: `<p>${fatBody}</p>`,
        descriptionText: fatBody,
        employmentType: "Full Time",
        workplaceType: "Hybrid",
        salaryText: "$150,000",
        postedAt: now,
        raw: { padding: fatBody },
      },
      descriptionSections: JSON.stringify({ responsibilities: fatBody }),
      sponsorshipMentioned: true,
      sponsorshipPolarity: "positive",
      sponsorshipSnippet: "Visa sponsorship available",
      h1bCombinedConfidence: "High",
    });
  }
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function feed(search?: string): Promise<ForYouApiResponse> {
  const qs = search === undefined ? "" : `?search=${encodeURIComponent(search)}`;
  const res = await GET(
    new NextRequest(`http://localhost/api/candidates/${candidateId}/for-you${qs}`),
    { params: Promise.resolve({ candidateId: String(candidateId) }) }
  );
  assert.equal(res.status, 200);
  return (await res.json()) as ForYouApiResponse;
}

test("FY-P1 the unsearched feed carries no heavy or server-only column", async () => {
  const body = await feed();
  assert.ok(body.entries.length > 0, "fixture should produce a non-empty feed");
  for (const entry of body.entries) {
    for (const column of [...HEAVY_COLUMNS, ...SERVER_ONLY_COLUMNS]) {
      assert.ok(!(column in entry.job), `unsearched entry must not carry ${column}`);
    }
  }
});

test("FY-P2 a searched feed carries no heavy or server-only column either", async () => {
  for (const query of ["Snowflake", "snowflake data", "incident rotation"]) {
    const body = await feed(query);
    assert.ok(body.entries.length > 0, `"${query}" should match the fixture`);
    for (const entry of body.entries) {
      for (const column of HEAVY_COLUMNS) {
        assert.ok(!(column in entry.job), `search "${query}" leaked ${column} — full-job projection is back`);
      }
      for (const column of SERVER_ONLY_COLUMNS) {
        assert.ok(!(column in entry.job), `search "${query}" leaked ${column} — it is a filter input, not list data`);
      }
    }
  }
});

test("FY-P3 searched and unsearched entries have the identical job shape", async () => {
  const plain = await feed();
  const searched = await feed("Snowflake");
  const plainKeys = Object.keys(plain.entries[0].job).sort();
  const searchedKeys = Object.keys(searched.entries[0].job).sort();
  assert.deepEqual(searchedKeys, plainKeys, "searching must not change which columns a job carries");
});

test("FY-P4 search still matches on description_text, which is filtered on but never returned", async () => {
  // The phrase exists only in the body, never in a title — so a hit proves the server still reads
  // description_text even though the response no longer contains it.
  const body = await feed("incident rotation");
  assert.ok(body.entries.length > 0, "body-only search must still match");
  for (const entry of body.entries) {
    assert.ok(!("description_text" in entry.job));
  }
});

test("FY-P5 search narrows the feed without altering recommendation semantics", async () => {
  const plain = await feed();
  const searched = await feed("Snowflake");

  const plainById = new Map(plain.entries.map((e) => [e.job.id, e]));
  assert.ok(searched.entries.length > 0);
  assert.ok(searched.entries.length < plain.entries.length, "this search should narrow the feed");

  // Every surviving job keeps the exact ranking payload it had unsearched, and their relative
  // order is preserved — a projection change must not reorder or re-rank anything.
  const expectedOrder = plain.entries
    .filter((e) => searched.entries.some((s) => s.job.id === e.job.id))
    .map((e) => e.job.id);
  assert.deepEqual(searched.entries.map((e) => e.job.id), expectedOrder, "search must preserve relative order");

  for (const entry of searched.entries) {
    const before = plainById.get(entry.job.id);
    assert.ok(before, `searched job ${entry.job.id} must also appear unsearched`);
    assert.deepEqual(entry.ranking, before.ranking, "ranking payload must be identical");
    assert.equal(entry.job.h1b_combined_confidence, before.job.h1b_combined_confidence);
    assert.equal(entry.job.company_h1b_confidence, before.job.company_h1b_confidence);
  }
});

test("FY-P6 a search matching nothing returns an empty feed, not an error", async () => {
  const body = await feed("zzzz-no-such-posting-zzzz");
  assert.deepEqual(body.entries, []);
});
