import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSuccessFactorsToken } from "@/lib/ats/successfactors";
import { SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS } from "@/lib/ats/successfactorsTrustedHosts";

/**
 * CAREEROPS — SUCCESSFACTORS PHASE 3: verifies the trust map's contents directly (the generic
 * trustedCustomHost mechanism itself — acceptance, rejection, no cross-tenant leakage, credential
 * rejection — is already covered end-to-end against real HTTP fixtures in successfactors.test.ts;
 * this file only proves the MAP entries are exactly what Phase 3's evidence supports).
 */

test("Phase 3: Popular, Inc.'s exact token resolves to its verified custom host", () => {
  const token = normalizeSuccessFactorsToken("career4.successfactors.com|Popularinc");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "jobs.popular.com");
});

test("Phase 3: Talis Clinical's exact token resolves to its verified (parent-organization) custom host", () => {
  const token = normalizeSuccessFactorsToken("career5.successfactors.eu|GetingeProd");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "careers.getinge.com");
});

test("Phase 3: Perdue AgriBusiness's exact token resolves to its verified (family-portal) custom host", () => {
  const token = normalizeSuccessFactorsToken("career4.successfactors.com|PerdueFarms");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[token], "jobs.perduecareers.com");
});

test("Phase 3: a different tenant's token does not inherit another tenant's trusted host", () => {
  // Same SuccessFactors host (career4.successfactors.com) as Popular/Perdue, but a different
  // company identifier that has no entry at all — the map is keyed per-tenant, not per-host, so a
  // sibling tenant on the same shared SAP host must not resolve to anyone else's trusted value.
  const unrelatedToken = normalizeSuccessFactorsToken("career4.successfactors.com|SomeOtherTenant");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[unrelatedToken], undefined);
});

test("Phase 3: Tellus Products is NOT trusted despite the strong evidence found investigating it", () => {
  // Deliberate: Phase 3 found genuine, strong evidence that Tellus Products is a real ASR Group
  // subsidiary (ASR Group's own site lists it as one of ten owned companies) — but that was scoped
  // as investigation-only, not verification-for-trust, in this task. This test is a regression guard
  // against a future edit accidentally (or over-eagerly) adding it without going through the same
  // explicit review the other entries received.
  const tellusToken = normalizeSuccessFactorsToken("career4.successfactors.com|634633P");
  assert.equal(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS[tellusToken], undefined);
});

test("Phase 3: the trust map has exactly the expected number of entries (9 from Phase 2 + 3 from Phase 3)", () => {
  assert.equal(Object.keys(SUCCESSFACTORS_TRUSTED_CUSTOM_HOSTS).length, 12);
});
