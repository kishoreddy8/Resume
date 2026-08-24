import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * LOC-* / REG-* — Greenhouse location normalisation + vault precedence.
 *
 * Gap confirmed by Dry Run #2:
 *   • contactValueFor("location_city") returns bare "Dallas" (from "Dallas, TX").
 *   • The Greenhouse city combobox returns canonical "Dallas, Texas, United States".
 *   • exactComboboxOption("Dallas, Texas, United States", "Dallas") → null → WAITING_FOR_ANSWER.
 *
 * Two-layer fix:
 *   1. locationNormalizer.ts — pure deterministic bridge:
 *        locationsCompatible("Dallas, TX", "Dallas, Texas, United States") → true
 *        locationsCompatible("Dallas, TX", "Dallas, Georgia, United States") → false
 *        findCanonicalLocation("Dallas, TX", [...])  → the unique compatible option or null
 *   2. planFields.ts — vault precedence for location_city:
 *        vault compatible → use vault canonical form (executor exact-matches it)
 *        vault conflicts  → ask (do NOT overwrite verified profile city)
 *        no vault         → bare city + locationContext carried to executor for normalisation
 *   3. executor.ts — optional normaliser on selectComboboxOption, used only for location_city.
 *
 * REG-* tests confirm that every OTHER question type is not affected.
 */

/* ── shared db setup ──────────────────────────────────────────────────────────────────────────── */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-loc-norm-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../../engine/browserRuntime") as typeof import("../../engine/browserRuntime");
const { executeRun } = require("../../engine/executor") as typeof import("../../engine/executor");

const RESUME = path.join(dir, "Resume.docx");
fs.writeFileSync(RESUME, "mock resume");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Alex Kim",
    email: "alex@example.test",
    phone: "(555) 000-0001",
    location: "Dallas, TX",
  },
  resumePath: RESUME,
  coverLetterPath: null as string | null,
};

const MCKINNEY_CONTEXT = {
  ...CONTEXT,
  contact: { ...CONTEXT.contact, location: "McKinney, TX" },
};

const asyncUrl = pathToFileURL(
  path.join(import.meta.dirname, "../../engine/__tests__/mockAts/mock-async-combobox.html")
).href;

const runtime = new ApplicationBrowserRuntime();
test.after(async () => { await runtime.close(); });

let runCounter = 0;
function newRun(ctx = CONTEXT) {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `loc-${runCounter++}-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: asyncUrl,
    resumeFile: ctx.resumePath,
    coverLetterFile: null,
  });
}

function deps(storedAnswers: Map<string, unknown> = new Map(), ctx = CONTEXT) {
  return {
    context: ctx,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers,
  } as Parameters<typeof executeRun>[2];
}

/* ── pure unit tests (locationNormalizer.ts) ──────────────────────────────────────────────────── */

const { locationsCompatible, findCanonicalLocation } =
  require("@/lib/apply/agent/locationNormalizer") as typeof import("../locationNormalizer");

// LOC-01: state code "TX" equals full state name "Texas"
test("LOC-01: 'Dallas, TX' is compatible with 'Dallas, Texas, United States'", () => {
  assert.equal(locationsCompatible("Dallas, TX", "Dallas, Texas, United States"), true);
});

// LOC-02: compact ("Dallas,TX") vs full state name with and without spaces
test("LOC-02: 'Dallas,TX' (no space) is compatible with 'Dallas, Texas, United States'", () => {
  assert.equal(locationsCompatible("Dallas,TX", "Dallas, Texas, United States"), true);
});

// LOC-03: profile full state name is equivalent to code
test("LOC-03: 'Dallas, Texas' is compatible with 'Dallas, Texas, United States'", () => {
  assert.equal(locationsCompatible("Dallas, Texas", "Dallas, Texas, United States"), true);
});

// LOC-04: different state → incompatible, even same city
test("LOC-04: 'Dallas, TX' is NOT compatible with 'Dallas, Georgia, United States'", () => {
  assert.equal(locationsCompatible("Dallas, TX", "Dallas, Georgia, United States"), false);
});

// LOC-05: profile with no state cannot confirm a state-qualified ATS option
test("LOC-05: bare city 'Dallas' with no state is NOT compatible with 'Dallas, Texas, United States'", () => {
  // We cannot confirm TX just because the city name matches — the profile must carry the state.
  assert.equal(locationsCompatible("Dallas", "Dallas, Texas, United States"), false);
});

// LOC-06: two options both match → findCanonicalLocation returns null (ambiguous)
test("LOC-06: when multiple options are compatible, findCanonicalLocation returns null (no guess)", () => {
  // Both "Dallas, TX" options → ambiguous (e.g. two different data-model entries with same state)
  const result = findCanonicalLocation("Dallas, TX", [
    "Dallas, Texas, United States",
    "Dallas, Texas, United States",
  ]);
  assert.equal(result, null, "two identical compatible options must return null — never guess");
});

// LOC-07: different city → incompatible
test("LOC-07: 'McKinney, TX' is NOT compatible with 'Dallas, Texas, United States'", () => {
  assert.equal(locationsCompatible("McKinney, TX", "Dallas, Texas, United States"), false);
});

// LOC-08: findCanonicalLocation picks the unique Texas option when others are different states
test("LOC-08: findCanonicalLocation('Dallas, TX', [...]) returns 'Dallas, Texas, United States'", () => {
  const options = [
    "Dallas, Texas, United States",
    "Dallas, Georgia, United States",
    "Dallas, Oregon, United States",
  ];
  assert.equal(findCanonicalLocation("Dallas, TX", options), "Dallas, Texas, United States");
});

// LOC-09: no compatible option → null
test("LOC-09: findCanonicalLocation returns null when no option is compatible", () => {
  const options = ["Austin, Texas, United States", "Houston, Texas, United States"];
  assert.equal(findCanonicalLocation("Dallas, TX", options), null);
});

// LOC-10: ATS option with no state is compatible when city matches (no state to conflict)
test("LOC-10: profile 'Dallas, TX' is compatible with a bare city option 'Dallas' (no state conflict)", () => {
  // Some ATS boards return just the city name with no state qualifier — that's compatible because
  // there is no state information to disagree with.
  assert.equal(locationsCompatible("Dallas, TX", "Dallas"), true);
});

/* ── integration tests (planFields + executor via executeRun) ─────────────────────────────────── */

// LOC-INT-01: no vault for location_city → profile bare city → normaliser finds canonical option
test("LOC-INT-01: no vault for location_city — normaliser resolves 'Dallas, TX' to canonical ATS option", async () => {
  const stored = new Map([
    [
      "country",
      {
        answer_value: "United States",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
  ]);
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps(stored as never));
  assert.equal(
    after.status,
    "READY_FOR_REVIEW",
    `normaliser must resolve bare 'Dallas' to ATS canonical; got ${after.status}: ${after.blocking_reason}`
  );
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const cityEntry = checkpoint.completed.find(
    (c: { canonicalKey: string }) => c.canonicalKey === "location_city"
  );
  assert.ok(cityEntry, "location_city must appear in the checkpoint after normalised selection");
});

// LOC-INT-02: vault has compatible canonical form → planFields uses vault, executor exact-matches it
test("LOC-INT-02: vault 'Dallas, Texas, United States' is compatible with profile 'Dallas, TX' → used directly", async () => {
  const stored = new Map([
    [
      "location_city",
      {
        answer_value: "Dallas, Texas, United States",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
    [
      "country",
      {
        answer_value: "United States",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
  ]);
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps(stored as never));
  assert.equal(
    after.status,
    "READY_FOR_REVIEW",
    `vault canonical should be used directly; got ${after.status}: ${after.blocking_reason}`
  );
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const cityEntry = checkpoint.completed.find(
    (c: { canonicalKey: string; source: string }) => c.canonicalKey === "location_city"
  );
  assert.ok(cityEntry, "location_city must appear in checkpoint");
  assert.equal(cityEntry.source, "APPLICATION_ANSWER_VAULT", "source must be VAULT when vault answer was used");
});

// LOC-INT-03: vault city conflicts with profile → planFields asks → run pauses
test("LOC-INT-03: vault 'Austin, Texas, United States' conflicts with profile 'Dallas, TX' → run asks", async () => {
  const stored = new Map([
    [
      "location_city",
      {
        answer_value: "Austin, Texas, United States",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
    [
      "country",
      {
        answer_value: "United States",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
  ]);
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps(stored as never));
  assert.equal(
    after.status,
    "WAITING_FOR_ANSWER",
    "conflicting vault city must pause the run — never override the verified profile city"
  );
  assert.match(
    after.blocking_reason ?? after.blocking_question ?? "",
    /saved city.*match|match.*profile|saved city/i
  );
});

// LOC-INT-04: McKinney, TX resolves to McKinney, Texas, United States
test("LOC-INT-04: profile 'McKinney, TX' resolves to 'McKinney, Texas, United States' via normaliser", async () => {
  const stored = new Map([
    [
      "country",
      {
        answer_value: "United States",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
  ]);
  const run = newRun(MCKINNEY_CONTEXT);
  const after = await executeRun(run.id, runtime, deps(stored as never, MCKINNEY_CONTEXT));
  assert.equal(
    after.status,
    "READY_FOR_REVIEW",
    `McKinney, TX should normalise to McKinney, Texas, United States; got ${after.status}: ${after.blocking_reason}`
  );
});

/* ── regression tests — unrelated question types are unchanged ────────────────────────────────── */

// REG-01: non-city contact fields (email, name) still come from profile, not vault
test("REG-01: email and name fill from profile even when vault has a conflicting entry", () => {
  const { planFields } =
    require("@/lib/apply/agent/planFields") as typeof import("../planFields");
  const { discoverFields } =
    require("@/lib/apply/agent/fieldDiscovery") as typeof import("../fieldDiscovery");

  const fields = discoverFields([
    {
      tag: "input",
      id: "email",
      name: null,
      ariaLabel: null,
      labelText: "Email",
      type: "email",
      required: true,
      role: null,
      className: "",
    },
    {
      tag: "input",
      id: "full_name",
      name: null,
      ariaLabel: null,
      labelText: "Full Name",
      type: "text",
      required: true,
      role: null,
      className: "",
    },
  ]);
  const plans = planFields({
    fields,
    context: {
      candidateId: 1,
      contact: { name: "Alex Kim", email: "alex@example.test", phone: "5550001", location: "Dallas, TX" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map([
      [
        "email",
        { answer_value: "other@email.com", answer_source: "APPLICATION_ANSWER_VAULT" as const, approved_by_user: 1 as const, auto_fill_allowed: 1 as const },
      ],
      [
        "full_name",
        { answer_value: "Different Name", answer_source: "APPLICATION_ANSWER_VAULT" as const, approved_by_user: 1 as const, auto_fill_allowed: 1 as const },
      ],
    ]),
  });
  const emailPlan = plans.find((p) => p.field.id === "email");
  const namePlan = plans.find((p) => p.field.id === "full_name");
  assert.ok(emailPlan?.action === "fill" && emailPlan.value === "alex@example.test", "email must come from profile");
  assert.ok(namePlan?.action === "fill" && namePlan.value === "Alex Kim", "name must come from profile");
});

// REG-02: sponsorship question still blocks without a stored answer
test("REG-02: sponsorship field with no vault answer still blocks — planFields unchanged for sponsorship", () => {
  const { planFields, firstBlocker } =
    require("@/lib/apply/agent/planFields") as typeof import("../planFields");
  const { discoverFields } =
    require("@/lib/apply/agent/fieldDiscovery") as typeof import("../fieldDiscovery");

  const fields = discoverFields([
    {
      tag: "input",
      id: "sponsor",
      name: null,
      ariaLabel: null,
      labelText: "Will you require visa sponsorship?",
      type: "text",
      required: true,
      role: "combobox",
      className: "select__input",
    },
  ]);
  const plans = planFields({
    fields,
    context: {
      candidateId: 1,
      contact: { name: "A", email: "a@a.com", phone: "1", location: "Dallas, TX" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const blocker = firstBlocker(plans);
  assert.ok(blocker, "sponsorship with no vault must still block");
  assert.equal(blocker.questionType, "sponsorship");
});

// REG-03: voluntary demographic combobox is never auto-filled
test("REG-03: voluntary demographic combobox is still never auto-filled — safety unchanged", () => {
  const { planFields } =
    require("@/lib/apply/agent/planFields") as typeof import("../planFields");
  const { discoverFields } =
    require("@/lib/apply/agent/fieldDiscovery") as typeof import("../fieldDiscovery");

  const fields = discoverFields([
    {
      tag: "input",
      id: "ethnicity",
      name: null,
      ariaLabel: null,
      labelText: "Ethnicity",
      type: "text",
      required: false,
      role: "combobox",
      className: "select__input",
    },
  ]);
  const plans = planFields({
    fields,
    context: {
      candidateId: 1,
      contact: { name: "A", email: "a@a.com", phone: "1", location: "Dallas, TX" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map([
      [
        "ethnicity",
        {
          answer_value: "Prefer not to say",
          answer_source: "APPLICATION_ANSWER_VAULT" as const,
          approved_by_user: 1 as const,
          auto_fill_allowed: 1 as const,
        },
      ],
    ]),
  });
  const plan = plans.find((p) => p.field.id === "ethnicity");
  assert.ok(plan);
  assert.equal(plan.action, "ask", "voluntary demographic must never be planned as fill");
});
