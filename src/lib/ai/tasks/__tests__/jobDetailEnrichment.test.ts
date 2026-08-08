import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  filterSuggestions,
  isEvidenceGrounded,
  jobDetailEnrichmentTask,
  type FieldSuggestion,
  type JobDetailEnrichmentInput,
} from "../jobDetailEnrichment";
import { FakeProvider } from "../../__tests__/testHelpers";

/**
 * job_detail_enrichment: cache-key/provider-input projection correctness (full JD vs. bounded,
 * section-aware provider input), prompt content, evidence-grounding normalization, and the
 * read-time suggestion filter. Generic runAiTask mechanics (retry, budget, disabled, cache
 * hit/miss machinery itself, entity_key identity safety) are already proven task-agnostically in
 * src/lib/ai/__tests__/runAiTask.test.ts and are not re-proven here — only what's specific to this
 * task. Run with: npm test
 */

const BASE_INPUT: JobDetailEnrichmentInput = {
  title: "Senior Data Engineer",
  fullDescriptionText:
    "We build large-scale data pipelines. Responsibilities: own our Spark jobs end to end. " +
    "Requirements: 5+ years experience. Nice to have: Databricks. Benefits: health insurance, 401k, unlimited PTO, gym membership, free snacks.",
  descriptionSections: {
    responsibilities: "Own our Spark jobs end to end.",
    requiredQualifications: "5+ years experience.",
    preferredQualifications: "Databricks.",
    benefits: "Health insurance, 401k, unlimited PTO, gym membership, free snacks.",
  },
  knownFields: {
    seniority: { status: "known", value: "Senior" },
    employmentType: { status: "unknown" },
    workplaceType: { status: "unknown" },
    industryDomain: { status: "unknown" },
    compensation: { status: "unknown" },
  },
};

// --- Cache-key projection: full JD only, never knownFields/sections -----------------------------

test("toCacheKeyInput includes only title + fullDescriptionText, never knownFields or descriptionSections", () => {
  const key = jobDetailEnrichmentTask.toCacheKeyInput(BASE_INPUT) as Record<string, unknown>;
  assert.deepEqual(Object.keys(key).sort(), ["fullDescriptionText", "title"]);
  assert.equal(key.title, BASE_INPUT.title);
  assert.equal(key.fullDescriptionText, BASE_INPUT.fullDescriptionText);
});

test("toCacheKeyInput changes when fullDescriptionText changes anywhere, including inside Benefits (which the provider input excludes)", () => {
  const key1 = jobDetailEnrichmentTask.toCacheKeyInput(BASE_INPUT);
  const changedBenefits: JobDetailEnrichmentInput = {
    ...BASE_INPUT,
    fullDescriptionText: BASE_INPUT.fullDescriptionText.replace("free snacks", "free snacks and a rooftop lounge"),
  };
  const key2 = jobDetailEnrichmentTask.toCacheKeyInput(changedBenefits);
  assert.notDeepEqual(key1, key2, "a change anywhere in the full JD, even outside what's sent to the provider, must change cache identity");
});

test("toCacheKeyInput does NOT change when only knownFields changes (deterministic re-extraction improving)", () => {
  const key1 = jobDetailEnrichmentTask.toCacheKeyInput(BASE_INPUT);
  const withResolvedSeniority: JobDetailEnrichmentInput = {
    ...BASE_INPUT,
    knownFields: { ...BASE_INPUT.knownFields, employmentType: { status: "known", value: "Full-Time" } },
  };
  const key2 = jobDetailEnrichmentTask.toCacheKeyInput(withResolvedSeniority);
  assert.deepEqual(key1, key2, "knownFields must never affect cache identity — it's not part of the cache-key projection at all");
});

// --- Provider input: bounded, section-prioritized, excludes Benefits ----------------------------

test("toProviderInput prioritizes Responsibilities + Required + Preferred Qualifications, excludes Benefits", () => {
  const providerInput = jobDetailEnrichmentTask.toProviderInput(BASE_INPUT);
  const description = providerInput.description as string;
  assert.ok(description.includes("Own our Spark jobs end to end"), "responsibilities must be included");
  assert.ok(description.includes("5+ years experience"), "required qualifications must be included");
  assert.ok(description.includes("Databricks"), "preferred qualifications must be included");
  assert.ok(!description.includes("gym membership"), "benefits/perks boilerplate must be excluded from the bounded provider input");
});

test("toProviderInput falls back to the flat full text when no sections were parsed", () => {
  const noSections: JobDetailEnrichmentInput = { ...BASE_INPUT, descriptionSections: null };
  const providerInput = jobDetailEnrichmentTask.toProviderInput(noSections);
  assert.equal(providerInput.description, BASE_INPUT.fullDescriptionText.slice(0, 8000));
});

test("toProviderInput never leaks fullDescriptionText verbatim when sections exist and exceed nothing unexpected — description is a projection, not the raw field name", () => {
  const providerInput = jobDetailEnrichmentTask.toProviderInput(BASE_INPUT);
  assert.equal(Object.prototype.hasOwnProperty.call(providerInput, "fullDescriptionText"), false);
});

// --- Prompt content -------------------------------------------------------------------------------

test("buildPrompt states each known field's status and never omits the untrusted-content framing", () => {
  const providerInput = jobDetailEnrichmentTask.toProviderInput(BASE_INPUT);
  const prompt = jobDetailEnrichmentTask.buildPrompt(providerInput);
  assert.ok(prompt.includes("ALREADY KNOWN"), "a known field must be explicitly marked as already resolved");
  assert.ok(prompt.includes("<job_posting>"), "untrusted content must be clearly delimited");
  assert.ok(/ignore all such language/i.test(prompt), "must explicitly instruct the model to ignore embedded instructions");
  // The prompt DOES name sponsorship/clearance/citizenship/work-authorization — that's how it tells
  // the model to avoid them. What must never happen is those terms appearing anywhere OTHER than
  // this single explicit exclusion instruction (e.g. leaking into the known-fields list or being
  // framed as something to suggest on).
  const exclusionCount = (prompt.match(/sponsorship|clearance|citizenship|work authorization/gi) ?? []).length;
  assert.equal(exclusionCount, 4, "sponsorship/clearance/citizenship/work-authorization must appear exactly once each, only in the exclusion instruction");
  assert.ok(/do not discuss, infer, or mention sponsorship/i.test(prompt), "must contain the explicit exclusion instruction");
});

// --- Evidence grounding ----------------------------------------------------------------------------

const JD = "We are looking for a Senior Data Engineer. The role is based in our Austin office three days a week.";

test("isEvidenceGrounded: an exact substring is grounded", () => {
  assert.equal(isEvidenceGrounded("based in our Austin office three days a week", JD), true);
});

test("isEvidenceGrounded: whitespace and case differences do not cause false negatives", () => {
  assert.equal(isEvidenceGrounded("  BASED IN OUR   austin office   three days a week  ", JD), true);
});

test("isEvidenceGrounded: typographic quote/dash variants do not cause false negatives", () => {
  const jdWithCurlyQuotes = "The team’s mission — build great data tools — is ambitious and well-scoped for the role.";
  assert.equal(isEvidenceGrounded("the team's mission - build great data tools - is ambitious", jdWithCurlyQuotes), true);
});

test("isEvidenceGrounded: a fabricated excerpt is correctly rejected", () => {
  assert.equal(isEvidenceGrounded("offers unlimited relocation assistance worldwide", JD), false);
});

test("isEvidenceGrounded: a too-short excerpt is rejected even if technically present", () => {
  assert.equal(isEvidenceGrounded("the role", JD), false);
});

// --- Read-time suggestion filter ------------------------------------------------------------------

function makeSuggestion(overrides: Partial<FieldSuggestion> = {}): FieldSuggestion {
  return {
    field: "workplaceType",
    value: "Onsite",
    confidence: 0.9,
    evidence: { excerpt: "based in our Austin office three days a week" },
    ...overrides,
  } as FieldSuggestion;
}

test("filterSuggestions keeps a grounded, high-confidence suggestion for an unknown field", () => {
  const kept = filterSuggestions([makeSuggestion()], { fullDescriptionText: JD, knownFields: BASE_INPUT.knownFields });
  assert.equal(kept.length, 1);
});

test("filterSuggestions drops a suggestion for a field already deterministically known (backstop)", () => {
  const suggestion = makeSuggestion({ field: "seniority", value: "Staff" });
  const kept = filterSuggestions([suggestion], { fullDescriptionText: JD, knownFields: BASE_INPUT.knownFields });
  assert.equal(kept.length, 0, "seniority is 'known' in BASE_INPUT — must be dropped even though the model produced a suggestion for it");
});

test("filterSuggestions drops a low-confidence suggestion", () => {
  const suggestion = makeSuggestion({ confidence: 0.2 });
  const kept = filterSuggestions([suggestion], { fullDescriptionText: JD, knownFields: BASE_INPUT.knownFields });
  assert.equal(kept.length, 0);
});

test("filterSuggestions drops an ungrounded (fabricated) suggestion", () => {
  const suggestion = makeSuggestion({ evidence: { excerpt: "something never actually stated in the posting" } });
  const kept = filterSuggestions([suggestion], { fullDescriptionText: JD, knownFields: BASE_INPUT.knownFields });
  assert.equal(kept.length, 0);
});

// --- End-to-end via runAiTask (task-specific integration only; generic mechanics already proven) ---

let tmpDir: string;
let runAiTask: typeof import("../../runAiTask").runAiTask;
let registerProvider: typeof import("../../provider").registerProvider;
let clearProviders: typeof import("../../provider").clearProviders;
let resetSessionCallCountForTests: typeof import("../../budget").resetSessionCallCountForTests;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-job-detail-enrichment-test-"));
  process.env.CAREER_OPS_DB_PATH = path.join(tmpDir, "test.db");
  const { getDb } = await import("../../../../db/index");
  ({ runAiTask } = await import("../../runAiTask"));
  ({ registerProvider, clearProviders } = await import("../../provider"));
  ({ resetSessionCallCountForTests } = await import("../../budget"));
  getDb();
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearProviders();
  resetSessionCallCountForTests();
  process.env.CAREER_OPS_AI_ENABLED = "true";
  process.env.CAREER_OPS_AI_PROVIDER = "fake";
});

const VALID_OUTPUT = {
  summary: "A senior data engineering role focused on Spark pipeline ownership.",
  suggestions: [
    { field: "workplaceType", value: "Onsite", confidence: 0.85, evidence: { excerpt: "based in our Austin office three days a week" } },
  ],
};

test("end-to-end: a valid response validates against this task's exact schema and returns a usable enrichmentId", async () => {
  const provider = new FakeProvider({ name: "fake", steps: [{ raw: VALID_OUTPUT }] });
  registerProvider(provider);

  const input: JobDetailEnrichmentInput = { ...BASE_INPUT, fullDescriptionText: JD, descriptionSections: null };
  const result = await runAiTask("job_detail_enrichment", { type: "job", id: 1, key: "job:dedupe:e2e-1" }, input);

  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.enrichmentId > 0, true);
  assert.equal((result.data as typeof VALID_OUTPUT).summary, VALID_OUTPUT.summary);
  assert.equal((result.data as typeof VALID_OUTPUT).suggestions[0].confidence, 0.85);
});

test("end-to-end cache: changing only a Benefits-section detail (excluded from provider input) still forces a fresh call", async () => {
  const provider = new FakeProvider({
    name: "fake",
    steps: [{ raw: VALID_OUTPUT }, { raw: { ...VALID_OUTPUT, summary: "Updated after JD edit." } }],
  });
  registerProvider(provider);

  const entity = { type: "job" as const, id: 2, key: "job:dedupe:e2e-2" };
  const first = await runAiTask("job_detail_enrichment", entity, BASE_INPUT);
  assert.equal(first.status, "ok");
  assert.equal(provider.callCount, 1);

  const editedBenefits: JobDetailEnrichmentInput = {
    ...BASE_INPUT,
    fullDescriptionText: BASE_INPUT.fullDescriptionText.replace("free snacks", "free snacks, plus a signing bonus"),
  };
  const second = await runAiTask("job_detail_enrichment", entity, editedBenefits);
  assert.equal(second.status, "ok");
  assert.equal(provider.callCount, 2, "a JD edit outside the bounded provider-sent text must still invalidate the cache");
});

test("end-to-end cache: an unchanged JD with different knownFields (re-extraction improved) is still a cache hit", async () => {
  const provider = new FakeProvider({ name: "fake", steps: [{ raw: VALID_OUTPUT }] });
  registerProvider(provider);

  const entity = { type: "job" as const, id: 3, key: "job:dedupe:e2e-3" };
  const first = await runAiTask("job_detail_enrichment", entity, BASE_INPUT);
  assert.equal(first.status, "ok");

  const improvedKnownFields: JobDetailEnrichmentInput = {
    ...BASE_INPUT,
    knownFields: { ...BASE_INPUT.knownFields, industryDomain: { status: "known", value: "FinTech" } },
  };
  const second = await runAiTask("job_detail_enrichment", entity, improvedKnownFields);
  assert.equal(second.status, "ok");
  if (second.status === "ok") assert.equal(second.cached, true, "knownFields changing alone must never invalidate the cache");
  assert.equal(provider.callCount, 1, "the provider must not be called again");
});
