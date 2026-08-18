import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { scanSponsorshipLanguage } from "../../h1b/keywordScan";
import { combineH1bConfidence } from "../../h1b/combineSignal";
import { evaluateEligibility } from "../../match/eligibility";

/**
 * Stage 25B — Blocker 3. Sponsorship-signal data consistency.
 *
 * jobs.sponsorship_polarity is written at SCAN time and nowhere else, so Stage 25A's keywordScan fix
 * for the negated verb form ("<Employer> does not sponsor <object>") applied only to future
 * ingestion. 42 already-ingested active postings kept a stale polarity — 41 at 'none' and one, job
 * 928, at 'positive' with an H1B confidence of "Very High", i.e. the system was actively encouraging
 * a candidate who requires sponsorship toward a posting that says the employer will not sponsor.
 *
 * refreshSponsorshipSignals() recomputes with the SAME scanSponsorshipLanguage() +
 * combineH1bConfidence() pair the scan path uses — no second classifier — and rewrites only rows
 * whose stored value actually differs. These tests pin the semantics that made those rows wrong and
 * the invariants that must survive the rewrite.
 */

let tmpDir: string;
let getDb: typeof import("../../../db/index").getDb;
let createCompany: typeof import("../../../db/queries/companies").createCompany;
let upsertJob: typeof import("../../../db/queries/jobs").upsertJob;
let refreshSponsorshipSignals: typeof import("../backfillJobIntelligence").refreshSponsorshipSignals;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-sponsorship-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  ({ getDb } = await import("../../../db/index"));
  ({ createCompany } = await import("../../../db/queries/companies"));
  ({ upsertJob } = await import("../../../db/queries/jobs"));
  ({ refreshSponsorshipSignals } = await import("../backfillJobIntelligence"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function seedJob(companyId: number, descriptionText: string, storedPolarity: "none" | "positive" | "negative") {
  seq++;
  const dedupeKey = `gh:${companyId}:sponsor-${seq}`;
  upsertJob({
    companyId,
    sourceType: "greenhouse",
    dedupeKey,
    job: {
      externalId: `sponsor-${seq}`,
      title: `Data Engineer ${seq}`,
      location: "Austin, TX",
      department: null,
      url: `https://example.test/${seq}`,
      descriptionHtml: null,
      descriptionText,
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: new Date().toISOString(),
      raw: null,
    },
    descriptionSections: null,
    sponsorshipMentioned: storedPolarity !== "none",
    sponsorshipPolarity: storedPolarity,
    sponsorshipSnippet: null,
    h1bCombinedConfidence: storedPolarity === "positive" ? "Very High" : "Unknown",
  });
  return dedupeKey;
}

test("Blocker 3: a stale 'none' on a 'does not sponsor' posting is corrected to negative", () => {
  const company = createCompany({ name: `NoSponsor Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-a${seq}` });
  // Verbatim from the real corpus (jobs 33053, 16597, 928, 26536).
  const key = seedJob(
    company.id,
    "Ericsson Inc. does not sponsor U.S work authorizations for this job position including U.S. immigration filings.",
    "none"
  );
  const result = refreshSponsorshipSignals({ dryRun: false });
  assert.ok(result.differing >= 1);
  const row = getDb().prepare("SELECT sponsorship_polarity, h1b_combined_confidence FROM jobs WHERE dedupe_key = ?").get(key) as {
    sponsorship_polarity: string;
    h1b_combined_confidence: string;
  };
  assert.equal(row.sponsorship_polarity, "negative");
  assert.equal(row.h1b_combined_confidence, "Not Sponsoring");
});

test("Blocker 3: a stale 'positive' is corrected — the most dangerous direction (real job 928)", () => {
  const company = createCompany({ name: `StalePositive Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-b${seq}` });
  const key = seedJob(
    company.id,
    "PCG does not sponsor newly hired foreign national workers for work authorization, including H-1B sponsorship.",
    "positive"
  );
  refreshSponsorshipSignals({ dryRun: false });
  const row = getDb().prepare("SELECT sponsorship_polarity, h1b_combined_confidence FROM jobs WHERE dedupe_key = ?").get(key) as {
    sponsorship_polarity: string;
    h1b_combined_confidence: string;
  };
  assert.equal(row.sponsorship_polarity, "negative");
  assert.equal(row.h1b_combined_confidence, "Not Sponsoring");
});

test("Blocker 3: a genuine positive stays positive and a silent JD stays 'none'", () => {
  const company = createCompany({ name: `Mixed Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-c${seq}` });
  const positiveKey = seedJob(company.id, "Visa sponsorship is available for this role for exceptional candidates.", "none");
  const silentKey = seedJob(company.id, "We are hiring a data engineer to build streaming pipelines.", "none");
  refreshSponsorshipSignals({ dryRun: false });
  const read = (k: string) =>
    getDb().prepare("SELECT sponsorship_polarity FROM jobs WHERE dedupe_key = ?").get(k) as { sponsorship_polarity: string };
  assert.equal(read(positiveKey).sponsorship_polarity, "positive");
  assert.equal(read(silentKey).sponsorship_polarity, "none", "silence must stay silence — never inferred as a negative");
});

test("Blocker 3: the refresh is idempotent — a second run changes nothing", () => {
  const first = refreshSponsorshipSignals({ dryRun: false });
  const second = refreshSponsorshipSignals({ dryRun: false });
  assert.equal(second.differing, 0, `first run settled ${first.updated} row(s); the second must find nothing`);
  assert.equal(second.updated, 0);
});

test("Blocker 3: a dry run never writes", () => {
  const company = createCompany({ name: `DryRun Co ${seq}`, source_type: "greenhouse", ats_board_token: `tok-d${seq}` });
  const key = seedJob(company.id, "Acme does not sponsor employment visas for this position.", "none");
  const dry = refreshSponsorshipSignals({ dryRun: true });
  assert.ok(dry.differing >= 1, "the dry run must still REPORT the differing row");
  assert.equal(dry.updated, 0);
  const row = getDb().prepare("SELECT sponsorship_polarity FROM jobs WHERE dedupe_key = ?").get(key) as { sponsorship_polarity: string };
  assert.equal(row.sponsorship_polarity, "none", "nothing may be written by a dry run");
});

// --- eligibility semantics that must survive the rewrite -----------------------------------------

const CANDIDATE_NEEDS_SPONSORSHIP = {
  requiresSponsorship: true,
  usCitizen: false,
  workAuthorizedUS: false,
  clearanceLevel: "None",
} as Parameters<typeof evaluateEligibility>[1];

test("Blocker 3: an explicit negative is an absolute BLOCK, whatever the company's H1B history says", () => {
  const result = evaluateEligibility(
    {
      sponsorshipPolarity: "negative",
      companyH1bConfidence: "Very High", // strong company propensity must NOT rescue it
      clearanceRequired: null,
      clearanceLevel: null,
      citizenshipRequired: null,
      workAuthorizationRequired: null,
    },
    CANDIDATE_NEEDS_SPONSORSHIP
  );
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.sponsorship.signal, "explicit_negative");
});

test("Blocker 3: company H1B history stays PROPENSITY evidence, never requisition proof", () => {
  const result = evaluateEligibility(
    {
      sponsorshipPolarity: "none",
      companyH1bConfidence: "High",
      clearanceRequired: null,
      clearanceLevel: null,
      citizenshipRequired: null,
      workAuthorizationRequired: null,
    },
    CANDIDATE_NEEDS_SPONSORSHIP
  );
  assert.equal(result.sponsorship.signal, "silent_company_history");
  assert.match(result.sponsorship.note, /NOT confirmation that this specific requisition will sponsor/);
  assert.notEqual(result.status, "BLOCKED");
});

test("Blocker 3: a genuinely silent posting with no company history stays UNKNOWN, never assumed", () => {
  const result = evaluateEligibility(
    {
      sponsorshipPolarity: "none",
      companyH1bConfidence: "Unknown",
      clearanceRequired: null,
      clearanceLevel: null,
      citizenshipRequired: null,
      workAuthorizationRequired: null,
    },
    CANDIDATE_NEEDS_SPONSORSHIP
  );
  assert.equal(result.status, "UNKNOWN");
  assert.equal(result.sponsorship.signal, "unknown");
});

test("Blocker 3: the refresh uses the authoritative pair, so scan and refresh cannot drift", () => {
  // Any divergence between these two call sites is exactly the class of bug Blocker 3 was.
  const text = "Mars does not sponsor visas for this role.";
  const scanned = scanSponsorshipLanguage(text);
  assert.equal(scanned.polarity, "negative");
  assert.equal(combineH1bConfidence("Very High", scanned.polarity).confidence, "Not Sponsoring");
});
