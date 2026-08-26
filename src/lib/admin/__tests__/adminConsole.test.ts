import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  ACTION_KIND_PRESENTATION,
  CAPABILITY_PRESENTATION,
  FORBIDDEN_DIAGNOSTIC_VERBS,
  HEALTH_PRESENTATION,
  REPAIRABILITY_PRESENTATION,
  awaitingEvidence,
  formatFreshness,
  labelOverclaims,
  needsAttention,
  orderForDisplay,
  primaryEvidenceLabel,
} from "../healthPresentation";
import type { HealthStatus } from "@/lib/operations/healthRules";

/* ================================================================================================
 * UI-ADMIN-1 — the Admin console renders the frozen contract without reinterpreting it.
 *
 * The console has no jsdom harness in this repo, so the design puts every decision worth testing
 * into pure functions and tests those directly; the component source is asserted only for wiring
 * that cannot be expressed as a function (which endpoint is called, that a refetch happens).
 * ============================================================================================== */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const CONSOLE_SRC = read("src/components/admin/OperationsConsole.tsx");
const PAGE_SRC = read("src/app/admin/page.tsx");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const CONSOLE_CODE = code(CONSOLE_SRC);

const ALL: HealthStatus[] = ["HEALTHY", "WARNING", "ERROR", "DISABLED", "NO_DATA"];
const sub = (id: string, status: HealthStatus, repairability = "UNKNOWN" as const) => ({ id, status, repairability, label: id });

// --- UIADMIN-01 ------------------------------------------------------------------------------------

test("UIADMIN-01: every server status has a distinct, complete presentation", () => {
  for (const status of ALL) {
    const p = HEALTH_PRESENTATION[status];
    assert.ok(p, `${status} must render`);
    assert.ok(p.label && p.symbol && p.meaning, `${status} must carry label, symbol and meaning`);
  }
  /* All five must be distinguishable from one another by TEXT, not merely by colour. */
  const labels = ALL.map((s) => HEALTH_PRESENTATION[s].label);
  assert.equal(new Set(labels).size, ALL.length, "two statuses share a label");
  const symbols = ALL.map((s) => HEALTH_PRESENTATION[s].symbol);
  assert.equal(new Set(symbols).size, ALL.length, "two statuses share a symbol");
});

test("UIADMIN-01b: the console renders the server's subsystem list, not a hardcoded one", () => {
  assert.match(CONSOLE_CODE, /view\.subsystems/, "the tiles come from the server payload");
  /* No subsystem id may be written into the component — the seven are the server's to define. */
  for (const id of ["scheduler", "scanner", "writer", "applications", "notifications", "database", "discovery_connectors"]) {
    assert.ok(!new RegExp(`["']${id}["']`).test(CONSOLE_CODE), `${id} must not be hardcoded in the console`);
  }
});

// --- UIADMIN-02 / 03 / 04 --------------------------------------------------------------------------

test("UIADMIN-02: ERROR and WARNING are surfaced, most severe first", () => {
  const list = [sub("a", "HEALTHY"), sub("b", "WARNING"), sub("c", "ERROR"), sub("d", "DISABLED"), sub("e", "NO_DATA")];
  const attention = needsAttention(list);
  assert.deepEqual(attention.map((s) => s.id), ["c", "b"], "errors lead, warnings follow");
});

test("UIADMIN-03: NO_DATA is neither healthy nor a failure", () => {
  const list = [sub("a", "HEALTHY"), sub("b", "NO_DATA"), sub("c", "ERROR")];
  assert.ok(!needsAttention(list).some((s) => s.id === "b"), "NO_DATA is not raised as a failure");
  assert.deepEqual(awaitingEvidence(list).map((s) => s.id), ["b"], "it is surfaced separately");

  assert.notEqual(HEALTH_PRESENTATION.NO_DATA.tone, "positive", "never green");
  assert.notEqual(HEALTH_PRESENTATION.NO_DATA.tone, "critical", "never red");
  assert.match(HEALTH_PRESENTATION.NO_DATA.meaning, /no claim can be made/i);
});

test("UIADMIN-04: DISABLED is distinct from ERROR in every channel", () => {
  const disabled = HEALTH_PRESENTATION.DISABLED;
  const error = HEALTH_PRESENTATION.ERROR;
  assert.notEqual(disabled.tone, error.tone);
  assert.notEqual(disabled.label, error.label);
  assert.notEqual(disabled.symbol, error.symbol);
  /* UI-ADMIN-1.1 — the copy must say this subsystem is off, and must NOT make the wider claim that
   * nothing anywhere is broken, which DISABLED evidences nothing about. */
  assert.match(disabled.meaning, /not running/i, "DISABLED must say the subsystem is not running");
  assert.match(disabled.meaning, /choice, not a failure/i, "and that this is intentional");
  assert.doesNotMatch(disabled.meaning, /nothing is broken/i, "but must not issue a blanket all-clear");

  /* And a switched-off subsystem is never dragged into the attention list. */
  assert.deepEqual(needsAttention([sub("x", "DISABLED")]), []);
  assert.deepEqual(awaitingEvidence([sub("x", "DISABLED")]), [], "nor into awaiting-evidence");
});

// --- UIADMIN-05 ------------------------------------------------------------------------------------

test("UIADMIN-05: staleness is the server's verdict and is never recomputed", () => {
  const long_ago = new Date(Date.now() - 6 * 60 * 60_000).toISOString();

  /* An ancient observation the SERVER says is fresh stays fresh. A component that compared
   * observedAt against staleAfterMs would override the server here — that is the bug being pinned. */
  assert.equal(formatFreshness(long_ago, false).stale, false, "the server said fresh; the client must agree");
  /* And a recent observation the server calls stale stays stale. */
  assert.equal(formatFreshness(new Date().toISOString(), true).stale, true);

  /* No staleness arithmetic anywhere in the console. */
  assert.doesNotMatch(CONSOLE_CODE, /staleAfterMs/, "the console must not touch the threshold");
  assert.doesNotMatch(CONSOLE_CODE, /Date\.now\(\)/, "no client-side time comparison");
  assert.match(CONSOLE_CODE, /subsystem\.stale/, "the server flag is what is rendered");
});

test("UIADMIN-05b: freshness wording is formatting only, and absence is stated plainly", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");
  assert.match(formatFreshness("2026-01-01T11:58:00.000Z", false, now).text, /2 min ago/);
  assert.match(formatFreshness("2026-01-01T11:59:50.000Z", false, now).text, /just now/);
  assert.match(formatFreshness("2026-01-01T09:00:00.000Z", false, now).text, /3 hr ago/);

  const never = formatFreshness(null, false, now);
  assert.equal(never.kind, "NEVER_OBSERVED");
  assert.match(never.text, /No observation recorded/);
  /* An unparseable instant must not be rendered as a duration. */
  assert.equal(formatFreshness("not-a-date", false, now).kind, "NEVER_OBSERVED");
});

// --- UIADMIN-06 ------------------------------------------------------------------------------------

test("UIADMIN-06: evidence is rendered as given, not reinterpreted", () => {
  assert.match(CONSOLE_CODE, /subsystem\.evidence\.map/, "evidence rows are rendered directly");
  /* No filtering, counting or thresholding of evidence into a stronger claim. */
  assert.doesNotMatch(CONSOLE_CODE, /evidence\.filter\(/, "evidence must not be selectively hidden");
  assert.doesNotMatch(CONSOLE_CODE, /evidence\.length\s*>\s*[1-9]/, "evidence count must not drive a verdict");
  /* An empty evidence list is stated, not silently omitted. */
  assert.match(CONSOLE_CODE, /evidence\.length === 0/);
});

// --- UIADMIN-07 ------------------------------------------------------------------------------------

test("UIADMIN-07: a DIAGNOSTIC action can never be labelled as a cure", () => {
  for (const verb of FORBIDDEN_DIAGNOSTIC_VERBS) {
    assert.equal(labelOverclaims("DIAGNOSTIC", `${verb} connector`), true, `"${verb}" must be refused`);
    assert.equal(labelOverclaims("DIAGNOSTIC", `${verb}ed the thing`), true, "inflected forms too");
  }
  assert.equal(labelOverclaims("DIAGNOSTIC", "Re-check discovery connector"), false, "a truthful label passes");
  assert.equal(labelOverclaims("DIAGNOSTIC", "Check again"), false);

  /* The registered action, as the server actually describes it. */
  assert.equal(labelOverclaims("DIAGNOSTIC", "Re-check discovery connector"), false);
  assert.match(ACTION_KIND_PRESENTATION.DIAGNOSTIC.hint, /Changes nothing/);
  assert.notEqual(ACTION_KIND_PRESENTATION.DIAGNOSTIC.label, ACTION_KIND_PRESENTATION.REPAIR.label);
});

test("UIADMIN-07b: the console labels buttons from the server, and never invents a verb", () => {
  assert.match(CONSOLE_CODE, /\{pending \? "Checking…" : action\.title\}/, "the label is the server's title");
  /* No cure-verb appears as UI copy anywhere in the console. */
  for (const verb of ["Fix ", "Repair ", "Resolve ", "Recover ", "Restore "]) {
    assert.ok(!CONSOLE_CODE.includes(`>${verb}`), `"${verb.trim()}" must not be rendered as a label`);
  }
  assert.match(CONSOLE_CODE, /action\.kind/, "kind comes from the server, never inferred");
  assert.doesNotMatch(CONSOLE_CODE, /kind\s*=\s*["']REPAIR["']/, "the client must not assign a kind");
});

// --- UIADMIN-08 / 09 / 10 --------------------------------------------------------------------------

test("UIADMIN-08: actions execute only through the registered repair endpoint", () => {
  assert.match(CONSOLE_CODE, /\/api\/admin\/repairs\/\$\{action\.repairId\}/, "the one action endpoint");
  const posts = CONSOLE_CODE.match(/method:\s*"POST"/g) ?? [];
  assert.equal(posts.length, 1, "exactly one POST exists in the console");
  /* No other mutating endpoint, and no direct connector call. */
  for (const f of ["/api/scan", "/api/production-cycle", "checkConnectorHealth", "fetchJobsForCompany"]) {
    assert.ok(!CONSOLE_CODE.includes(f), `${f} must not be reachable from the console`);
  }
});

test("UIADMIN-09: an executed action is never announced as a fix", () => {
  /* The headline is chosen from actionStatus and kind, and the diagnostic branch says "completed",
   * not "fixed". The word must not exist as copy at all. */
  assert.match(CONSOLE_CODE, /"Diagnostic completed"/);
  /* Asserted on comment-stripped code: the doc comment above ActionResult legitimately discusses
   * this rule by name, and forbidding the word there would forbid explaining it. */
  assert.ok(!/\bFixed\b/.test(CONSOLE_CODE), '"Fixed" must not be rendered as copy');
  assert.ok(!/\bProblem fixed\b/i.test(CONSOLE_CODE));
  assert.ok(!/\bRepaired\b/.test(CONSOLE_CODE), '"Repaired" must not be rendered either');

  /* actionStatus and verificationStatus are rendered as separate facts. */
  assert.match(CONSOLE_CODE, /outcome\.actionStatus/);
  assert.match(CONSOLE_CODE, /outcome\.verificationDetail/);
  assert.match(CONSOLE_CODE, /Health before/);
  assert.match(CONSOLE_CODE, /Health after/);
  /* And the console says outright that running something does not make it healthy. */
  assert.match(CONSOLE_SRC, /never changes health by itself/i);
});

test("UIADMIN-10: evidence is refetched from the server after an action", () => {
  const runBlock = CONSOLE_CODE.slice(CONSOLE_CODE.indexOf("const runAction"), CONSOLE_CODE.indexOf("if (loading"));
  assert.match(runBlock, /loadOverview\(\)/, "the overview is re-read");
  assert.match(runBlock, /loadConnectors\(\)/, "and the provider evidence with it");
  assert.match(runBlock, /finally/, "the refetch happens even when the action failed");
  /* Health after the action is never taken from the action's own claim. */
  assert.doesNotMatch(runBlock, /setView\(/, "the action result must not write the health model");
});

test("UIADMIN-10b: a pending action cannot be double-submitted", () => {
  assert.match(CONSOLE_CODE, /if \(pendingAction !== null \|\| row\.actionableSourceId === null\) return/);
  assert.match(CONSOLE_CODE, /disabled=\{disabled\}/);
  assert.match(CONSOLE_CODE, /aria-disabled=\{disabled\}/, "disabled state is announced, not only styled");
});

// --- UIADMIN-11 / 12 -------------------------------------------------------------------------------

test("UIADMIN-11: production and probe evidence stay separately visible", () => {
  assert.match(CONSOLE_CODE, /evidence=\{row\.production\}/);
  assert.match(CONSOLE_CODE, /evidence=\{row\.probe\}/);
  assert.match(CONSOLE_CODE, /Production scans/);
  assert.match(CONSOLE_CODE, /Connector probe/);

  /* Neither may be merged, averaged, or chosen between. */
  assert.doesNotMatch(CONSOLE_CODE, /connectorScore|combinedStatus|mergeEvidence|worstOf/i);
  assert.doesNotMatch(CONSOLE_CODE, /production\.status === "HEALTHY" \?[^:]*probe/, "no picking one over the other");

  /* primaryEvidence only decides emphasis wording. */
  assert.equal(primaryEvidenceLabel("PRODUCTION_SCAN"), "Leading: real scans");
  assert.equal(primaryEvidenceLabel("PROBE"), "Leading: connector probe");
  assert.equal(primaryEvidenceLabel("NONE"), "No evidence yet");
});

test("UIADMIN-12: a configuration failure reads as configuration, not as a provider outage", () => {
  const config = REPAIRABILITY_PRESENTATION.CONFIGURATION_REQUIRED;
  assert.match(config.label, /Configuration required/i);
  assert.match(config.detail, /outside the app/i);
  assert.doesNotMatch(config.detail, /down|outage|failing/i, "configuration must not be described as a failure");

  const external = REPAIRABILITY_PRESENTATION.EXTERNAL_FAILURE;
  assert.notEqual(config.label, external.label, "the two causes must read differently");
  assert.match(external.detail, /outside this machine/i);

  /* No repairability copy may name an environment value. */
  for (const p of Object.values(REPAIRABILITY_PRESENTATION)) {
    assert.doesNotMatch(`${p.label} ${p.detail}`, /=|password|secret|token/i);
  }
});

// --- UIADMIN-13 / 14 / 15 --------------------------------------------------------------------------

test("UIADMIN-13: discovery capability and application automation are separate sections", () => {
  assert.match(CONSOLE_CODE, /Job discovery connectors/);
  assert.match(CONSOLE_CODE, /Application automation/);
  /* No badge merges the two concepts. */
  assert.doesNotMatch(CONSOLE_CODE, />\s*Supported\s*</, "a generic Supported badge would merge them");
  assert.match(CONSOLE_SRC, /different capability from applying/i, "the distinction is stated to the operator");
});

test("UIADMIN-14: a discovery-only provider is never shown as application-enabled", () => {
  /* The apply section renders only what the server listed as adapters; a connector row carries no
   * apply field at all, so Ashby-like providers cannot acquire one in the UI. */
  assert.match(CONSOLE_CODE, /view\.applicationAutomation\.adapters\.map/);
  const providerBlock = CONSOLE_CODE.slice(CONSOLE_CODE.indexOf("function ProviderRow"), CONSOLE_CODE.indexOf("function EvidenceBlock"));
  for (const forbidden of ["adapter", "automat", "apply", "Apply"]) {
    assert.ok(!providerBlock.includes(forbidden), `a connector row must not mention ${forbidden}`);
  }
  assert.match(CONSOLE_CODE, /discoveryOnlyPlatforms/, "the boundary is counted and explained");
  assert.match(CONSOLE_SRC, /capability boundary, not a fault/i);
});

test("UIADMIN-15: adapters with no execution evidence render as the server's NO_DATA", () => {
  assert.match(CONSOLE_CODE, /HEALTH_PRESENTATION\[adapter\.health\]/, "the adapter's status is the server's");
  /* The console must not upgrade an adapter to healthy because code exists. */
  assert.doesNotMatch(CONSOLE_CODE, /adapter[^\n]*"HEALTHY"/, "no client-side promotion");
  assert.doesNotMatch(CONSOLE_CODE, /runtimeAdapter\s*\?\s*"HEALTHY"/);
  assert.match(CONSOLE_CODE, /Runtime adapter present/, "capability is stated separately from health");
});

// --- UIADMIN-16 / 17 -------------------------------------------------------------------------------

test("UIADMIN-16: no composite score, percentage or grade exists", () => {
  for (const term of ["score", "percent", "grade", "rating", "overall", "readiness"]) {
    assert.ok(!new RegExp(term, "i").test(CONSOLE_CODE), `"${term}" must not appear in the console`);
  }
  assert.doesNotMatch(CONSOLE_SRC, /\d+%/, "no percentage is rendered");
  /* Counts come straight from the server and are not summed into a total. */
  assert.match(CONSOLE_CODE, /view\.summary\[key\]/);
  assert.doesNotMatch(CONSOLE_CODE, /reduce\(\(a, b\) =>/, "no aggregate arithmetic over statuses");
});

test("UIADMIN-17: no action history is implied", () => {
  for (const phrase of ["Recent repairs", "Action history", "Last fixed", "Operator activity", "Previously ran", "history"]) {
    assert.ok(!new RegExp(phrase, "i").test(CONSOLE_CODE), `"${phrase}" implies persistence that does not exist`);
  }
  /* The single outcome is component state, cleared on reload — never fetched or stored. */
  assert.match(CONSOLE_CODE, /const \[outcome, setOutcome\] = useState<ActionOutcome \| null>\(null\)/);
  assert.match(CONSOLE_SRC, /Nothing here is persisted/i, "the constraint is written down where it could be broken");
});

// --- UIADMIN-18 / 19 / 20 --------------------------------------------------------------------------

test("UIADMIN-18: provider detail is one request, fetched lazily", () => {
  const fetches = CONSOLE_CODE.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 3, "overview, connector detail, and the action — nothing per provider");
  assert.match(CONSOLE_CODE, /\/api\/admin\/discovery-connectors/);

  /* No fetch inside a provider render path. */
  const providerBlock = CONSOLE_CODE.slice(CONSOLE_CODE.indexOf("function ProviderRow"));
  assert.ok(!providerBlock.includes("fetch("), "a provider row must never issue its own request");

  /* And it is only requested once the section is opened. */
  assert.match(CONSOLE_CODE, /if \(!wasOpen && connectors === null && !connectorsLoading\) void loadConnectors\(\)/);
});

test("UIADMIN-19: loading, authorization, error and empty states are explicit and never green", () => {
  assert.match(CONSOLE_CODE, /aria-busy="true"/, "loading is announced");
  assert.match(CONSOLE_CODE, /role="status"/);
  assert.match(CONSOLE_CODE, /role="alert"/, "a load failure is announced assertively");

  /* An API failure must not render as a healthy or empty console. */
  const errorBlock = CONSOLE_SRC.slice(CONSOLE_SRC.indexOf("if (loadError !== null)"), CONSOLE_SRC.indexOf("if (view === null)"));
  assert.match(errorBlock, /not the same as/i, "the console says outright that unavailable is not healthy");
  assert.ok(!errorBlock.includes("HEALTHY"), "no health verdict is shown when evidence is unavailable");
  assert.match(errorBlock, /Try again/);

  /* Empty attention list is stated calmly, without celebration. */
  assert.match(CONSOLE_CODE, /No subsystem is reporting a warning or an error/);
  for (const gimmick of ["🎉", "All good!", "Perfect", "Excellent"]) {
    assert.ok(!CONSOLE_SRC.includes(gimmick), `${gimmick} is not an operational statement`);
  }
});

test("UIADMIN-20: accessibility semantics are correct", () => {
  /* Interactive things are buttons. */
  const buttonCount = (CONSOLE_CODE.match(/<button/g) ?? []).length;
  assert.ok(buttonCount >= 4, "actions, window switch, disclosure and retry are real buttons");
  assert.ok(!/<div[^>]*onClick/.test(CONSOLE_CODE), "no clickable div");

  /* The custom disclosure wires aria-expanded to the element it controls. */
  assert.match(CONSOLE_CODE, /aria-expanded=\{connectorsOpen\}/);
  assert.match(CONSOLE_CODE, /aria-controls="ops-connector-detail"/);
  assert.match(CONSOLE_CODE, /id="ops-connector-detail"/);

  /* Native disclosure for per-subsystem evidence — keyboard behaviour comes free. */
  assert.match(CONSOLE_CODE, /<details/);
  assert.match(CONSOLE_CODE, /<summary>/);

  /* The window control is a real toggle group, not tabs pretending to be one. */
  assert.match(CONSOLE_CODE, /role="group"/);
  assert.match(CONSOLE_CODE, /aria-pressed=\{window === w\}/);
  assert.doesNotMatch(CONSOLE_CODE, /role="tab"/, "tab semantics without tab keyboard handling would be a lie");

  /* Sections are labelled for navigation. */
  assert.ok((CONSOLE_CODE.match(/aria-labelledby=/g) ?? []).length >= 4);
  /* Every status symbol is decorative; the label beside it carries the meaning. */
  assert.ok((CONSOLE_CODE.match(/aria-hidden="true"/g) ?? []).length >= 3);
});

// --- Wiring ----------------------------------------------------------------------------------------

test("UIADMIN-21: the console holds no second health classifier", () => {
  /* The failure mode this forbids: a client map that decides what a status means. */
  assert.doesNotMatch(CONSOLE_CODE, /function (classify|deriveHealth|computeStatus)/);
  for (const foreign of ["DEGRADED", "OFFLINE", "ONLINE", "PARTIAL", '"GOOD"', '"BAD"']) {
    assert.ok(!CONSOLE_CODE.includes(foreign), `${foreign} is not part of the frozen vocabulary`);
  }
  /* Presentation is looked up, never branched into a new verdict. */
  assert.match(CONSOLE_CODE, /HEALTH_PRESENTATION\[/);
});

test("UIADMIN-22: the admin index renders the console and keeps the sub-console links", () => {
  assert.match(PAGE_SRC, /<OperationsConsole candidateId=\{candidateId\} \/>/);
  assert.doesNotMatch(PAGE_SRC, /function displayStatus/, "the legacy client vocabulary is gone");
  for (const href of ["/admin/operations", "/admin/scanner", "/admin/writer", "/admin/applications", "/admin/activity"]) {
    assert.ok(CONSOLE_CODE.includes(`href="${href}"`), `${href} must remain reachable`);
  }
});

test("UIADMIN-23: capability copy separates coverage from failure", () => {
  const notScanned = CAPABILITY_PRESENTATION.CONNECTOR_NOT_SCANNED;
  assert.match(notScanned.detail, /coverage boundary, not a fault/i, "connector-not-scanned is not an error");
  assert.doesNotMatch(notScanned.label, /error|fail|broken/i);
  assert.notEqual(notScanned.label, CAPABILITY_PRESENTATION.SCANNABLE.label);
  assert.notEqual(notScanned.label, CAPABILITY_PRESENTATION.NONE.label);
});

test("UIADMIN-24: no secret, path, SQL or raw diagnostic can be rendered", () => {
  for (const forbidden of ["process.env", "dbPath", "getDbPath", "SELECT ", "stack", "Authorization", "password"]) {
    assert.ok(!CONSOLE_CODE.includes(forbidden), `${forbidden} must not reach the console`);
  }
  /* Only the safe, bounded category is displayed for a failure. */
  assert.match(CONSOLE_CODE, /lastFailureCategory/);
  assert.ok(!CONSOLE_CODE.includes("errorMessage"), "raw vendor text must never be rendered");
});

test("UIADMIN-25: display ordering surfaces problems first without reclassifying anything", () => {
  const list = [sub("z", "HEALTHY"), sub("y", "DISABLED"), sub("x", "ERROR"), sub("w", "NO_DATA"), sub("v", "WARNING")];
  assert.deepEqual(orderForDisplay(list).map((s) => s.status), ["ERROR", "WARNING", "NO_DATA", "HEALTHY", "DISABLED"]);
  /* Ordering must not mutate the caller's array. */
  assert.equal(list[0].id, "z", "the input list is left alone");
});
