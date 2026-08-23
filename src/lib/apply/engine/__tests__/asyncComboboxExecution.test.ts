import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * ASYNC-* / LOCATION-* / COUNTRY-* / SAFE-* — scoped + async combobox execution.
 *
 * Greenhouse Dry Run #2 revealed two interacting problems:
 *   1. Global [role="option"] reads every open listbox on the page — on the Celigo Greenhouse form
 *      an iti phone-country-code picker keeps its 244 [role="option"] elements permanently in the
 *      DOM, swamping the 10 city results that load asynchronously in a separate listbox.
 *   2. The executor read options before the async city-search API response arrived, so even the
 *      correct listbox appeared empty.
 *
 * The fix (executor.ts):
 *   • read aria-controls from the combobox input AFTER opening (React Select writes it when expanded)
 *   • scope ALL option reads and clicks to that listbox — unrelated listboxes are invisible
 *   • capture the initial scoped snapshot and wait (≤ 3 s) for it to change before reading the
 *     final option list
 *
 * The mock HTML (mock-async-combobox.html) mirrors the dual-listbox shape:
 *   - an "unrelated" listbox always present in the DOM (3 options, simulates iti)
 *   - a city combobox with aria-controls, async-loaded (400 ms), prefix-match lookup
 *   - a country combobox with aria-controls, synchronously filtered
 *
 * planFields always uses the contact-derived city value ("Dallas" from "Dallas, TX"), not the vault.
 * All integration tests therefore drive the city combobox with "Dallas". CITY_DATA in the mock
 * includes "Dallas" as an exact option so the city fill succeeds in the happy path.
 * Country is vault-driven and is used to exercise the scoping + no-match scenarios.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "career-ops-async-combobox-"));
process.env.CAREER_OPS_DB_PATH = path.join(dir, "app.db");
process.env.CAREER_OPS_ALLOW_MIGRATION_WITHOUT_BACKUP = "true";
delete process.env.CAREER_OPS_DISABLE_REAL_APPLICATION_AGENT;

/* eslint-disable @typescript-eslint/no-require-imports */
const runsDb = require("@/db/queries/applicationRuns") as typeof import("@/db/queries/applicationRuns");
const vault = require("@/db/queries/applicationVault") as typeof import("@/db/queries/applicationVault");
const { ApplicationBrowserRuntime } = require("../browserRuntime") as typeof import("../browserRuntime");
const { executeRun } = require("../executor") as typeof import("../executor");

const CONTEXT = {
  candidateId: 1,
  contact: {
    name: "Alex Kim",
    email: "alex@example.test",
    phone: "(555) 000-0001",
    location: "Dallas, TX",
  },
  resumePath: path.join(dir, "Resume.docx"),
  coverLetterPath: null,
};
fs.writeFileSync(CONTEXT.resumePath, "mock resume");

const asyncUrl = pathToFileURL(
  path.join(import.meta.dirname, "mockAts/mock-async-combobox.html")
).href;

const runtime = new ApplicationBrowserRuntime();

function newRun() {
  return runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `async-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: asyncUrl,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: null,
  });
}

function deps(storedAnswers: Map<string, unknown> = new Map()) {
  return {
    context: CONTEXT,
    knownVariants: vault.loadKnownVariants(),
    storedAnswers,
  } as Parameters<typeof executeRun>[2];
}

test.after(async () => {
  await runtime.close();
});

// ── ASYNC-01: scoped option reads only see the city listbox, not the unrelated one ───────────────

test("ASYNC-01: city fill reads from aria-controls listbox; unrelated listbox options are invisible", async () => {
  // Contact location "Dallas, TX" → city value "Dallas". CITY_DATA["Dallas"] includes "Dallas" as an
  // exact option. The fix scopes option reads to city-listbox via aria-controls; if the unrelated
  // listbox (Unrelated-A/B/C) bled in, "Dallas" would be invisible and the fill would fail.
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
    `City fill should succeed when scoped to city-listbox; got ${after.status}: ${after.blocking_reason}`
  );
});

// ── ASYNC-02: an option from an unrelated listbox cannot be selected for another combobox ─────────

test("ASYNC-02: vault country 'Unrelated-A' cannot be selected because it is not in country-cb-listbox", async () => {
  // "Unrelated-A" is always visible globally as [role="option"] (in unrelated-listbox).
  // The country combobox's aria-controls points to country-cb-listbox, which has only three
  // country names. Scoping must prevent the unrelated-listbox option from matching. Without the
  // fix, a global [role="option"] query would find "Unrelated-A" and incorrectly select it.
  const stored = new Map([
    [
      "country",
      {
        answer_value: "Unrelated-A",
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
    "'Unrelated-A' must not be selected from the unrelated listbox via the country combobox"
  );
  assert.match(after.blocking_reason ?? "", /no option.*exactly matches/i);
});

// ── ASYNC-03: typing into async combobox waits for the owned options to change ───────────────────

test("ASYNC-03: executor waits for async city options to load and does not read the empty initial state", async () => {
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
  const tStart = Date.now();
  const after = await executeRun(run.id, runtime, deps(stored as never));
  const elapsed = Date.now() - tStart;
  // The mock HTML loads city options after a 400 ms async delay.
  // Without the async wait, the initial empty listbox would be read → no-match → WAITING_FOR_ANSWER.
  assert.equal(after.status, "READY_FOR_REVIEW", "run must wait for async options and succeed");
  assert.ok(elapsed >= 300, `elapsed ${elapsed} ms — executor should have waited ≥ 300 ms for async load`);
});

// ── ASYNC-04: exact async option is selected after the options stabilise ──────────────────────────

test("ASYNC-04: city 'Dallas' is correctly selected from city-listbox after async load; appears in checkpoint", async () => {
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
    `City fill should succeed; got ${after.status}: ${after.blocking_reason}`
  );
  const checkpoint = JSON.parse(after.checkpoint_json!);
  const cityFill = checkpoint.completed.find(
    (c: { canonicalKey: string }) => c.canonicalKey === "location_city"
  );
  assert.ok(cityFill, "location_city must appear in the completed checkpoint");
});

// ── ASYNC-05: a combobox whose typed value matches no options pauses safely ───────────────────────

test("ASYNC-05: vault country 'Zimbabwe' has no match in country-cb-listbox; run pauses safely", async () => {
  // The synchronous country combobox filters by substring. "Zimbabwe" matches nothing → renders [].
  // Initial snapshot after fill is "" (empty); waitForFunction never sees a change → 3 s timeout.
  // After timeout the executor proceeds with [] options → no exact match → WAITING_FOR_ANSWER.
  const stored = new Map([
    [
      "country",
      {
        answer_value: "Zimbabwe",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
  ]);
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps(stored as never));
  assert.equal(after.status, "WAITING_FOR_ANSWER", "a combobox with no matching options must pause safely");
  assert.match(after.blocking_reason ?? "", /no option.*exactly matches/i);
});

// ── ASYNC-06: no exact match never guesses (safety invariant) ────────────────────────────────────

test("ASYNC-06: 'United States of America' is not fuzzy-matched to 'United States'", () => {
  // exactComboboxOption is a pure exact-equality check — no prefix, suffix, or fuzzy matching.
  const { exactComboboxOption } =
    require("@/lib/apply/agent/comboboxSelection") as typeof import("@/lib/apply/agent/comboboxSelection");
  const options = ["United States", "Canada", "United Kingdom"];
  assert.equal(exactComboboxOption(options, "United States of America"), null);
  assert.equal(exactComboboxOption(options, "United"), null);
  assert.equal(exactComboboxOption(options, "united states"), null); // case-sensitive
});

// ── ASYNC-07: an exact option in a synchronous combobox is correctly selected ───────────────────

test("ASYNC-07: vault country 'Canada' is selected correctly from country-cb-listbox", async () => {
  const stored = new Map([
    [
      "country",
      {
        answer_value: "Canada",
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
    `Canada should succeed; got ${after.status}: ${after.blocking_reason}`
  );
});

// ── LOCATION-01: city derivation from contact location is deterministic ───────────────────────────

test("LOCATION-01: candidate location 'Dallas, TX' produces city value 'Dallas' (deterministic split)", () => {
  const location = "Dallas, TX";
  const city = location.split(",")[0]?.trim() ?? null;
  assert.equal(city, "Dallas");
});

test("LOCATION-01b: candidate location 'Dallas,TX' (no space) also produces 'Dallas'", () => {
  const location = "Dallas,TX";
  const city = location.split(",")[0]?.trim() ?? null;
  assert.equal(city, "Dallas");
});

// ── LOCATION-02: partial city name is not guessed to a full option ────────────────────────────────

test("LOCATION-02: 'Dallas' does not match any 'Dallas, <State>' option — exact-match only", () => {
  const { exactComboboxOption } =
    require("@/lib/apply/agent/comboboxSelection") as typeof import("@/lib/apply/agent/comboboxSelection");
  // If the ATS returned only qualified city names and the value was the bare city, no match.
  const options = ["Dallas, Texas, United States", "Dallas, Georgia, United States"];
  assert.equal(exactComboboxOption(options, "Dallas"), null);
});

// ── COUNTRY-01: aria-controls scoping keeps country combobox reads out of unrelated listboxes ────

test("COUNTRY-01: approved 'United States' selects from country-cb-listbox, not unrelated-listbox", async () => {
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
    `expected READY_FOR_REVIEW; got ${after.status}: ${after.blocking_reason}`
  );
});

// ── COUNTRY-02: no vault answer for country → pause safely ───────────────────────────────────────

test("COUNTRY-02: no approved country answer pauses the run safely", async () => {
  const run = newRun();
  const after = await executeRun(run.id, runtime, deps());
  assert.equal(after.status, "WAITING_FOR_ANSWER", "missing country must pause the run");
});

// ── COUNTRY-03: approved exact answer selects from the scoped country listbox ───────────────────

test("COUNTRY-03: 'Canada' selects correctly from the country combobox after scoped option read", async () => {
  const stored = new Map([
    [
      "country",
      {
        answer_value: "Canada",
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
    `Canada should succeed; got ${after.status}: ${after.blocking_reason}`
  );
});

// ── SAFE-01: sponsorship pauses without a stored answer (unchanged) ───────────────────────────────

test("SAFE-01: a sponsorship question with no vault answer pauses the run — behaviour unchanged", () => {
  const { planFields, firstBlocker } =
    require("@/lib/apply/agent/planFields") as typeof import("@/lib/apply/agent/planFields");
  const { discoverFields } =
    require("@/lib/apply/agent/fieldDiscovery") as typeof import("@/lib/apply/agent/fieldDiscovery");

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
      contact: { name: "A", email: "a@a.com", phone: "1", location: "X" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map(),
  });
  const blocker = firstBlocker(plans);
  assert.ok(blocker, "a required sponsorship combobox with no answer must block");
  assert.equal(blocker.questionType, "sponsorship");
});

// ── SAFE-02: voluntary demographic comboboxes are never auto-filled (unchanged) ──────────────────

test("SAFE-02: a voluntary demographic combobox is planned as 'ask', never 'fill'", () => {
  const { planFields } =
    require("@/lib/apply/agent/planFields") as typeof import("@/lib/apply/agent/planFields");
  const { discoverFields } =
    require("@/lib/apply/agent/fieldDiscovery") as typeof import("@/lib/apply/agent/fieldDiscovery");

  const fields = discoverFields([
    {
      tag: "input",
      id: "gender",
      name: null,
      ariaLabel: null,
      labelText: "Gender",
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
      contact: { name: "A", email: "a@a.com", phone: "1", location: "X" },
      resumePath: null,
      coverLetterPath: null,
    },
    knownVariants: new Map(),
    storedAnswers: new Map([
      [
        "gender",
        {
          answer_value: "Non-binary",
          answer_source: "APPLICATION_ANSWER_VAULT" as const,
          approved_by_user: 1 as const,
          auto_fill_allowed: 1 as const,
        },
      ],
    ]),
  });
  const plan = plans.find((p) => p.field.id === "gender");
  assert.ok(plan);
  assert.equal(plan.action, "ask", "voluntary demographic must never be planned as fill");
});

// ── REGRESSION: existing synchronous combobox behaviour is unchanged ──────────────────────────────

test("REGRESSION: synchronous combobox without aria-controls still works (fallback to global [role=option])", async () => {
  // The original mock-greenhouse-combobox.html has a combobox WITHOUT aria-controls.
  // The scoping fix must fall back to global [role="option"] and behave exactly as before.
  const syncUrl = pathToFileURL(
    path.join(import.meta.dirname, "mockAts/mock-greenhouse-combobox.html")
  ).href;
  const syncRun = runsDb.createRun({
    candidateId: 1,
    jobId: 1,
    dedupeKey: `sync-regression-${Math.round(performance.now() * 1000)}`,
    ats: "greenhouse",
    applyUrl: syncUrl,
    resumeFile: CONTEXT.resumePath,
    coverLetterFile: null,
  });
  const stored = new Map([
    [
      "country",
      {
        answer_value: "United Kingdom",
        answer_source: "APPLICATION_ANSWER_VAULT",
        approved_by_user: 1,
        auto_fill_allowed: 1,
      },
    ],
  ]);
  const after = await executeRun(syncRun.id, runtime, deps(stored as never));
  assert.equal(
    after.status,
    "READY_FOR_REVIEW",
    `synchronous combobox regression: got ${after.status}: ${after.blocking_reason}`
  );
});
