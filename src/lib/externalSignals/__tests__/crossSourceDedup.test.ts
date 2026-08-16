import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCrossSourceIdentity } from "../crossSourceDedup";
import type { ExternalHiringObservationRow } from "../types";

function makeObservation(overrides: Partial<ExternalHiringObservationRow> = {}): ExternalHiringObservationRow {
  return {
    id: 1,
    source: "indeed",
    provider_job_id: "1",
    fingerprint: "1",
    observed_employer_name: "Acme Robotics",
    observed_title: "Senior Data Engineer",
    observed_location: "Austin, TX",
    observed_url: "https://www.indeed.com/viewjob?jk=1",
    direct_employer_url: "https://boards.greenhouse.io/acmerobotics/jobs/9988776",
    direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/9988776",
    employer_domain: null,
    posted_at: null,
    matched_company_id: 530,
    match_confidence: "DOMAIN",
    employer_relationship: "DIRECT_EMPLOYER",
    url_classification: "DIRECT_ATS",
    detected_ats_provider: "greenhouse",
    detected_ats_board_token: "acmerobotics",
    signal_classification: "COVERAGE_MISMATCH",
    decision: "SECONDARY_JOB_CANDIDATE",
    resulting_job_id: null,
    evidence_json: "{}",
    status: "ACTIVE",
    first_observed_at: "2026-08-16T00:00:00Z",
    last_observed_at: "2026-08-16T00:00:00Z",
    expires_at: "2026-09-06T00:00:00Z",
    created_at: "2026-08-16T00:00:00Z",
    updated_at: "2026-08-16T00:00:00Z",
    ...overrides,
  };
}

// 15. Exact cross-source dedup
test("15/18. two observations (Google + Indeed) with the byte-identical direct ATS URL are EXACT", () => {
  const a = makeObservation({ id: 1, source: "indeed" });
  const b = makeObservation({ id: 2, source: "google_jobs", direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/9988776?utm_source=google" });
  assert.equal(compareCrossSourceIdentity(a, b), "EXACT");
});

// 16. High-confidence cross-source dedup
test("16/19. two observations on the same detected ATS board with the same title+location are HIGH confidence even without a byte-identical URL", () => {
  const a = makeObservation({ id: 1, source: "indeed", direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/9988776" });
  const b = makeObservation({
    id: 2,
    source: "google_jobs",
    direct_apply_url: "https://boards.greenhouse.io/acmerobotics/apply?gh_jid=9988776&ref=google", // different query, same board+token
  });
  assert.equal(compareCrossSourceIdentity(a, b), "HIGH");
});

// 17. Same title but different requisition NOT merged
test("17. same company + same normalized title but different location and no shared board evidence is only POSSIBLE, never auto-merged", () => {
  const a = makeObservation({ id: 1, observed_location: "Austin, TX", detected_ats_provider: null, detected_ats_board_token: null, direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/1111" });
  const b = makeObservation({ id: 2, observed_location: "Denver, CO", detected_ats_provider: null, detected_ats_board_token: null, direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/2222" });
  const confidence = compareCrossSourceIdentity(a, b);
  assert.equal(confidence, "POSSIBLE");
  assert.notEqual(confidence, "EXACT");
  assert.notEqual(confidence, "HIGH");
});

// 20 (Phase 21 numbering: official source wins) — a secondary observation vs an "official" shaped
// observation for the exact same company+title+board is still only ever POSSIBLE/HIGH signal at the
// observation layer; the actual "official wins" behavior lives in secondaryIngestion.test.ts, since
// official jobs never become observation rows at all.
test("two observations for different companies are always DISTINCT regardless of title similarity", () => {
  const a = makeObservation({ id: 1, matched_company_id: 530 });
  const b = makeObservation({ id: 2, matched_company_id: 531 });
  assert.equal(compareCrossSourceIdentity(a, b), "DISTINCT");
});

test("an unmatched observation (no company) is always DISTINCT from anything", () => {
  const a = makeObservation({ id: 1, matched_company_id: null });
  const b = makeObservation({ id: 2, matched_company_id: null });
  assert.equal(compareCrossSourceIdentity(a, b), "DISTINCT");
});

test("tracking-parameter-only URL differences (utm_source, gclid) still resolve to EXACT", () => {
  const a = makeObservation({ id: 1, direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/9988776?utm_source=indeed&utm_medium=organic" });
  const b = makeObservation({ id: 2, direct_apply_url: "https://boards.greenhouse.io/acmerobotics/jobs/9988776?gclid=abc123" });
  assert.equal(compareCrossSourceIdentity(a, b), "EXACT");
});
