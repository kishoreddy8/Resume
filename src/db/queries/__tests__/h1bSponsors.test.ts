import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { NormalizedJob } from "../../../types";

/**
 * H1B Sponsor Intelligence integration tests — run against a real (temp, isolated) SQLite file via
 * CAREER_OPS_DB_PATH (see src/db/index.ts), never touching data/app.db. See
 * src/lib/h1b/__tests__/ for the pure-function tests (normalization, keyword scan, JD override
 * combine logic) that don't need a database at all.
 *
 * Run with: npm test
 */

let tmpDir: string;

let getDb: typeof import("../../index").getDb;
let upsertSponsorFiling: typeof import("../h1bSponsors").upsertSponsorFiling;
let recomputeAllSponsorSummaries: typeof import("../h1bSponsors").recomputeAllSponsorSummaries;
let findSponsorByNormalizedName: typeof import("../h1bSponsors").findSponsorByNormalizedName;
let getFilingsForEmployer: typeof import("../h1bSponsors").getFilingsForEmployer;
let addAlias: typeof import("../h1bSponsors").addAlias;
let matchCompanyToSponsor: typeof import("../../../lib/h1b/fuzzyMatch").matchCompanyToSponsor;
let scoreCompanyConfidence: typeof import("../../../lib/h1b/fuzzyMatch").scoreCompanyConfidence;
let clearH1bMatchCache: typeof import("../../../lib/h1b/fuzzyMatch").clearH1bMatchCache;
let normalizeEmployerName: typeof import("../../../lib/h1b/normalizeEmployerName").normalizeEmployerName;
let createCompany: typeof import("../companies").createCompany;
let getCompany: typeof import("../companies").getCompany;
let updateCompanyH1bConfidence: typeof import("../companies").updateCompanyH1bConfidence;
let listJobs: typeof import("../jobs").listJobs;
let upsertJob: typeof import("../jobs").upsertJob;
let dedupeKeyForAts: typeof import("../../../lib/dedupe").dedupeKeyForAts;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-h1b-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");

  ({ getDb } = await import("../../index"));
  ({ upsertSponsorFiling, recomputeAllSponsorSummaries, findSponsorByNormalizedName, getFilingsForEmployer, addAlias } =
    await import("../h1bSponsors"));
  ({ matchCompanyToSponsor, scoreCompanyConfidence, clearH1bMatchCache } = await import("../../../lib/h1b/fuzzyMatch"));
  ({ normalizeEmployerName } = await import("../../../lib/h1b/normalizeEmployerName"));
  ({ createCompany, getCompany, updateCompanyH1bConfidence } = await import("../companies"));
  ({ listJobs, upsertJob } = await import("../jobs"));
  ({ dedupeKeyForAts } = await import("../../../lib/dedupe"));

  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedFiling(raw: string, fiscalYear: number, certified: number, denied = 0, withdrawn = 0) {
  upsertSponsorFiling({
    employerNameRaw: raw,
    employerNameNormalized: normalizeEmployerName(raw),
    fiscalYear,
    certified,
    denied,
    withdrawn,
    sourceFile: `FY${fiscalYear}.csv`,
  });
}

// --- Idempotent + incremental ingest ------------------------------------------------------------

test("idempotent import: re-ingesting the same fiscal year replaces, not accumulates", () => {
  seedFiling("Umbrella Corp", 2023, 100);
  seedFiling("Umbrella Corp", 2023, 150); // simulates re-running the exact same source file
  recomputeAllSponsorSummaries();

  const sponsor = findSponsorByNormalizedName("UMBRELLA")!;
  assert.equal(sponsor.total_lca_certified, 150, "second ingest replaced, did not add to, the first");

  const filings = getFilingsForEmployer("UMBRELLA");
  assert.equal(filings.length, 1, "still exactly one row for FY2023, not two");
});

test("incremental update: a new fiscal year for an existing employer accumulates at the summary level", () => {
  seedFiling("Initech LLC", 2022, 40);
  recomputeAllSponsorSummaries();
  assert.equal(findSponsorByNormalizedName("INITECH")!.total_lca_certified, 40);

  seedFiling("Initech LLC", 2023, 25); // a genuinely different fiscal year
  recomputeAllSponsorSummaries();

  const sponsor = findSponsorByNormalizedName("INITECH")!;
  assert.equal(sponsor.total_lca_certified, 65, "FY2022 + FY2023 accumulated");
  assert.equal(sponsor.most_recent_fiscal_year, 2023);
  assert.ok(sponsor.fiscal_years_covered?.includes("2022"));
  assert.ok(sponsor.fiscal_years_covered?.includes("2023"));

  const filings = getFilingsForEmployer("INITECH");
  assert.equal(filings.length, 2, "one row per fiscal year, both preserved");
});

// --- Layered matching ----------------------------------------------------------------------------

test("exact match: tier 1, works across suffix/punctuation/case variants", () => {
  seedFiling("Stark Industries Inc", 2024, 30);
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  for (const name of ["Stark Industries", "STARK INDUSTRIES", "Stark Industries, Inc."]) {
    const match = matchCompanyToSponsor(name);
    assert.ok(match, name);
    assert.equal(match!.tier, "exact", name);
    assert.equal(match!.sponsor.employer_name_normalized, "STARK INDUSTRIES");
  }
});

test("alias match: tier 2, resolves a curated name variant to the right employer", () => {
  seedFiling("Wayne Enterprises Holdings", 2024, 12);
  recomputeAllSponsorSummaries();
  addAlias({
    aliasNormalized: normalizeEmployerName("Wayne Corp"),
    employerNameNormalized: normalizeEmployerName("Wayne Enterprises Holdings"),
    notes: "Common short name",
  });
  clearH1bMatchCache();

  const match = matchCompanyToSponsor("Wayne Corp");
  assert.ok(match);
  assert.equal(match!.tier, "alias");
  assert.equal(match!.sponsor.employer_name_normalized, "WAYNE ENTERPRISES");
});

test("high-confidence fuzzy match: a near-exact typo still matches via tier 3", () => {
  seedFiling("Aperture Science", 2024, 20);
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  // Typo in the second word only — the matcher's own prefix-narrowing keys off the first token, so
  // a typo THERE would (correctly) prevent even the fuzzy tier from finding a candidate at all;
  // this is exercising fuzzy scoring, not prefix narrowing.
  const match = matchCompanyToSponsor("Aperture Sciences");
  assert.ok(match);
  assert.equal(match!.tier, "fuzzy");
  assert.ok(match!.score >= 88, `score ${match!.score} should be >= the acceptance floor`);
});

test("false positive avoided: an unrelated company that merely shares a leading word does not match", () => {
  seedFiling("Acme", 2024, 500); // a big, real sponsor
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  // token_set_ratio would score this dangerously high (subset containment); token_sort_ratio
  // correctly recognizes these are not the same company.
  const match = matchCompanyToSponsor("Acme Global Solutions Partners International");
  assert.equal(match, null, "a clearly different, unrelated company must not fuzzy-match");
});

test("false positive avoided: no candidates share a prefix -> no match at all (Unknown)", () => {
  seedFiling("Acme", 2024, 10);
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  const match = matchCompanyToSponsor("Zenith Dynamics");
  assert.equal(match, null);
  const { confidence, evidence } = scoreCompanyConfidence(match);
  assert.equal(confidence, "Unknown");
  assert.match(evidence, /No matching employer found/);
});

test("unknown company: no filings on record at all", () => {
  clearH1bMatchCache();
  const match = matchCompanyToSponsor("Totally Unheard Of Startup Co");
  assert.equal(match, null);
});

// --- Confidence scoring / historical sponsor -----------------------------------------------------

test("historical sponsor: confidence scales with certified filing volume for exact matches", () => {
  seedFiling("Massive Dynamic", 2024, 200); // Very High territory
  seedFiling("Mid Size Co", 2024, 15); // High
  seedFiling("Small Shop", 2024, 3); // Medium
  seedFiling("Tiny Startup", 2024, 1); // Low
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  assert.equal(scoreCompanyConfidence(matchCompanyToSponsor("Massive Dynamic")).confidence, "Very High");
  assert.equal(scoreCompanyConfidence(matchCompanyToSponsor("Mid Size Co")).confidence, "High");
  assert.equal(scoreCompanyConfidence(matchCompanyToSponsor("Small Shop")).confidence, "Medium");
  assert.equal(scoreCompanyConfidence(matchCompanyToSponsor("Tiny Startup")).confidence, "Low");
});

test("fuzzy tier confidence is capped below exact/alias regardless of filing volume", () => {
  seedFiling("Cyberdyne Systems", 2024, 500); // huge volume, but we'll match via a typo
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  const match = matchCompanyToSponsor("Cyberdyn Systems"); // typo -> fuzzy tier
  assert.ok(match);
  assert.equal(match!.tier, "fuzzy");
  const { confidence } = scoreCompanyConfidence(match);
  assert.notEqual(confidence, "Very High", "fuzzy tier must never reach Very High, even with huge volume");
});

test("updateCompanyH1bConfidence persists match tier, evidence, and latest fiscal year on the company row", () => {
  seedFiling("Soylent Corp", 2021, 5);
  seedFiling("Soylent Corp", 2023, 10);
  recomputeAllSponsorSummaries();
  clearH1bMatchCache();

  const company = createCompany({ name: "Soylent", source_type: "greenhouse", ats_board_token: "soylent" });
  const match = matchCompanyToSponsor(company.name);
  const { confidence, evidence } = scoreCompanyConfidence(match);
  updateCompanyH1bConfidence(company.id, {
    confidence,
    matchEmployerName: match?.sponsor.employer_name_raw ?? null,
    matchNormalized: match?.matchedNormalized ?? null,
    matchTier: match?.tier ?? null,
    matchScore: match?.score ?? null,
    lcaCount: match?.sponsor.total_lca_certified ?? 0,
    latestFiscalYear: match?.sponsor.most_recent_fiscal_year ?? null,
    evidence,
  });

  const refreshed = getCompany(company.id)!;
  assert.equal(refreshed.h1b_match_tier, "exact");
  assert.equal(refreshed.h1b_lca_count, 15);
  assert.equal(refreshed.h1b_latest_fiscal_year, 2023);
  assert.ok(refreshed.h1b_confidence_evidence);
  assert.ok(refreshed.h1b_updated_at);
});

// --- Filtering -------------------------------------------------------------------------------

test("filtering: jobs can be filtered by h1bConfidence level", async () => {
  const company = createCompany({ name: "Filter Test Co", source_type: "greenhouse", ats_board_token: "filtertest" });

  function seedJobWithConfidence(externalId: string, confidence: "Very High" | "Unknown" | "Not Sponsoring") {
    const job: NormalizedJob = {
      externalId,
      title: `Role ${externalId}`,
      location: null,
      department: null,
      url: `https://example.com/${externalId}`,
      descriptionHtml: null,
      descriptionText: null,
      employmentType: null,
      workplaceType: null,
      salaryText: null,
      postedAt: null,
      raw: null,
    };
    upsertJob({
      companyId: company.id,
      sourceType: "greenhouse",
      dedupeKey: dedupeKeyForAts("greenhouse", company.id, externalId),
      job,
      descriptionSections: null,
      sponsorshipMentioned: confidence !== "Unknown",
      sponsorshipPolarity: confidence === "Not Sponsoring" ? "negative" : confidence === "Very High" ? "positive" : "none",
      sponsorshipSnippet: null,
      h1bCombinedConfidence: confidence,
    });
  }

  seedJobWithConfidence("a", "Very High");
  seedJobWithConfidence("b", "Unknown");
  seedJobWithConfidence("c", "Not Sponsoring");

  const likely = listJobs({ companyId: company.id, h1bConfidence: ["Very High", "High", "Medium"] });
  assert.deepEqual(likely.map((j) => j.title).sort(), ["Role a"]);

  const notSponsoring = listJobs({ companyId: company.id, h1bConfidence: ["Not Sponsoring"] });
  assert.deepEqual(notSponsoring.map((j) => j.title).sort(), ["Role c"]);

  const all = listJobs({ companyId: company.id });
  assert.equal(all.length, 3, "no h1bConfidence filter returns everything");
});
