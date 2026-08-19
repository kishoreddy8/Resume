import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { before, test } from "node:test";

/**
 * Stage 32 — structural protections for the query-shape work.
 *
 * These assert SHAPE, not wall-clock: an absolute timing assertion would pass or fail with the
 * machine and the OS page cache, and the defects here were all structural anyway (a projection that
 * carried columns nobody read, a statement whose placeholder count grew with the corpus, a join
 * that fell back to random rowid reads because no index covered it). Each test pins the property
 * that made the fix work, so a future edit that quietly reverts it fails here rather than in
 * production.
 *
 * Real measurements that motivated them, on the real corpus (15.7k active jobs, 152k match rows,
 * 1.48 GB job_match_results):
 *   /api/jobs                     10.36 s / 372 MB  ->  0.47 s / 23 MB
 *   /api/operations               13-19 s           ->  0.027 s
 *   /api/candidates/1/for-you     8.7-11.1 s        ->  0.60 s
 *   POST /api/jobs/match-decisions 3.40 s / 9.5 MB  ->  0.097 s / 1.6 MB
 */

let tmpDir: string;
let getDb: typeof import("../../index").getDb;
let createCompany: typeof import("../companies").createCompany;
let upsertJob: typeof import("../jobs").upsertJob;
let listJobs: typeof import("../jobs").listJobs;
let listJobsForList: typeof import("../jobs").listJobsForList;
let listJobsByDedupeKeys: typeof import("../jobs").listJobsByDedupeKeys;
let JOB_LIST_SELECT: typeof import("../jobs").JOB_LIST_SELECT;
let listLatestDecisionsForDedupeKeys: typeof import("../jobMatches").listLatestDecisionsForDedupeKeys;
let listAllLatestDecisionsForCandidate: typeof import("../jobMatches").listAllLatestDecisionsForCandidate;
let createCandidate: typeof import("../candidates").createCandidate;

const HEAVY_COLUMNS = ["description_html", "description_text", "raw_json", "description_sections"];

let candidateId: number;
const dedupeKeys: string[] = [];

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-stage32-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../index"));
  ({ createCompany } = await import("../companies"));
  ({ upsertJob, listJobs, listJobsForList, listJobsByDedupeKeys, JOB_LIST_SELECT } = await import("../jobs"));
  ({ listLatestDecisionsForDedupeKeys, listAllLatestDecisionsForCandidate } = await import("../jobMatches"));
  ({ createCandidate } = await import("../candidates"));

  const db = getDb();
  candidateId = createCandidate({ firstName: "Perf", lastName: "Candidate" }).id;
  const company = createCompany({ name: "Acme Data", source_type: "greenhouse", ats_board_token: "acme" });

  // Enough rows to cross BULK_DECISION_LOOKUP_THRESHOLD / BULK_JOB_KEY_LOOKUP_THRESHOLD (1000),
  // so both the IN-list and the bulk branch are exercised by the tests below.
  const insertJobs = db.transaction(() => {
    for (let i = 0; i < 1200; i++) {
      const dedupeKey = `greenhouse:acme:ext-${i}`;
      upsertJob({
        companyId: company.id,
        sourceType: "greenhouse",
        dedupeKey,
        job: {
          externalId: `ext-${i}`,
          title: `Data Engineer ${i}`,
          location: "Dallas, TX",
          department: null,
          url: `https://example.invalid/jobs/${i}`,
          descriptionHtml: `<p>${"filler ".repeat(200)}</p>`,
          descriptionText: "filler ".repeat(200),
          employmentType: null,
          workplaceType: null,
          salaryText: null,
          postedAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
          raw: { padding: "x".repeat(2000) },
        },
        descriptionSections: null,
        sponsorshipMentioned: false,
        sponsorshipPolarity: "none",
        sponsorshipSnippet: null,
        h1bCombinedConfidence: "Unknown",
      });
      dedupeKeys.push(dedupeKey);
    }
  });
  insertJobs();

  // Two match rows per job so "latest wins" is a real question, not a trivially single-row answer.
  const insertMatch = db.prepare(
    `INSERT INTO job_match_results
       (candidate_id, dedupe_key, job_id, match_engine_version, match_knowledge_hash, candidate_profile_hash,
        candidate_settings_hash, jd_content_hash, eligibility_status, eligibility_reasons, requirement_coverage,
        overall_score, employer_evidenced_share, insufficient_jd_signal, dimension_scores, requirement_breakdown,
        recommended_track, decision, blocking_reasons, status)
     VALUES (?, ?, (SELECT id FROM jobs WHERE dedupe_key = ?), 6, ?, 'ph', 'sh', 'jh', 'UNKNOWN', '[]', 0.5,
             ?, 0.5, 0, '{}', '[]', 'track', ?, '[]', ?)`
  );
  const insertMatches = db.transaction(() => {
    dedupeKeys.forEach((key, i) => {
      // Older row first, then the newer one that must win.
      insertMatch.run(candidateId, key, key, `k-old-${i}`, 10, "BLOCKED", "superseded");
      insertMatch.run(candidateId, key, key, `k-new-${i}`, 90, "READY_FOR_TAILORING", "active");
    });
  });
  insertMatches();
});

// --- Projection: the list must not carry columns it never renders ------------------------------

test("S32-01 the list projection excludes every heavy description column", () => {
  for (const column of HEAVY_COLUMNS) {
    assert.ok(
      !new RegExp(`\\bj\\.${column}\\b`).test(JOB_LIST_SELECT),
      `JOB_LIST_SELECT must not select j.${column} — it is what made /api/jobs a 372 MB response`
    );
  }
});

test("S32-02 the list projection returns the SAME rows in the SAME order as the full query", () => {
  const full = listJobs({ activeOnly: true, candidateId });
  const list = listJobsForList({ activeOnly: true, candidateId });
  assert.equal(list.length, full.length, "narrowing columns must never change how many rows come back");
  assert.deepEqual(
    list.map((j) => j.id),
    full.map((j) => j.id),
    "…nor their order"
  );
  // And the heavy fields really are absent from the narrow rows.
  const row = list[0] as unknown as Record<string, unknown>;
  for (const column of HEAVY_COLUMNS) assert.equal(row[column], undefined, `${column} must not be present`);
  assert.ok((full[0] as unknown as Record<string, unknown>).description_html, "the full query still returns them");
});

test("S32-03 filtering still works on a column the list no longer returns", () => {
  // search matches description_text in SQL; a row may be filtered on without being transferred.
  const hits = listJobsForList({ activeOnly: true, candidateId, search: "filler" });
  assert.ok(hits.length > 0, "search must still match description_text");
  assert.equal((hits[0] as unknown as Record<string, unknown>).description_text, undefined);
});

// --- Bulk vs IN-list: same answer, regardless of which branch runs -----------------------------

test("S32-04 the decision lookup returns identical results above and below the bulk threshold", () => {
  const small = dedupeKeys.slice(0, 50);
  const smallResult = listLatestDecisionsForDedupeKeys(candidateId, small);
  const largeResult = listLatestDecisionsForDedupeKeys(candidateId, dedupeKeys);

  assert.equal(Object.keys(smallResult).length, 50, "the IN-list branch answers for exactly the keys asked");
  assert.equal(Object.keys(largeResult).length, dedupeKeys.length, "the bulk branch answers for all of them");
  for (const key of small) {
    assert.deepEqual(largeResult[key], smallResult[key], `${key} must be identical from either branch`);
  }
});

test("S32-05 the latest match row wins, not an arbitrary one", () => {
  const result = listLatestDecisionsForDedupeKeys(candidateId, dedupeKeys);
  for (const key of dedupeKeys.slice(0, 25)) {
    assert.equal(result[key].decision, "READY_FOR_TAILORING", "the newer row must win");
    assert.equal(result[key].overallScore, 90);
  }
});

test("S32-06 the ROW_NUMBER form selects exactly what a MAX(id) self-join selects", () => {
  // The rewrite is only safe if the two are equivalent; assert that directly against the old shape.
  const db = getDb();
  const legacy = db
    .prepare(
      `SELECT t.dedupe_key, t.decision, t.overall_score, t.employer_evidenced_share, t.requirement_coverage,
              t.insufficient_jd_signal, t.status
       FROM job_match_results t
       INNER JOIN (
         SELECT dedupe_key, MAX(id) AS max_id FROM job_match_results WHERE candidate_id = ? GROUP BY dedupe_key
       ) latest ON latest.max_id = t.id`
    )
    .all(candidateId) as { dedupe_key: string; decision: string; overall_score: number }[];

  const current = listAllLatestDecisionsForCandidate(candidateId);
  assert.equal(legacy.length, Object.keys(current).length);
  for (const row of legacy) {
    assert.equal(current[row.dedupe_key].decision, row.decision, row.dedupe_key);
    assert.equal(current[row.dedupe_key].overallScore, row.overall_score, row.dedupe_key);
  }
});

// --- Index coverage ----------------------------------------------------------------------------

test("S32-07 the operations decision counts are answered from a covering index", () => {
  const plan = getDb()
    .prepare(
      "EXPLAIN QUERY PLAN SELECT decision, COUNT(*) FROM job_match_results WHERE candidate_id = ? AND status = 'active' GROUP BY decision"
    )
    .all(candidateId) as { detail: string }[];
  const detail = plan.map((p) => p.detail).join(" | ");
  assert.match(
    detail,
    /COVERING INDEX idx_job_match_results_candidate_status_decision/,
    `this aggregate must never touch the table again (it read 152k rows from a 1.48 GB table and took 14 s): ${detail}`
  );
});

test("S32-08 the latest-decision lookup is answered from a covering index", () => {
  const plan = getDb()
    .prepare(
      `EXPLAIN QUERY PLAN SELECT dedupe_key FROM (
         SELECT dedupe_key, decision, overall_score, employer_evidenced_share, requirement_coverage,
                insufficient_jd_signal, status,
                ROW_NUMBER() OVER (PARTITION BY dedupe_key ORDER BY id DESC) AS rn
         FROM job_match_results WHERE candidate_id = ?
       ) WHERE rn = 1`
    )
    .all(candidateId) as { detail: string }[];
  const detail = plan.map((p) => p.detail).join(" | ");
  assert.match(detail, /COVERING INDEX idx_job_match_results_latest_decision_covering/, detail);
  assert.ok(!/SEARCH t USING INTEGER PRIMARY KEY/.test(detail), "no per-row rowid fetch may remain");
});

// --- Optional column fetching -------------------------------------------------------------------

test("S32-09 description_text is fetched only when the caller says it needs it", () => {
  const withText = listJobsByDedupeKeys(dedupeKeys, candidateId, { includeDescriptionText: true });
  const withoutText = listJobsByDedupeKeys(dedupeKeys, candidateId, { includeDescriptionText: false });

  assert.equal(withoutText.length, withText.length, "the option changes columns, never rows");
  assert.deepEqual(withoutText.map((j) => j.id), withText.map((j) => j.id), "…and never their order");
  assert.ok(withText[0].description_text, "included by default-style call");
  assert.equal(
    (withoutText[0] as unknown as Record<string, unknown>).description_text,
    undefined,
    "omitted when the caller opts out"
  );
});

test("S32-10 omitting the option keeps every existing caller's rows byte-identical", () => {
  const legacy = listJobsByDedupeKeys(dedupeKeys, candidateId);
  const explicit = listJobsByDedupeKeys(dedupeKeys, candidateId, { includeDescriptionText: true });
  assert.deepEqual(legacy, explicit, "the default must remain 'include', so no caller changes behaviour");
});
