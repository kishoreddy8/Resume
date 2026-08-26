import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  FUTURE_REPAIR_ROUTE_GUARD,
  MUTATION_POLICIES,
  REQUIRED_GUARD_SYMBOL,
  type MutationPolicy,
} from "../mutationPolicy";

/* ================================================================================================
 * ADMIN-SEC-1 — route-guard completeness.
 *
 * The check this replaces skipped any route file whose source lacked the literal "candidateId",
 * which silently exempted every route that had no candidate in it — precisely the ones that were
 * unguarded. This walks the filesystem instead and fails on anything undeclared, so a new mutating
 * route cannot merge without someone writing down what protects it.
 * ============================================================================================== */

const API_ROOT = path.join(process.cwd(), "src", "app", "api");
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

interface DiscoveredRoute {
  route: string;
  methods: string[];
  source: string;
}

/** Every route.ts under src/app/api that exports at least one mutating handler. */
function discoverMutatingRoutes(): DiscoveredRoute[] {
  const found: DiscoveredRoute[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.name !== "route.ts") continue;
      const source = fs.readFileSync(p, "utf-8");
      const methods = MUTATING_METHODS.filter((m) =>
        new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`).test(source)
      );
      if (methods.length === 0) continue;
      found.push({
        route: path.relative(API_ROOT, path.dirname(p)).split(path.sep).join("/"),
        methods,
        source,
      });
    }
  };
  walk(API_ROOT);
  return found;
}

const discovered = discoverMutatingRoutes();
const byRoute = new Map<string, MutationPolicy>(MUTATION_POLICIES.map((p) => [p.route, p]));

test("ADMINSEC-CI-01: every mutating route is declared in the policy registry", () => {
  const undeclared = discovered.filter((r) => !byRoute.has(r.route)).map((r) => `${r.route} [${r.methods}]`);
  assert.deepEqual(
    undeclared,
    [],
    `Undeclared mutating routes. Add each to MUTATION_POLICIES with a guard and rationale:\n  ${undeclared.join("\n  ")}`
  );
});

test("ADMINSEC-CI-01b: the registry has no stale entries for routes that no longer exist", () => {
  const live = new Set(discovered.map((r) => r.route));
  const stale = MUTATION_POLICIES.filter((p) => !live.has(p.route)).map((p) => p.route);
  assert.deepEqual(stale, [], `Registry lists routes that no longer have mutating handlers: ${stale.join(", ")}`);
});

test("ADMINSEC-CI-01c: every declared method is actually exported, and every exported method declared", () => {
  for (const r of discovered) {
    const policy = byRoute.get(r.route);
    if (!policy) continue;
    assert.deepEqual(
      [...r.methods].sort(),
      [...policy.methods].sort(),
      `${r.route}: registry methods disagree with the exported handlers`
    );
  }
});

test("ADMINSEC-CI-01d: each route calls the guard its declared policy requires", () => {
  const violations: string[] = [];
  for (const r of discovered) {
    const policy = byRoute.get(r.route);
    if (!policy || policy.guard === "AUTHORIZATION_SURFACE") continue;
    const symbol = REQUIRED_GUARD_SYMBOL[policy.guard];
    if (!r.source.includes(symbol)) violations.push(`${r.route} (${policy.guard}) must call ${symbol}`);
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("ADMINSEC-CI-01e: the guard call is real code, not only a mention in a comment", () => {
  /* A rationale comment naming the guard would otherwise satisfy the source check above. */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const violations: string[] = [];
  for (const r of discovered) {
    const policy = byRoute.get(r.route);
    if (!policy || policy.guard === "AUTHORIZATION_SURFACE") continue;
    const symbol = REQUIRED_GUARD_SYMBOL[policy.guard];
    if (!new RegExp(`${symbol}\\s*\\(`).test(stripComments(r.source))) {
      violations.push(`${r.route}: ${symbol} appears but is never invoked`);
    }
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("ADMINSEC-CI-01f: every policy carries a rationale", () => {
  const missing = MUTATION_POLICIES.filter((p) => p.rationale.trim().length < 20).map((p) => p.route);
  assert.deepEqual(missing, [], `Policies needing a real rationale: ${missing.join(", ")}`);
});

test("ADMINSEC-ROUTE-01/02/03: the previously unguarded job routes now require an authenticated candidate", () => {
  /* Deliberately NOT the operator boundary. Two of the three are reached from the candidate product
   * (/jobs/archived restores; AiInsightsCard enriches), so requiring an unlocked owner would delete
   * the feature for every non-owner profile and for any install without a PIN. The hole being closed
   * is that they were callable with no authorization at all. */
  for (const route of ["jobs/[id]/archive", "jobs/[id]/restore", "jobs/[id]/ai-enrich"]) {
    const policy = byRoute.get(route);
    assert.ok(policy, `${route} must be declared`);
    assert.equal(policy!.guard, "CANDIDATE", `${route} is reached from the candidate product`);
    const found = discovered.find((r) => r.route === route);
    assert.ok(found!.source.includes("requireCandidateAccess"), `${route} must call requireCandidateAccess`);
    assert.ok(found!.source.includes("candidateId"), `${route} must take an explicit candidateId`);
  }
});

test("ADMINSEC-ROUTE-02b: archive and restore share one boundary — no inverse-operation asymmetry", () => {
  assert.equal(byRoute.get("jobs/[id]/archive")!.guard, byRoute.get("jobs/[id]/restore")!.guard);
});

test("ADMINSEC-CANDIDATE-01: profile creation uses the bootstrap-aware guard, not a blanket owner lock", () => {
  const policy = byRoute.get("candidates")!;
  assert.equal(policy.guard, "PROFILE_CREATION");
  const source = discovered.find((r) => r.route === "candidates")!.source;
  assert.ok(source.includes("requireProfileCreationAuthorization"));
  assert.ok(
    !source.includes("requireAdminOwner"),
    "an Admin-only lock would deadlock first-run onboarding, where no owner exists yet"
  );
});

test("ADMINSEC-SUBMIT-01: no operator-guarded route is a path to submission", () => {
  /* The submit path is candidate-scoped AND run-approval-gated. If an OPERATOR route ever imported
   * the executor's submit entry point, an operator session would become a submission path. */
  const operatorRoutes = discovered.filter((r) => byRoute.get(r.route)?.guard === "OPERATOR");
  assert.ok(operatorRoutes.length > 0, "fixture sanity");
  for (const r of operatorRoutes) {
    assert.doesNotMatch(r.source, /approveAndSubmit|submitApproval/, `${r.route} must not reach the submit path`);
    assert.doesNotMatch(r.source, /from ["']@\/lib\/apply\/engine\/executor["']/, `${r.route} must not import the executor`);
  }
});

test("ADMINSEC-SUBMIT-01b: the submit path itself remains candidate-scoped, not operator-scoped", () => {
  const start = byRoute.get("candidates/[candidateId]/application-runs/start")!;
  assert.equal(start.guard, "CANDIDATE");
  assert.equal(start.consequence, "CRITICAL");
});

test("ADMINSEC-ANSWER-01: no operator-guarded route can write candidate answers or identity", () => {
  const operatorRoutes = discovered.filter((r) => byRoute.get(r.route)?.guard === "OPERATOR");
  for (const r of operatorRoutes) {
    assert.doesNotMatch(r.source, /saveAnswer|editAnswer|applicationVault/, `${r.route} must not write Answer Memory`);
    assert.doesNotMatch(r.source, /requires_sponsorship|work_authorized_us/, `${r.route} must not alter work authorization`);
  }
});

test("ADMINSEC-ADMIN-01: future repair routes inherit the operator boundary", () => {
  assert.equal(FUTURE_REPAIR_ROUTE_GUARD, "OPERATOR");
  assert.equal(REQUIRED_GUARD_SYMBOL[FUTURE_REPAIR_ROUTE_GUARD], "requireAdminOwner");
});

test("ADMINSEC-CI-01g: the discovery walk actually finds routes — the test cannot pass vacuously", () => {
  /* The predecessor's weakness was silent skipping. If discovery ever returns nothing, every
   * assertion above becomes trivially true, so assert the corpus is non-trivial. */
  assert.ok(discovered.length >= 40, `expected the full API surface, found ${discovered.length}`);
  assert.ok(
    discovered.some((r) => !r.source.includes("candidateId")),
    "at least one mutating route has no candidateId — exactly the case the old check skipped"
  );
});
